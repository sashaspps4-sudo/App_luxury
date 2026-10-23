import test from "node:test";
import assert from "node:assert/strict";
import { restoreLicenseSession, validateLicenseSession } from "./licenseApi.ts";

test("restoring/validating refreshes the session and reads renewed subscription; outages retain tokens", async () => {
  let token: string | null = "test-token";
  Object.assign(globalThis, { window: {}, sessionStorage: { getItem: () => token, removeItem: () => { token = null; } } });
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push(url);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
      return new Response(JSON.stringify(url.endsWith("/refresh") ? { expires_at: "2026-10-29T00:00:00Z" } : { telegram_id: "1", subscription: { plan: "month", starts_at: "2026-10-21T00:00:00Z", expires_at: "2026-11-21T00:00:00Z" } }));
    };
    assert.equal((await validateLicenseSession("test-token")).expiresAt, "2026-11-21T00:00:00Z");
    assert.ok(calls[0].endsWith("/auth/refresh"));
    assert.ok(calls[1].endsWith("/me"));
    globalThis.fetch = async () => { throw Error("offline"); };
    await assert.rejects(restoreLicenseSession()); assert.equal(token, "test-token");
    globalThis.fetch = async () => new Response("{}", { status: 503 });
    await assert.rejects(restoreLicenseSession()); assert.equal(token, "test-token");
    globalThis.fetch = async () => new Response("{}", { status: 403 });
    assert.equal(await restoreLicenseSession(), null); assert.equal(token, null);
  } finally { globalThis.fetch = original; }
});
