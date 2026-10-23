import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const runner = fileURLToPath(new URL('../../examples/local_rendering/generate_link.py', import.meta.url));
export async function generateReservedLink(config, ad, { api, kind, jobId, profileId, mailbox, generate = generateLink }) {
  const keys = ['provider', 'apiKey', 'eqlApiKey', 'kartataiApiKey', 'userId', 'kartataiUserId', 'endpoint', 'kartataiEndpoint', 'serviceCode', 'mode', 'selectedGeos', 'buyerName', 'buyerAddress', 'requestBody', 'responsePath'];
  const provider = Object.fromEntries(keys.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  // Subjects/HTML edits do not create a second provider listing. Credentials
  // are hashed with the request inputs and never stored in the link table.
  const fingerprint = createHash('sha256').update(JSON.stringify(stable({ provider, ad }))).digest('hex');
  const payload = { kind, job_id: jobId, profile_id: profileId, mailbox_email: mailbox, fingerprint };
  const reservation = await api('/v1/provider-links', payload);
  if (reservation.status === 'ready') return reservation.link;
  if (reservation.status !== 'reserved' || !reservation.claim_token) throw new Error('Создание ссылки не зарезервировано.');
  // Never retry the provider, including on timeout: its outcome may be unknown.
  const link = await generate(config, ad);
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const receipt = await api('/v1/provider-links', { ...payload, claim_token: reservation.claim_token, link });
      if (receipt.status !== 'ready' || receipt.link !== link) throw new Error('Сервер не подтвердил сохранение ссылки.');
      return receipt.link;
    } catch (failure) { error = failure; }
  }
  throw error;
}

export function linkInvocation(platform = process.platform, env = process.env) {
  if (env.LUXURY_LINK_EXECUTABLE) return { executable: env.LUXURY_LINK_EXECUTABLE, args: [] };
  return { executable: env.LUXURY_PYTHON || (platform === 'darwin' ? 'python3' : 'python'), args: [runner] };
}

export function generateLink(config, ad) {
  return new Promise((resolve, reject) => {
    const invocation = linkInvocation();
    const child = execFile(invocation.executable, invocation.args, { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error('Не удалось вызвать generate_link(settings, ad) выбранного Python-провайдера.'));
      try {
        const { link } = JSON.parse(stdout);
        const url = new URL(link);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        resolve(url.href);
      } catch { reject(new Error('Провайдер должен вернуть непустую HTTP(S)-ссылку.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ settings: config, ad }));
  });
}
