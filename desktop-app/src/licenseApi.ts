import { invoke, isTauri } from "@tauri-apps/api/core";

const API_BASE_URL = "https://api.luxmail.lol";
const SESSION_STORAGE_KEY = "luxury-session-token";

type ActivationResponse = {
  session_token: string;
  expires_at: string;
  plan: SubscriptionPlan;
};

type ProfileResponse = {
  telegram_id: string;
  telegram_username?: string | null;
  subscription: {
    plan: SubscriptionPlan;
    starts_at: string;
    expires_at: string;
  };
};

export type SubscriptionPlan = "day" | "week" | "month";

export type LicenseAccount = {
  token: string;
  telegramId: string;
  telegramUsername: string | null;
  plan: SubscriptionPlan;
  startsAt: string;
  expiresAt: string;
};

export class LicenseApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LicenseApiError";
  }
}

async function request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000), headers, cache: "no-store" });
  } catch (error) {
    const service = path.startsWith("/v1/parser/") ? "серверу парсинга" : "серверу API";
    const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new LicenseApiError(timedOut
      ? `Сервер не ответил вовремя (${path}). Повторите запрос позже.`
      : `Не удалось подключиться к ${service} (${path}).`);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { detail?: string | Array<unknown> };
      detail = typeof body.detail === "string" ? body.detail : "";
    } catch {
      // The API may return an empty error response.
    }
    if (response.status === 401) throw new LicenseApiError("Ключ не найден или срок его действия истёк.", response.status);
    if (response.status === 403) throw new LicenseApiError("Срок действия подписки закончился.", response.status);
    if (response.status === 429) throw new LicenseApiError(detail || "Слишком много попыток. Попробуйте позже.", response.status);
    if (response.status === 422) throw new LicenseApiError("Проверьте формат лицензионного ключа.", response.status);
    throw new LicenseApiError(detail || "Не удалось проверить лицензию. Попробуйте ещё раз.", response.status);
  }

  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function readToken(): Promise<string | null> {
  if (isTauri()) return await invoke<string | null>("load_license_session");
  return sessionStorage.getItem(SESSION_STORAGE_KEY);
}

async function writeToken(token: string): Promise<void> {
  if (isTauri()) {
    await invoke("save_license_session", { token });
    return;
  }
  sessionStorage.setItem(SESSION_STORAGE_KEY, token);
}

