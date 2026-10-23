// When the per-minute publishing job last ran, for the admin overview. In memory: the scheduler
// runs inside the one app process (ecosystem.config.cjs instances: 1), so the admin route reads
// the same object the cron job writes. Reset on every restart — `startedAt` says when that was.
export const schedulerHeartbeat = {
  startedAt: null,
  lastTickAt: null,
  lastError: null,
};

export function markSchedulerStarted() {
  schedulerHeartbeat.startedAt = new Date();
}

export function markSchedulerTick(err = null) {
  schedulerHeartbeat.lastTickAt = new Date();
  schedulerHeartbeat.lastError = err ? String(err.message || err).slice(0, 500) : null;
}
