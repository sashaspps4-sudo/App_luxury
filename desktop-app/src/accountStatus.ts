export function accountStatus(worker?: { status: string; campaignPhase?: string }) {
  const active = !!worker && !["closed", "error"].includes(worker.status) && ["running", "monitoring"].includes(worker.campaignPhase ?? "");
  return { label: active ? "Участвует в рассылке" : "Ожидает подготовки", className: active ? "ready" : "waiting" };
}