async function deleteToken(): Promise<void> {
  if (isTauri()) {
    await invoke("clear_license_session");
    return;
  }
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

async function loadProfile(token: string): Promise<LicenseAccount> {
  const profile = await request<ProfileResponse>("/v1/me", token);
  return {
    token,
    telegramId: profile.telegram_id,
    telegramUsername: profile.telegram_username || null,
    plan: profile.subscription.plan,
    startsAt: profile.subscription.starts_at,
    expiresAt: profile.subscription.expires_at,
  };
}

export async function activateLicense(licenseKey: string): Promise<LicenseAccount> {
  const result = await request<ActivationResponse>("/v1/auth/activate", undefined, {
    method: "POST",
    body: JSON.stringify({ license_key: licenseKey.trim(), device_name: "Luxury Desktop" }),
  });

  try {
    await writeToken(result.session_token);
    return await loadProfile(result.session_token);
  } catch (error) {
    await request<void>("/v1/auth/logout", result.session_token, { method: "POST" }).catch(() => undefined);
    await deleteToken().catch(() => undefined);
    throw error;
  }
}

export async function restoreLicenseSession(): Promise<LicenseAccount | null> {
  const token = await readToken();
  if (!token) return null;

  try {
    return await validateLicenseSession(token);
  } catch (error) {
    if (error instanceof LicenseApiError && (error.status === 401 || error.status === 403)) {
      await deleteToken().catch(() => undefined);
      return null;
    }
    throw error;
  }
}

export async function validateLicenseSession(token: string): Promise<LicenseAccount> {
  await request<{ expires_at: string }>("/v1/auth/refresh", token, { method: "POST" });
  return loadProfile(token);
}

export async function stopLicensedScenarios(): Promise<void> {
  if (isTauri()) await invoke("end_browser_session");
}

export type ParserBatch = {
  run_id: string;
  platform: string;
  requested: number;
  received: number;
  returned?: number;
  shortfall: number;
  batches: Array<{ profile_id: string; ads: Array<Record<string, unknown> & { email: string }> }>;
};

export type InboxSnapshot = {
  profile_id: string;
  mailbox_email: string;
  entries: Array<{ thread_id: string; message_id: string; sender_emails: string[] }>;
  ignored_count: number;
  pages: number;
  scanned_at: string;
  moved_to_inbox: boolean;
};

export type InboxReceipt = {
  complete: boolean;
  profile_id: string;
  count: number;
  seen_before: number;
  added: number;
  ignored: number;
  pages: number;
  matched: number;
  unmatched: number;
  needs_review: number;
  already_processed: number;
};

export async function saveInboxBaseline(runId: string, snapshot: InboxSnapshot): Promise<InboxReceipt> {
  const token = await readToken();
  if (!token) throw new LicenseApiError("Войдите в приложение для синхронизации входящих.");
  const { moved_to_inbox: _moved, entries, ...metadata } = snapshot;
  const encoder = new TextEncoder();
  const manifest = encoder.encode(JSON.stringify({ run_id: runId, ...metadata, entries }));
  const digest = await crypto.subtle.digest("SHA-256", manifest);
  const uploadId = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  // Keep each request below the API proxy's 16 KB body limit.
  const chunks: InboxSnapshot["entries"][] = [];
  let chunk: InboxSnapshot["entries"] = [];
  for (const entry of entries) {
    if (encoder.encode(JSON.stringify(entry)).length > 8_000) throw new Error("Метаданные одной цепочки Gmail превышают допустимый размер.");
    if (chunk.length && (chunk.length >= 40 || encoder.encode(JSON.stringify([...chunk, entry])).length > 10_000)) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(entry);
  }
  chunks.push(chunk);
  for (let index = 0; index < chunks.length; index++) {
    const receipt = await request<InboxReceipt>("/v1/inbox/baseline", token, {
      method: "POST",
      body: JSON.stringify({ run_id: runId, ...metadata, upload_id: uploadId,
        part_index: index, total_parts: chunks.length, expected_count: entries.length, entries: chunks[index] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (receipt.complete) return receipt;
  }
  throw new Error("Сервер не подтвердил сохранение полного отпечатка входящих.");
}

export type ParserRequestInfo = {
  platform: string;
  limit: number;
  params: Record<string, string | number>;
};

export async function fetchParserBatch(payload: Record<string, unknown>, onRequest?: (info: ParserRequestInfo) => void): Promise<ParserBatch> {
  const token = await readToken();
  if (!token) throw new LicenseApiError("Войдите в приложение, чтобы запустить парсер.");
  if (onRequest) {
    const info = await request<ParserRequestInfo>("/v1/parser/params", token, {
      method: "POST",
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    onRequest(info);
  }
  return await request<ParserBatch>("/v1/parser/batch", token, {
    method: "POST",
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(75_000),
  });
}

export async function clearLicenseSession(token?: string): Promise<void> {
  if (token) await request<void>("/v1/auth/logout", token, { method: "POST" }).catch(() => undefined);
  await deleteToken();
}

export async function fetchTelegramAvatar(token: string): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/v1/me/avatar`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) return null;
    return URL.createObjectURL(await response.blob());
  } catch {
    return null;
  }
}

export type ServerProfileStats = { profiles: Array<{ id: string; mailbox_email: string | null; sent: number; received: number; auto_sent: number }>; total_sent: number; total_received: number; total_auto_sent: number };

export async function syncDesktopProfiles(profiles: Array<{ id: string; legacyId?: string }>, deletedIds: string[] = []): Promise<ServerProfileStats> {
  const token = await readToken();
  if (!token) throw new LicenseApiError("Войдите в приложение для синхронизации профилей.");
  // Proxies and browser credentials never leave the desktop.
  let result: ServerProfileStats | undefined;
  for (let offset = 0; offset < Math.max(deletedIds.length, 1); offset += 100) {
    result = await request<ServerProfileStats>("/v1/profiles/sync", token, {
      method: "POST",
      body: JSON.stringify({ profiles: profiles.map(profile => ({ id: profile.id, legacy_id: profile.legacyId ?? null })), deleted_ids: deletedIds.slice(offset, offset + 100) }),
      signal: AbortSignal.timeout(15_000),
    });
  }
  return result!;
}
