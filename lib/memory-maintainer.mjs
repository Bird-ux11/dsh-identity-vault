import { createHash } from 'node:crypto';
import { isExpiredEvent } from './event-retention.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const canonical = (store, id) => store.getIdentity({ id })?.id ?? id;
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const sorted = values => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Compare complete attributed summaries, never just similar titles or keywords.
 * Independent occurrences retain their immutable bodies and source timestamps. */
export function duplicateFingerprint(event, body, store) {
  const statement = item => normalize(item?.text);
  const content = {
    scope: event.scope,
    recipients: sorted(event.participants.map(person => [person.personId, person.scope])),
    summary: normalize(body.summary),
    participants: sorted(body.participants.map(person => [canonical(store, person.personId), normalize(person.said)])),
    selfSaid: statement(body.selfSaid), conclusion: statement(body.conclusion),
    details: body.eventDetails ? {
      facts: sorted(body.eventDetails.facts.map(statement)), framework: statement(body.eventDetails.framework),
      outcome: statement(body.eventDetails.outcome), unresolved: sorted(body.eventDetails.unresolved.map(statement)),
      evaluations: sorted(body.eventDetails.evaluations.map(value => [canonical(store, value.byPersonId),
        value.aboutPersonId === null ? null : canonical(store, value.aboutPersonId), normalize(value.text)])),
    } : null,
    states: sorted((body.stateChanges ?? []).map(value => [canonical(store, value.personId), value.field, value.operation, normalize(value.value)])),
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** The immutable completed events are the durable maintenance queue. Re-scanning
 * after a crash retries each idempotent state/index write without another model
 * call. No raw transcript or separate unbounded retry payload is persisted. */
export function createMemoryMaintainer({ store, topicStore, reconcile = () => {}, onChange = () => {}, onError = () => {},
  now = Date.now, autoStart = true, retryMs = 1000, intervalMs = 60000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!store?.promoteCoreEvent || !topicStore?.applyMaintenance || typeof reconcile !== 'function'
    || !Number.isInteger(retryMs) || retryMs < 1 || !Number.isInteger(intervalMs) || intervalMs < retryMs) fail('INVALID_ARGUMENT', 'Invalid memory maintenance configuration.');
  let disposed = false, running = null, timer = null, failures = 0;
  const bodies = new Map();
  let state = { version: 1, lastRunAt: null, nextRunAt: null, successfulRuns: 0, failedRuns: 0,
    lastErrorCode: null, pendingRetry: false, activeEvents: 0, retainedEvents: 0, duplicateEvents: 0, stateRecords: 0, coreEvents: 0 };
  const safeError = error => Object.assign(new Error('Memory maintenance needs a retry; event sources were retained.'), {
    code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_:-]{0,127}$/.test(error.code) ? error.code : 'MAINTENANCE_FAILED',
  });
  function schedule(delay) {
    if (disposed) return;
    if (timer) clearTimer(timer);
    state.nextRunAt = new Date(now() + delay).toISOString();
    timer = setTimer(() => { timer = null; void run().catch(() => {}); }, delay); timer?.unref?.();
  }
  function maintain() {
    const events = topicStore.listEvents({ status: 'active', limit: 100000 })
      .filter(event => !store.isEventInvalidated?.(event.id))
      .sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
    const liveIds = new Set(events.map(event => event.id));
    for (const key of bodies.keys()) if (!liveIds.has(key)) bodies.delete(key);
    const inputs = [];
    let applied = 0;
    for (const event of events) {
      if (disposed) fail('MAINTENANCE_DISPOSED', 'Maintenance was stopped.');
      let body = bodies.get(event.id)?.hash === event.contentHash ? bodies.get(event.id).body : null;
      if (!body) {
        body = topicStore.readEvent(event.id, { forMaintenance: true }).body;
        bodies.set(event.id, { hash: event.contentHash, body });
      }
      const changes = (store.isEventInvalidated?.(event.id) ? [] : body.stateChanges ?? []).map(change => {
        const subject = canonical(store, change.personId), author = subject === 'self' ? 'owner' : subject;
        const participant = event.participants.find(person => canonical(store, person.personId) === author);
        if (!participant || change.sourceMessageIds.some(id => !participant.sourceEventIds.includes(id))) fail('INVALID_EVIDENCE', 'State evidence must come from its actual subject or the owner for self.');
        const sources = store.getDialogueEvents({ scope: participant.scope, sourceEventIds: change.sourceMessageIds });
        if (!sources.length || sources.some(source => source.speaker !== 'person' || canonical(store, source.authorId) !== author)) fail('INVALID_EVIDENCE', 'State evidence is not an attributed user statement.');
        return { personId: subject, field: change.field, operation: change.operation, value: change.value,
          sourceEventIds: change.sourceMessageIds, at: sources.map(source => source.at).sort().at(-1) };
      });
      if (changes.length) {
        try {
          const result = store.promoteCoreEvent({ eventId: event.id, scope: event.scope, changes, time: event.time });
          applied += result.applied.length;
        } catch (error) { if (error.code !== 'MEMORY_REVOKED') throw error; }
      }
      inputs.push({ event, body, changes });
    }
    const records = store.listMemoryState();
    const updates = inputs.map(({ event }) => ({ eventId: event.id, expectedContentHash: event.contentHash,
      retained: false, duplicateOf: null, duplicateIds: [], supersededAt: null }));
    const byId = new Map(updates.map(update => [update.eventId, update])), groups = new Map();
    for (const { event, body } of inputs) {
      const update = byId.get(event.id), proposed = { ...event, maintenance: { version: 1, retained: update.retained,
        ...(update.supersededAt ? { supersededAt: update.supersededAt } : {}) } };
      if (isExpiredEvent(proposed, now())) continue;
      const key = duplicateFingerprint(event, body, store);
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(event);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
      const primary = group[0], duplicates = group.slice(1);
      byId.get(primary.id).duplicateIds = duplicates.map(event => event.id).sort();
      for (const event of duplicates) byId.get(event.id).duplicateOf = primary.id;
    }
    const result = topicStore.applyMaintenance({ updates });
    const reconciliation = reconcile();
    if (reconciliation && typeof reconciliation.then === 'function') {
      Promise.resolve(reconciliation).catch(() => {});
      fail('ASYNC_MAINTENANCE_HOOK', 'Maintenance reconciliation must commit synchronously.');
    }
    state = { ...state, activeEvents: events.length, retainedEvents: 0, coreEvents: store.listCoreEvents().length,
      duplicateEvents: updates.filter(update => update.duplicateOf).length, stateRecords: records.length };
    return { appliedStates: applied, changedEvents: result.changed.length, ...state };
  }
  function run() {
    if (disposed) return Promise.reject(safeError({ code: 'MAINTENANCE_DISPOSED' }));
    if (running) return running;
    if (timer) { clearTimer(timer); timer = null; }
    running = Promise.resolve().then(() => {
      state.lastRunAt = new Date(now()).toISOString();
      const result = maintain(); failures = 0;
      state.successfulRuns++; state.pendingRetry = false; state.lastErrorCode = null;
      schedule(intervalMs);
      const notification = onChange({ ...state, appliedStates: result.appliedStates, changedEvents: result.changedEvents });
      if (notification && typeof notification.then === 'function') {
        Promise.resolve(notification).catch(() => {});
        fail('ASYNC_MAINTENANCE_HOOK', 'Maintenance change notification must be synchronous.');
      }
      return { ...state };
    }).catch(error => {
      const sanitized = safeError(error); failures++; state.failedRuns++; state.pendingRetry = true; state.lastErrorCode = sanitized.code;
      schedule(Math.min(intervalMs, retryMs * 2 ** Math.min(10, failures - 1)));
      try { onError(sanitized); } catch {}
      throw sanitized;
    }).finally(() => { running = null; });
    return running;
  }
  function dispose() { disposed = true; if (timer) clearTimer(timer); timer = null; state.nextRunAt = null; bodies.clear(); return (running ?? Promise.resolve()).catch(() => {}); }
  if (autoStart) queueMicrotask(() => { if (!disposed) void run().catch(() => {}); });
  return { run, dispose, status: () => ({ ...state, running: Boolean(running), disposed }) };
}
