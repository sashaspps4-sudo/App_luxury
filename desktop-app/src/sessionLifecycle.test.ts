import test from "node:test";
import assert from "node:assert/strict";
import { startLicenseMonitor } from "./sessionLifecycle.ts";

const account = { token: "token", telegramId: "1", telegramUsername: null, plan: "day" as const, startsAt: "2026-10-21T00:00:00Z", expiresAt: "2026-10-22T00:00:00Z" };
function fixture() {
  const calls: string[] = [];
  let id = 0;
  const timers = new Map<number, number>();
  const clock = { now: () => Date.parse(account.expiresAt), setTimeout: (_fn: () => void, delay: number) => { timers.set(++id, delay); return id; }, clearTimeout: (key: number | undefined) => { if (key) timers.delete(key); }, setInterval: () => ++id, clearInterval() {} };
  const hooks = { validate: async () => ({ ...account, expiresAt: "2026-10-23T00:00:00Z" }), denied: (error: unknown) => error === "expired" || error === "revoked", stop: async () => { calls.push("stop"); }, clear: async () => { calls.push("clear"); }, updated: () => { calls.push("updated"); }, ended: () => { calls.push("ended"); }, unavailable: (message: string) => { if (message) calls.push("unavailable"); }, busy() {} };
  return { calls, clock, hooks, timers };
}

test("renewal overrides an expired local date and reschedules from the current subscription", async () => {
  const f = fixture(); const monitor = startLicenseMonitor(account, f.hooks, f.clock);
  await monitor.check();
  assert.deepEqual(f.calls, ["updated"]);
  assert.deepEqual([...f.timers.values()], [86400000]);
  monitor.dispose(); assert.equal(f.timers.size, 0);
});
test("temporary backend outage preserves session and retries successfully", async () => {
  const f = fixture(); f.hooks.validate = async () => { throw new Error("offline"); };
  const monitor = startLicenseMonitor(account, f.hooks, f.clock);
  await monitor.check(); assert.deepEqual(f.calls, ["unavailable"]);
  f.hooks.validate = async () => account;
  await monitor.check(); assert.deepEqual(f.calls, ["unavailable", "updated"]);
  monitor.dispose();
});
test("subscription expiry and session revocation stop workers before clearing and exiting", async () => {
  for (const reason of ["expired", "revoked"]) {
    const f = fixture(); f.hooks.validate = async () => { throw reason; };
    const monitor = startLicenseMonitor(account, f.hooks, f.clock);
    await monitor.check(); await monitor.check();
    assert.deepEqual(f.calls, ["stop", "clear", "ended"]);
    monitor.dispose();
  }
});
test("failed shutdown is retried before any session is removed", async () => {
  const f = fixture(); f.hooks.validate = async () => { throw "expired"; }; f.hooks.stop = async () => { f.calls.push("failed-stop"); throw Error(); };
  const monitor = startLicenseMonitor(account, f.hooks, f.clock);
  await monitor.check(); assert.deepEqual(f.calls, ["failed-stop", "unavailable"]);
  f.hooks.stop = async () => { f.calls.push("stop"); };
  await monitor.check(); assert.deepEqual(f.calls.slice(-3), ["stop", "clear", "ended"]);
  monitor.dispose();
});
test("disposed checks cannot overwrite a new login or clear its token", async () => {
  const f = fixture(); let reject!: (error: unknown) => void;
  f.hooks.validate = () => new Promise((_resolve, fail) => { reject = fail; });
  const monitor = startLicenseMonitor(account, f.hooks, f.clock);
  const pending = monitor.check(); monitor.dispose(); reject("expired"); await pending;
  assert.deepEqual(f.calls, []);
});
