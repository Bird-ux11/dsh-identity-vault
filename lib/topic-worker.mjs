import { randomUUID } from 'node:crypto';
import { summarizeTopics } from './topic-summarizer.mjs';
import { isExpiredEvent } from './event-retention.mjs';

const SAFE_CODES = new Set(['STORE_CORRUPT', 'STORE_MISSING', 'STORE_READ_FAILED', 'STORE_WRITE_FAILED', 'STORE_LOCKED', 'LOCK_FAILED',
  'INVALID_ARGUMENT', 'INVALID_SCOPE', 'INVALID_EVIDENCE', 'IDENTITY_CONFLICT', 'NOT_FOUND', 'EVENT_CONFLICT',
  'JOB_CLAIM_MISMATCH', 'JOB_LEASE_EXPIRED', 'JOB_CONFLICT', 'JOB_IMMUTABLE', 'MODEL_UNAVAILABLE', 'MODEL_FAILED', 'TIMEOUT', 'ABORTED',
  'INVALID_JSON', 'INVALID_INPUT', 'UNTRUSTED_SCOPE', 'INPUT_TOO_LARGE', 'VERBATIM_OUTPUT', 'CALL_BUDGET_EXCEEDED', 'INCOMPLETE_GENERATION',
  'INVALID_OUTPUT', 'INVALID_LIMITS', 'INCOMPLETE_COVERAGE', 'WORKER_DISPOSED', 'TASK_TIMEOUT', 'LEASE_RENEW_FAILED', 'TURN_INVALID',
  'LOAD_MESSAGES_FAILED', 'MODEL_FACTORY_FAILED', 'TOPIC_FAILED', 'STORE_FAILED', 'CALLBACK_FAILED', 'SOURCE_UNAVAILABLE', 'SOURCE_MISMATCH',
  'QQ_TEXT_SPAN_MISSING', 'QQ_REPLY_POLICY_MISSING', 'STREAM_INVALID', 'OUTPUT_TOO_LARGE', 'UNEXPECTED_TOOL_CALL',
  'JOB_EXPIRED', 'EVENT_FORGOTTEN', 'INVALID_CANDIDATES', 'CANDIDATE_PREPARATION_FAILED']);
const expiredError = error => ['JOB_EXPIRED', 'EVENT_FORGOTTEN'].includes(error?.code);
function workerError(code, stage, jobId) {
  const error = new Error(`Topic worker failed during ${stage}.`); error.name = 'TopicWorkerError';
  error.code = SAFE_CODES.has(code) ? code : 'TOPIC_FAILED'; error.stage = stage;
  if (jobId !== undefined) error.jobId = jobId; return error;
}
function milliseconds(value, name, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 3600000) throw workerError('INVALID_ARGUMENT', name);
}
function scopesOf(scopes) {
  if (!Array.isArray(scopes)) throw workerError('INVALID_SCOPE', 'scope-validation');
  const qq = value => typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
  return scopes.flatMap(scope => {
    if (scope?.kind === 'local-owner' && !scope.qqId && !scope.groupId) return [{ kind: 'local-owner' }];
    if (scope?.kind === 'qq-direct' && qq(scope.qqId) && !scope.groupId) return [{ kind: scope.kind, qqId: scope.qqId }];
    if (scope?.kind === 'qq-group' && qq(scope.groupId)) {
      const values = scope.qqIds ?? [scope.qqId];
      if (Array.isArray(values) && values.length && values.every(qq)) return values.map(qqId => ({ kind: scope.kind, groupId: scope.groupId, qqId }));
    }
    throw workerError('INVALID_SCOPE', 'scope-validation');
  });
}
function matchesScope(job, scopes) {
  return scopes.some(scope => scope.kind === 'local-owner' ? job.scope?.kind === 'local-owner'
    : scope.kind === 'qq-direct' ? job.scope?.kind === 'qq-direct' && job.scope.qqId === scope.qqId
      : job.scope?.kind === 'qq-group' && job.scope.qqIds.includes(scope.qqId));
}
function abortable(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(workerError('ABORTED', 'task')); }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(workerError('ABORTED', 'task')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
function retryDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(workerError('ABORTED', 'commit')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    if (signal.aborted) abort();
  });
}
function validatedMessages(job, messages) {
  const expected = new Map(job.participants.flatMap(person => person.sourceEventIds.map(id => [id, { speaker: 'person', personId: person.personId }])));
  for (const id of job.selfEventIds) expected.set(id, { speaker: 'self', personId: 'self' });
  if (!Array.isArray(messages) || messages.length !== expected.size) throw workerError('SOURCE_MISMATCH', 'evidence-validation');
  const seen = new Set();
  for (const message of messages) {
    const source = expected.get(message?.id);
    if (!source || seen.has(message.id) || source.speaker !== message.speaker || source.personId !== message.personId) throw workerError('SOURCE_MISMATCH', 'evidence-validation');
    seen.add(message.id);
  }
  return messages;
}

