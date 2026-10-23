import test from "node:test";
import assert from "node:assert/strict";
import { sessionState, sessionElapsed } from "./sessionState.ts";

test("session reports browser preparation and actual campaign phases", () => {
  const run = { runId: "run", startedAtMs: 1000 };
  assert.equal(sessionState(null, []), "Ожидает запуска");
  assert.equal(sessionState(run, [{ status: "starting" }]), "Открываем браузеры");
  assert.equal(sessionState(run, [{ status: "open" }]), "Ожидаем входа в Gmail");
  assert.equal(sessionState(run, [{ status: "checking" }]), "Проверяем аккаунты");
  assert.equal(sessionState(run, [{ status: "ready" }]), "Аккаунты готовы");
  assert.equal(sessionState(run, [{ status: "ready" }], "Получаем объявления"), "Получаем объявления");
  assert.equal(sessionState(run, [{ status: "unready", campaignPhase: "running" }, { status: "error" }]), "Рассылка выполняется");
  assert.equal(sessionState(run, [{ status: "ready", campaignPhase: "monitoring" }, { status: "closed" }]), "Мониторинг входящих");
  assert.equal(sessionState({ ...run, stopRequested: true }, [{ status: "ready" }]), "Останавливаем сессию");
});

test("finished sessions retain their result and runtime across screen remounts", () => {
  const run = { runId: "run", startedAtMs: 1000, endedAtMs: 3662000, campaignStarted: true };
  assert.equal(sessionState(run, [{ status: "closed", campaignPhase: "complete" }]), "Рассылка завершена");
  assert.equal(sessionState(run, [{ status: "closed", campaignPhase: "halted" }]), "Завершена с ошибками");
  assert.equal(sessionState({ ...run, stopRequested: true }, [{ status: "closed" }]), "Сессия остановлена");
  assert.equal(sessionElapsed(run, 9999999), "01:01:01");
  assert.equal(sessionElapsed({ ...run }, 99999999), "01:01:01");
  assert.equal(sessionElapsed({ runId: "new", startedAtMs: 10000 }, 12000), "00:00:02");
  assert.equal(sessionElapsed({ runId: "new", startedAtMs: 20000 }, 10000), "00:00:00");
  assert.equal(sessionElapsed({ runId: "long", startedAtMs: 0 }, 90061000), "25:01:01");
  assert.equal(sessionElapsed(null), "00:00:00");
});
