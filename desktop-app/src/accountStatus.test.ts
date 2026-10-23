import test from "node:test";
import assert from "node:assert/strict";
import { accountStatus } from "./accountStatus.ts";
test("account participation follows campaign phase, including inbox reloads", () => {
  assert.equal(accountStatus().label, "Ожидает подготовки");
  assert.equal(accountStatus({ status: "ready" }).label, "Ожидает подготовки");
  for (const phase of ["running", "monitoring"]) {
    for (const status of ["ready", "unready", "checking"]) assert.equal(accountStatus({ status, campaignPhase: phase }).label, "Участвует в рассылке");
  }
  for (const status of ["closed", "error"]) assert.equal(accountStatus({ status, campaignPhase: "running" }).label, "Ожидает подготовки");
  for (const phase of ["halted", "complete"]) assert.equal(accountStatus({ status: "ready", campaignPhase: phase }).label, "Ожидает подготовки");
});
