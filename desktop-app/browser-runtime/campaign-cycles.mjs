import { randomUUID } from 'node:crypto';
import { normalizeAutomation } from './automation.mjs';
import { runCampaign } from './sender.mjs';

export function cycleQuotas(profiles, automation) {
  const size = automation.checkEverySent || 10;
  return Object.fromEntries(profiles.filter(p => !p.failed && !p.isStopped()).flatMap(p => {
    const remaining = automation.maxPerProfile ? automation.maxPerProfile - p.state.sent - p.state.uncertain : size;
    return remaining > 0 ? [[p.id, Math.min(size, remaining)]] : [];
  }));
}

// One coordinator owns parser requests. Profiles operate their own Gmail context
// concurrently; a new batch is requested only after every cycle check completes.
export async function runCampaignCycles(run, request, profiles, {
  fetchImpl = fetch, sendCycle = runCampaign, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, isStopped = () => false, signal,
} = {}) {
  const automation = normalizeAutomation(request.automation);
  const capturedRun = { ...run, automation };
  profiles.forEach(p => { p.state = { sent: 0, uncertain: 0 }; });
  let batch = request.parserBatch;
  let lastRequest = now();
  let round = 0;
  const pause = async milliseconds => {
    const deadline = now() + milliseconds;
    while (now() < deadline) {
      if (isStopped()) throw new Error('automation_stopped');
      await sleep(Math.min(250, deadline - now()));
    }
    if (isStopped()) throw new Error('automation_stopped');
  };
  const finishProfile = async p => {
    try {
      if (!p.failed && !p.isStopped()) {
        p.emit('info', `${automation.maxPerProfile && p.state.sent + p.state.uncertain >= automation.maxPerProfile ? 'Достигнут лимит профиля.' : 'Новые объявления закончились.'} Рассылка завершена: подтверждено ${p.state.sent}; неподтверждено ${p.state.uncertain}.`, { sent: p.state.sent });
        await p.state.scheduler?.finish();
      }
    } catch (error) {
      if (!p.isStopped()) { p.failed = true; p.emit('error', error.message); }
    } finally {
      try { await p.finish(p.state.sent, p.failed, p.isStopped()); }
      catch { p.emit('error', 'Не удалось закрыть браузер профиля.'); }
    }
  };
  const retired = [];
  try {
    const mailboxes = profiles.filter(p => !p.failed && !p.isStopped()).map(p => String(request.mailboxes?.[p.id] ?? '').trim().toLowerCase());
    if (mailboxes.some(mailbox => !mailbox) || new Set(mailboxes).size !== mailboxes.length) throw new Error('Профилям нужны разные подтверждённые почтовые аккаунты.');
    while (!isStopped()) {
      let quotas = cycleQuotas(profiles, automation);
      if (!Object.keys(quotas).length) break;
      if (round > 0) {
        await pause(Math.max(0, 5100 - (now() - lastRequest)));
        // A profile can close while waiting for the shared parser cooldown.
        quotas = cycleQuotas(profiles, automation);
        if (!Object.keys(quotas).length) break;
        const payload = { ...request.parserRequest, run_id: `cycle-${randomUUID()}`, parent_run_id: run.runId,
          profile_ids: Object.keys(quotas).sort((a, b) => {
            const total = id => { const p = profiles.find(p => p.id === id); return p.state.sent + p.state.uncertain; };
            return total(a) - total(b);
          }), profile_limits: quotas };
        const limit = Object.values(quotas).reduce((a, b) => a + b, 0);
        profiles.filter(p => quotas[p.id]).forEach(p => p.emit('info', `Цикл ${round + 1}: общий запрос к парсеру — ${limit} объявлений на ${Object.keys(quotas).length} профилей.`, { sent: p.state.sent }));
        lastRequest = now();
        const response = await fetchImpl('https://api.luxmail.lol/v1/parser/batch', {
          method: 'POST', headers: { Authorization: `Bearer ${request.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(75000)]) : AbortSignal.timeout(75000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Парсер отклонил запрос цикла.');
        if (data.run_id !== payload.run_id || data.parent_run_id !== run.runId || !Array.isArray(data.batches)) throw new Error('Парсер вернул другую партию.');
        batch = data;
        profiles.filter(p => quotas[p.id]).forEach(p => p.emit('info', `Ответ парсера: новых адресатов ${data.received}; повторов пустого результата ${data.empty_retries ?? 0}.`, { sent: p.state.sent }));
      }
      if (!batch || !Array.isArray(batch.batches)) throw new Error('Нет подтверждённой партии объявлений.');
      await Promise.all(profiles.filter(p => quotas[p.id]).map(async p => {
        try {
          const assigned = batch.batches.find(b => b.profile_id === p.id)?.ads.length ?? 0;
          p.emit('info', `Цикл ${round + 1}: назначено ${assigned} из ${quotas[p.id]} объявлений.`, { sent: p.state.sent });
          const outcome = await sendCycle(p.context, capturedRun, { ...p.hooks, profileId: p.id,
            token: request.token, html: request.html, mailbox: request.mailboxes[p.id],
            campaignState: p.state, batchRunId: batch.run_id, cycleOnly: true, isStopped: p.isStopped, emit: p.emit });
          p.failed = outcome.halted;
        } catch (error) { p.failed = true; p.emit('error', error.message); }
      }));
      if (!batch.received) {
        profiles.filter(p => quotas[p.id]).forEach(p => p.emit('info', 'Парсер не вернул новых адресатов после трёх повторов. Рассылка завершена.', { sent: p.state.sent }));
        break;
      }
      round++;
      for (const p of profiles) {
        if (!p.retired && (p.failed || p.isStopped() || (automation.maxPerProfile && p.state.sent + p.state.uncertain >= automation.maxPerProfile))) {
          p.retired = true;
          // Monitoring can run concurrently with remaining profiles' cycles.
          retired.push(finishProfile(p));
        }
      }
    }
  } catch (error) {
    profiles.filter(p => !p.retired && !p.isStopped()).forEach(p => { p.failed = true; p.emit('error', `Циклы остановлены: ${error.message}`); });
  } finally {
    await Promise.all([...retired, ...profiles.filter(p => !p.retired).map(finishProfile)]);
  }
}
