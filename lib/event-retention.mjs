/** Every event Skill expires after ten days. Important projections live in MCP. */
export const RETENTION_MS = 10 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function timestamp(value) {
  const result = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw Object.assign(new Error('Invalid retention timestamp.'), { code: 'INVALID_ARGUMENT' });
  return result;
}
export function isExpiredEvent(event, now = Date.now()) {
  if (typeof event === 'object' && event !== null) {
    if (event.status === 'forgotten') return true;
  }
  const time = typeof event === 'object' && event !== null ? event.time ?? event.at : event;
  // Legacy retained/superseded metadata remains readable for migration but can
  // never extend the lifetime of a Skill in the unified memory architecture.
  return timestamp(now) - timestamp(time) >= RETENTION_MS;
}
export function validEventMaintenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !['version', 'retained', 'duplicateOf', 'duplicateIds', 'supersededAt'].includes(key))
    || value.version !== 1 || typeof value.retained !== 'boolean') return false;
  const eventId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
  if (value.duplicateOf !== undefined && !eventId(value.duplicateOf)) return false;
  if (value.duplicateIds !== undefined && (!Array.isArray(value.duplicateIds) || value.duplicateIds.length > 100000
    || value.duplicateIds.some(id => !eventId(id)) || new Set(value.duplicateIds).size !== value.duplicateIds.length)) return false;
  if (value.duplicateOf && value.duplicateIds?.length) return false;
  if (value.supersededAt !== undefined && (typeof value.supersededAt !== 'string' || !Number.isFinite(Date.parse(value.supersededAt))
    || new Date(value.supersededAt).toISOString() !== value.supersededAt)) return false;
  return true;
}
/** Asia/Shanghai has UTC+08:00 throughout the supported present-day schedule. */
export function nextShanghaiMidnight(now = Date.now()) {
  const current = timestamp(now);
  return (Math.floor((current + SHANGHAI_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - SHANGHAI_OFFSET_MS;
}

/**
 * Ordering is deliberate: block reads durably, forget downstream references,
 * then remove the body. A failed callback or unlink is retried after restart.
 * This service never reads or deletes DSH's original session logs.
 */
export function createEventRetention({ store, onForget, onChange, onError, beforeExpire, now = Date.now,
  autoStart = true, retryMs = 60000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!store || typeof store.expireEvents !== 'function' || typeof store.cleanupForgottenEvent !== 'function'
    || typeof onForget !== 'function' || (beforeExpire !== undefined && typeof beforeExpire !== 'function')
    || typeof now !== 'function' || !Number.isSafeInteger(retryMs) || retryMs < 1) {
    throw Object.assign(new Error('Invalid event retention configuration.'), { code: 'INVALID_ARGUMENT' });
  }
  let disposed = false, running = null, timer = null;
  let state = { retentionDays: 10, timezone: 'Asia/Shanghai', schedule: '00:00', lastRunAt: null,
    nextRunAt: null, forgotten: 0, deleted: 0, pending: 0, expiredJobs: 0, errors: 0, lastErrorCode: null };
  const report = error => {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'RETENTION_FAILED';
    state.errors++; state.lastErrorCode = code;
    if (onError) try { Promise.resolve(onError(Object.assign(new Error('Event retention failed.'), { code }))).catch(() => {}); } catch {}
  };
  const changed = result => { if (onChange) try { Promise.resolve(onChange(result)).catch(report); } catch (error) { report(error); } };
  function schedule(retry) {
    if (disposed) return;
    if (timer) clearTimer(timer);
    const current = timestamp(now());
    const next = retry ? Math.min(current + retryMs, nextShanghaiMidnight(current)) : nextShanghaiMidnight(current);
    state.nextRunAt = new Date(next).toISOString();
    timer = setTimer(() => { timer = null; void run(); }, Math.max(1, next - current)); timer?.unref?.();
  }
  function run() {
    if (disposed) return Promise.resolve({ ...state, disposed: true });
    if (running) return running;
    if (timer) { clearTimer(timer); timer = null; }
    running = Promise.resolve().then(async () => {
      const current = timestamp(now());
      state.lastRunAt = new Date(current).toISOString();
      let failed = false;
      try {
        // State promotion/replacement must commit before expiration. If its
        // write fails, retry the whole pass without forgetting an important event.
        if (beforeExpire) await beforeExpire({ now: current });
        if (disposed) return { ...state };
        const expiration = store.expireEvents({ now: current });
        state.forgotten += expiration.expired.length; state.expiredJobs += expiration.expiredJobs.length;
        const forgotten = store.listEvents({ status: 'forgotten', limit: 100000 });
        for (const event of forgotten) {
          if (disposed) break;
          try {
            // Run for existing tombstones too: switching index folders or replaying
            // an interrupted identity-reference update must never resurrect them.
            await onForget(event);
            if (disposed) break;
            const result = store.cleanupForgottenEvent(event.id);
            if (result.deleted) state.deleted++;
          } catch (error) { failed = true; report(error); }
        }
        state.pending = store.listEvents({ status: 'forgotten', limit: 100000 }).filter(event => event.cleanup !== 'complete').length;
      } catch (error) { failed = true; report(error); }
      schedule(failed || state.pending > 0);
      changed({ ...state });
      return { ...state };
    }).finally(() => { running = null; });
    return running;
  }
  function dispose() {
    disposed = true; if (timer) { clearTimer(timer); timer = null; }
    state.nextRunAt = null;
    return (running ?? Promise.resolve()).then(() => undefined);
  }
  if (autoStart) queueMicrotask(() => { if (!disposed) void run(); });
  return { run, dispose, status: () => ({ ...state, running: Boolean(running), disposed }) };
}
export default createEventRetention;