/** Completed bodies survive callback failure; callbacks are replayable and must be idempotent. */
export function createTopicWorker({ store, loadMessages, modelCallForJob, prepareCandidates, onCompleted, onError, onChange, beforeDrain,
  retryMs = 5000, leaseMs = 120000, taskTimeoutMs = 180000 } = {}) {
  if (!store || typeof loadMessages !== 'function' || typeof modelCallForJob !== 'function'
    || (onCompleted !== undefined && typeof onCompleted !== 'function')
    || (prepareCandidates !== undefined && typeof prepareCandidates !== 'function')
    || (beforeDrain !== undefined && typeof beforeDrain !== 'function')) throw workerError('INVALID_ARGUMENT', 'configuration');
  milliseconds(retryMs, 'retryMs'); milliseconds(leaseMs, 'leaseMs'); milliseconds(taskTimeoutMs, 'taskTimeoutMs');
  const workerId = `topic-worker:${process.pid}:${randomUUID()}`, waiters = new Set(), notifications = new Map();
  let disposed = false, running = null, active = null, pollTimer = null, disposePromise = null, kickAgain = false, beforeDrainRetryAt = 0;
  const expired = item => item?.status === 'expired' || item?.status === 'forgotten'
    || isExpiredEvent(item, typeof store.clock === 'function' ? store.clock() : Date.now());
  const liveCompletion = completion => {
    const events = completion.events.map(event => store.getEvent(event.id)).filter(event => event && event.status === 'active' && !expired(event));
    return events.length ? { ...completion, events } : null;
  };
  const report = (error, stage, job, fallback = 'TOPIC_FAILED') => {
    const sanitized = workerError(SAFE_CODES.has(error?.code) ? error.code : fallback, stage, job?.id);
    if (typeof onError === 'function') { try { Promise.resolve(onError(sanitized)).catch(() => {}); } catch {} }
    return sanitized;
  };
  const changed = (type, job) => {
    if (typeof onChange === 'function') {
      const event = { type, ...(job ? { jobId: job.id, status: job.status, attempts: job.attempts } : {}) };
      try { Promise.resolve(onChange(event)).catch(error => report(error, 'on-change', job, 'CALLBACK_FAILED')); }
      catch (error) { report(error, 'on-change', job, 'CALLBACK_FAILED'); }
    }
    for (const wake of [...waiters]) wake();
  };
  function relevantJobs(scopes) {
    const pending = ['pending', 'running', 'failed'].flatMap(status => store.listJobs({ status, limit: 10000 }));
    // A body may be durable before its seven-field index is committed. Keep
    // waiting for the idempotent callback instead of claiming it is recalled.
    for (const [id, completion] of notifications) {
      if (liveCompletion(completion)) pending.push({ ...completion.job, status: 'running' });
      else notifications.delete(id);
    }
    return pending.filter(job => !expired(job) && matchesScope(job, scopes));
  }
  function pendingForScopes(scopes) {
    try { return relevantJobs(scopesOf(scopes)).length; } catch (error) { throw report(error, 'pending-query', null, 'STORE_FAILED'); }
  }
  async function notifyCompleted(completion, signal) {
    if (!onCompleted) return;
    await abortable(Promise.resolve().then(() => {
      if (signal.aborted || disposed) throw workerError('WORKER_DISPOSED', 'completed-callback');
      const live = liveCompletion(completion);
      if (!live) throw workerError('EVENT_FORGOTTEN', 'completed-callback');
      return onCompleted(live.events, live.job, { signal });
    }), signal);
  }
  async function execute(job) {
    if (expired(job)) { changed('expired', job); return; }
    const controller = new AbortController(); let stopCode = null, stage = 'load-messages', committed = false;
    const stop = code => { if (!stopCode) stopCode = code; controller.abort(); }; active = { job, stop };
    const timeout = setTimeout(() => stop('TASK_TIMEOUT'), taskTimeoutMs);
    const renewTimer = setInterval(() => {
      if (controller.signal.aborted || committed) return;
      try { store.renewJob({ id: job.id, claimToken: job.claimToken, leaseMs }); }
      catch (error) {
        if (expiredError(error) || expired(job)) { stop('JOB_EXPIRED'); return; }
        report(error, 'lease-renewal', job, 'STORE_FAILED'); stop('LEASE_RENEW_FAILED');
      }
    }, Math.max(1, Math.min(30000, Math.floor(leaseMs / 3)))); renewTimer.unref?.();
    try {
      if (disposed) stop('WORKER_DISPOSED');
      const check = () => { if (controller.signal.aborted) throw workerError(stopCode ?? 'ABORTED', stage); };
      check();
      if (typeof job.turnId !== 'string' || !/^(0|[1-9]\d*)$/.test(job.turnId) || !Number.isSafeInteger(Number(job.turnId))) throw workerError('TURN_INVALID', 'turn-validation');
      const messages = validatedMessages(job, await abortable(Promise.resolve().then(() => { check(); return loadMessages(job, { signal: controller.signal }); }), controller.signal));
      stage = 'model-factory';
      const modelCall = await abortable(Promise.resolve().then(() => { check(); return modelCallForJob(job, { signal: controller.signal }); }), controller.signal);
      stage = 'prepare-candidates';
      const candidates = prepareCandidates ? await abortable(Promise.resolve().then(() => {
        check();
        // The hook sees copies; an adapter cannot rewrite the evidence/job that
        // the second layer will validate or eventually commit.
        return prepareCandidates({ job: structuredClone(job), messages: structuredClone(messages), modelCall, signal: controller.signal });
      }), controller.signal) : [];
      check();
      stage = 'summarization';
      const result = await summarizeTopics({ messages, candidates, scope: { trusted: true, sessionId: job.sessionId, turn: Number(job.turnId),
        personIds: job.participants.map(person => person.personId), ...(job.scope.groupId ? { groupId: job.scope.groupId } : {}) }, modelCall, signal: controller.signal });
      check(); stage = 'commit';
      let completion;
      // A transient disk/lock failure should retry the same validated summary,
      // rather than spend another model call or create a different event body.
      for (let attempt = 1; attempt <= 3; attempt++) {
        check();
        try { completion = store.completeJob({ id: job.id, claimToken: job.claimToken, topics: result.topics }); break; }
        catch (error) {
          if (attempt === 3 || !['STORE_WRITE_FAILED', 'STORE_LOCKED', 'LOCK_FAILED'].includes(error?.code)) throw error;
          report(error, 'commit-retry', job, 'STORE_FAILED');
          await retryDelay(Math.min(retryMs, 1000), controller.signal);
        }
      }
      committed = true;
      if (onCompleted) notifications.set(job.id, { ...completion, retryAt: 0 });
      changed('completed', completion.job);
      stage = 'completed-callback';
      await notifyCompleted(completion, controller.signal); notifications.delete(job.id); changed('indexed', completion.job);
    } catch (error) {
      if (expiredError(error) || stopCode === 'JOB_EXPIRED' || expired(job)) {
        notifications.delete(job.id); changed('expired', job); return;
      }
      const fallback = stage === 'load-messages' ? 'LOAD_MESSAGES_FAILED' : stage === 'model-factory' ? 'MODEL_FACTORY_FAILED'
        : stage === 'prepare-candidates' ? 'CANDIDATE_PREPARATION_FAILED'
        : stage === 'commit' ? 'STORE_FAILED' : stage === 'completed-callback' ? 'CALLBACK_FAILED' : 'TOPIC_FAILED';
      const sanitized = report(stopCode ? workerError(stopCode, stage) : error, stage, job, fallback);
      if (committed) { const notification = notifications.get(job.id); if (notification) notification.retryAt = Date.now() + retryMs; }
      else try {
        const failed = store.failJob({ id: job.id, claimToken: job.claimToken, errorCode: sanitized.code, retryAt: new Date(Date.now() + retryMs * Math.max(1, job.attempts)).toISOString() });
        changed('failed', failed);
      } catch (failure) {
        if (expiredError(failure) || expired(job)) { notifications.delete(job.id); changed('expired', job); return; }
        report(failure, 'failure-persistence', job, 'STORE_FAILED');
        try { const recovered = store.recoverJobs(); if (recovered.recovered.length) changed('recovered'); } catch (recoveryError) { report(recoveryError, 'recovery', job, 'STORE_FAILED'); }
      }
    } finally { clearTimeout(timeout); clearInterval(renewTimer); active = null; for (const wake of [...waiters]) wake(); }
  }
  async function replayNotifications() {
    for (const [jobId, completion] of [...notifications]) {
      if (disposed) return; if (completion.retryAt > Date.now()) continue;
      if (!liveCompletion(completion)) { notifications.delete(jobId); changed('expired', completion.job); continue; }
      const controller = new AbortController(); active = { job: completion.job, stop: () => controller.abort() };
      const timer = setTimeout(() => controller.abort(), taskTimeoutMs);
      try { await notifyCompleted(completion, controller.signal); notifications.delete(jobId); changed('indexed', completion.job); }
      catch (error) {
        if (expiredError(error) || expired(completion.job)) { notifications.delete(jobId); changed('expired', completion.job); }
        else { completion.retryAt = Date.now() + retryMs; report(error, 'completed-callback', completion.job, 'CALLBACK_FAILED'); }
      }
      finally { clearTimeout(timer); active = null; }
    }
  }
  async function maintainBeforeClaim() {
    if (disposed || Date.now() < beforeDrainRetryAt) return false;
    if (beforeDrain) {
      const controller = new AbortController();
      active = { job: null, stop: () => controller.abort() };
      try {
        await abortable(Promise.resolve().then(() => {
          if (disposed || controller.signal.aborted) throw workerError('WORKER_DISPOSED', 'before-drain');
          return beforeDrain({ signal: controller.signal });
        }), controller.signal);
        beforeDrainRetryAt = 0;
      } catch (error) {
        if (!disposed) { report(error, 'before-drain', null, 'STORE_FAILED'); beforeDrainRetryAt = Date.now() + retryMs; }
        return false;
      } finally { active = null; }
    }
    return !disposed;
  }
  async function drain() {
    if (!await maintainBeforeClaim()) return;
    try { const recovery = store.recoverJobs(); if (recovery.recovered.length) changed('recovered'); }
    catch (error) { report(error, 'recovery', null, 'STORE_FAILED'); return; }
    await replayNotifications();
    while (!disposed) {
      // A previous callback may have committed an event but failed to classify
      // its long-term state. claimJob also expires old bodies, so maintenance
      // must succeed again immediately before every claim, including a backlog.
      if (!await maintainBeforeClaim()) return;
      let job; try { job = store.claimJob({ workerId, leaseMs }); } catch (error) { report(error, 'claim', null, 'STORE_FAILED'); return; }
      if (!job || job.status === 'expired') return; changed('claimed', job); await execute(job);
    }
  }
  function schedulePoll() { if (disposed || pollTimer) return; pollTimer = setTimeout(() => { pollTimer = null; void kick(); }, retryMs); pollTimer.unref?.(); }
  function kick() {
    if (disposed) return Promise.resolve();
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (running) { kickAgain = true; return running; }
    running = Promise.resolve().then(drain).catch(error => report(error, 'drain', null, 'STORE_FAILED')).finally(() => {
      running = null; if (disposed) return;
      if (kickAgain) { kickAgain = false; queueMicrotask(() => { void kick(); }); } else schedulePoll();
    }); return running;
  }
  function waitForScopes(scopes, { signal, timeoutMs = 60000 } = {}) {
    let clean; try { clean = scopesOf(scopes); milliseconds(timeoutMs, 'timeoutMs', true); }
    catch (error) { report(error, 'wait-validation'); return Promise.resolve({ pending: 1, timedOut: false, aborted: false, disposed, unavailable: true }); }
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs; let timer = null, finished = false;
      const finish = result => { if (finished) return; finished = true; if (timer) clearTimeout(timer); signal?.removeEventListener('abort', evaluate); waiters.delete(evaluate); resolve(result); };
      const evaluate = () => {
        if (finished) return; if (timer) { clearTimeout(timer); timer = null; }
        let jobs; try { jobs = relevantJobs(clean); } catch (error) { report(error, 'wait-query', null, 'STORE_FAILED'); finish({ pending: 1, timedOut: false, aborted: Boolean(signal?.aborted), disposed, unavailable: true }); return; }
        const result = { pending: jobs.length, timedOut: false, aborted: Boolean(signal?.aborted), disposed };
        if (disposed || signal?.aborted || !jobs.length) { finish(result); return; }
        if (!jobs.some(job => job.status === 'running' || job.status === 'pending' || (job.status === 'failed' && job.attempts < job.maxAttempts && job.availableAt))) { finish(result); return; }
        if (Date.now() >= deadline) { finish({ ...result, timedOut: true }); return; }
        void kick(); timer = setTimeout(evaluate, Math.max(1, Math.min(100, retryMs, deadline - Date.now())));
      };
      waiters.add(evaluate); signal?.addEventListener('abort', evaluate, { once: true }); evaluate();
    });
  }
  function dispose() {
    if (disposePromise) return disposePromise; disposed = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    active?.stop('WORKER_DISPOSED'); for (const wake of [...waiters]) wake();
    disposePromise = (running ?? Promise.resolve()).then(() => undefined); return disposePromise;
  }
  // Replaying metadata callbacks requires no transcript reads or model calls.
  if (onCompleted) try {
    for (const job of store.listJobs({ status: 'completed', limit: 10000 })) {
      const events = job.eventIds.map(id => store.getEvent(id));
      if (events.every(Boolean)) {
        const completion = liveCompletion({ job, events, retryAt: 0 });
        if (completion) notifications.set(job.id, completion);
      }
    }
  } catch (error) { report(error, 'callback-recovery', null, 'STORE_FAILED'); }
  queueMicrotask(() => { if (!disposed) void kick(); });
  return { kick, waitForScopes, dispose, pendingForScopes };
}
export default createTopicWorker;
