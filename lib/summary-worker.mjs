import { randomUUID } from 'node:crypto';
import { summarizeConversation } from './summarizer.mjs';

const SAFE_CODES = new Set([
  'STORE_CORRUPT', 'STORE_MISSING', 'STORE_READ_FAILED', 'STORE_WRITE_FAILED', 'STORE_LOCKED', 'LOCK_FAILED',
  'INVALID_ARGUMENT', 'INVALID_SCOPE', 'INVALID_EVIDENCE', 'IDENTITY_CONFLICT', 'NOT_FOUND',
  'JOB_CLAIM_MISMATCH', 'JOB_LEASE_EXPIRED', 'JOB_CONFLICT', 'JOB_IMMUTABLE', 'IMPRESSION_CONFLICT',
  'MODEL_UNAVAILABLE', 'MODEL_FAILED', 'TIMEOUT', 'ABORTED', 'INVALID_JSON', 'INVALID_INPUT',
  'UNTRUSTED_SCOPE', 'INPUT_TOO_LARGE', 'VERBATIM_OUTPUT', 'CALL_BUDGET_EXCEEDED',
  'INCOMPLETE_GENERATION', 'INVALID_OUTPUT', 'INVALID_LIMITS',
  'WORKER_DISPOSED', 'TASK_TIMEOUT', 'LEASE_RENEW_FAILED', 'TURN_INVALID', 'TARGET_NOT_FOUND',
  'LOAD_MESSAGES_FAILED', 'MODEL_FACTORY_FAILED', 'SUMMARY_FAILED', 'STORE_FAILED', 'CALLBACK_FAILED',
  'SOURCE_UNAVAILABLE', 'SOURCE_MISMATCH', 'QQ_TEXT_SPAN_MISSING', 'QQ_REPLY_POLICY_MISSING',
  'STREAM_INVALID', 'OUTPUT_TOO_LARGE', 'UNEXPECTED_TOOL_CALL',
]);

function workerError(code, stage, jobId) {
  const error = new Error(`Summary worker failed during ${stage}.`);
  error.name = 'SummaryWorkerError';
  error.code = SAFE_CODES.has(code) ? code : 'SUMMARY_FAILED';
  error.stage = stage;
  if (jobId !== undefined) error.jobId = jobId;
  return error;
}

function milliseconds(value, name, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 3_600_000) {
    throw workerError('INVALID_ARGUMENT', name);
  }
  return value;
}

function scopesOf(scopes) {
  if (!Array.isArray(scopes)) throw workerError('INVALID_SCOPE', 'scope-validation');
  return scopes.map(scope => {
    if (scope?.kind === 'local-owner') return { kind: 'local-owner' };
    if (['qq-group', 'qq-direct'].includes(scope?.kind) && typeof scope.qqId === 'string' && /^[1-9][0-9]{4,19}$/.test(scope.qqId)) {
      if (scope.kind === 'qq-group' && (typeof scope.groupId !== 'string' || !/^[1-9][0-9]{4,19}$/.test(scope.groupId))) throw workerError('INVALID_SCOPE', 'scope-validation');
      return { kind: scope.kind, qqId: scope.qqId, ...(scope.groupId ? { groupId: scope.groupId } : {}) };
    }
    throw workerError('INVALID_SCOPE', 'scope-validation');
  });
}

function matchesScope(job, scopes) {
  return scopes.some(scope => scope.kind === 'local-owner'
    ? job.scope?.kind === 'local-owner'
    : job.scope?.kind === scope.kind && job.scope.qqId === scope.qqId);
}

function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(workerError('ABORTED', 'task'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(workerError('ABORTED', 'task')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    // Attach both handlers even to callbacks that ignore cancellation: their late
    // rejection must never become unhandled, and their result cannot commit.
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Background serial worker. Inputs and callbacks belong to the trusted host.
 * Original messages exist only in the in-flight summarizer; store completion
 * receives the four validated summary fields and the job's fixed provenance.
 */
export function createSummaryWorker({
  store, loadMessages, modelCallForJob, onError, onChange,
  retryMs = 5_000, leaseMs = 120_000, taskTimeoutMs = 180_000,
} = {}) {
  if (!store || typeof loadMessages !== 'function' || typeof modelCallForJob !== 'function') {
    throw workerError('INVALID_ARGUMENT', 'worker-configuration');
  }
  milliseconds(retryMs, 'retryMs'); milliseconds(leaseMs, 'leaseMs'); milliseconds(taskTimeoutMs, 'taskTimeoutMs');
  const workerId = `summary-worker:${process.pid}:${randomUUID()}`;
  const waiters = new Set();
  let disposed = false;
  let running = null;
  let active = null;
  let pollTimer = null;
  let disposePromise = null;
  let kickAgain = false;

  function report(error, stage, job, fallback = 'SUMMARY_FAILED') {
    // Never forward the original message, stack or cause (provider errors can
    // contain prompts, credentials, or transcript excerpts).
    const sanitized = workerError(SAFE_CODES.has(error?.code) ? error.code : fallback, stage, job?.id);
    if (typeof onError === 'function') {
      try { Promise.resolve(onError(sanitized)).catch(() => {}); } catch { /* Error handlers cannot break the worker. */ }
    }
    return sanitized;
  }

  function changed(type, job) {
    const event = { type };
    if (job) Object.assign(event, { jobId: job.id, status: job.status, attempts: job.attempts });
    if (typeof onChange === 'function') {
      try { Promise.resolve(onChange(event)).catch(error => report(error, 'on-change', job, 'CALLBACK_FAILED')); }
      catch (error) { report(error, 'on-change', job, 'CALLBACK_FAILED'); }
    }
    for (const wake of [...waiters]) wake();
  }

  function relevantJobs(scopes) {
    const output = [];
    for (const status of ['pending', 'running', 'failed']) {
      for (const job of store.listSummaryJobs({ status, limit: 10_000 })) if (matchesScope(job, scopes)) output.push(job);
    }
    return output;
  }

  function pendingForScopes(scopes) {
    try { return relevantJobs(scopesOf(scopes)).length; }
    catch (error) { throw report(error, 'pending-query', null, 'STORE_FAILED'); }
  }

  async function execute(job) {
    const controller = new AbortController();
    let stopCode = null;
    let stage = 'load-messages';
    const stop = code => { if (!stopCode) stopCode = code; controller.abort(); };
    active = { job, stop };
    const timeout = setTimeout(() => stop('TASK_TIMEOUT'), taskTimeoutMs);
    const renewEvery = Math.max(1, Math.min(30_000, Math.floor(leaseMs / 3)));
    const renewTimer = setInterval(() => {
      if (controller.signal.aborted) return;
      try { store.renewSummaryJob({ id: job.id, claimToken: job.claimToken, leaseMs }); }
      catch (error) { report(error, 'lease-renewal', job, 'STORE_FAILED'); stop('LEASE_RENEW_FAILED'); }
    }, renewEvery);
    renewTimer.unref?.();
    try {
      if (disposed) stop('WORKER_DISPOSED');
      if (controller.signal.aborted) throw workerError(stopCode ?? 'ABORTED', stage);
      if (typeof job.turnId !== 'string' || !/^[0-9]+$/.test(job.turnId) || !Number.isSafeInteger(Number(job.turnId))) {
        throw workerError('TURN_INVALID', 'turn-validation');
      }
      const messages = await abortable(Promise.resolve().then(() => {
        if (controller.signal.aborted) throw workerError('ABORTED', 'load-messages');
        return loadMessages(job, { signal: controller.signal });
      }), controller.signal);
      // Owner binding / direct-to-group migration can occur while loading.
      // Only a known canonical redirect may change the claimed participant id.
      const targetId = store.getIdentity({ id: job.targetId })?.id;
      if (!targetId || targetId === 'self') throw workerError('TARGET_NOT_FOUND', 'target-resolution');
      const inputMessages = Array.isArray(messages) ? messages.map(message => message?.speaker === 'person' && message.personId === job.targetId
        ? { ...message, personId: targetId } : message) : messages;
      stage = 'model-factory';
      const modelCall = await abortable(Promise.resolve().then(() => {
        if (controller.signal.aborted) throw workerError('ABORTED', 'model-factory');
        return modelCallForJob(job, { signal: controller.signal });
      }), controller.signal);
      stage = 'summarization';
      const result = await summarizeConversation({
        messages: inputMessages,
        scope: { trusted: true, sessionId: job.sessionId, turn: Number(job.turnId), personIds: [targetId], ...(job.scope.groupId ? { groupId: job.scope.groupId } : {}) },
        modelCall, signal: controller.signal,
      });
      if (controller.signal.aborted) throw workerError(stopCode ?? 'ABORTED', stage);
      const summary = result.summaries.find(item => item.personId === targetId);
      if (!summary) throw workerError('INVALID_OUTPUT', 'summary-selection');
      stage = 'commit';
      const completed = store.completeSummaryJob({
        id: job.id, claimToken: job.claimToken,
        impression: { summary: summary.summary, otherSaid: summary.otherSaid, selfSaid: summary.selfSaid, conclusion: summary.conclusion },
      });
      changed('completed', completed.job);
    } catch (error) {
      const fallback = stage === 'load-messages' ? 'LOAD_MESSAGES_FAILED' : stage === 'model-factory' ? 'MODEL_FACTORY_FAILED' : stage === 'commit' ? 'STORE_FAILED' : 'SUMMARY_FAILED';
      const sanitized = report(stopCode ? workerError(stopCode, stage) : error, stage, job, fallback);
      try {
        const failed = store.failSummaryJob({ id: job.id, claimToken: job.claimToken, errorCode: sanitized.code,
          retryAt: new Date(Date.now() + retryMs * Math.max(1, job.attempts)).toISOString() });
        changed('failed', failed);
      } catch (failure) {
        report(failure, 'failure-persistence', job, 'STORE_FAILED');
        // A lost/expired lease must not be stolen. Recovery only requeues leases
        // whose expiry is recorded on disk; a new owner's claim stays intact.
        try { const recovery = store.recoverSummaryJobs(); if (recovery.recovered.length) changed('recovered'); }
        catch (recoveryError) { report(recoveryError, 'recovery', job, 'STORE_FAILED'); }
      }
    } finally {
      clearTimeout(timeout); clearInterval(renewTimer);
      active = null;
      for (const wake of [...waiters]) wake();
    }
  }

  async function drain() {
    try { const recovery = store.recoverSummaryJobs(); if (recovery.recovered.length) changed('recovered'); }
    catch (error) { report(error, 'recovery', null, 'STORE_FAILED'); return; }
    while (!disposed) {
      let job;
      try { job = store.claimSummaryJob({ workerId, leaseMs }); }
      catch (error) { report(error, 'claim', null, 'STORE_FAILED'); return; }
      if (!job) return;
      changed('claimed', job);
      await execute(job);
    }
  }

  function schedulePoll() {
    if (disposed || pollTimer) return;
    pollTimer = setTimeout(() => { pollTimer = null; void kick(); }, retryMs);
    pollTimer.unref?.();
  }

  function kick() {
    if (disposed) return Promise.resolve();
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (running) { kickAgain = true; return running; }
    running = Promise.resolve().then(drain).catch(error => { report(error, 'drain', null, 'STORE_FAILED'); }).finally(() => {
      running = null;
      if (disposed) return;
      if (kickAgain) { kickAgain = false; queueMicrotask(() => { void kick(); }); }
      else schedulePoll();
    });
    return running;
  }

  function waitForScopes(scopes, { signal, timeoutMs = 60_000 } = {}) {
    let clean;
    try { clean = scopesOf(scopes); milliseconds(timeoutMs, 'timeoutMs', { zero: true }); }
    catch (error) { report(error, 'wait-validation'); return Promise.resolve({ pending: 1, timedOut: false, aborted: false, disposed, unavailable: true }); }
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      let checkTimer = null;
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        if (checkTimer) clearTimeout(checkTimer);
        signal?.removeEventListener('abort', evaluate);
        waiters.delete(evaluate);
        resolve(result);
      };
      const evaluate = () => {
        if (finished) return;
        if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
        let jobs;
        try { jobs = relevantJobs(clean); }
        catch (error) {
          report(error, 'wait-query', null, 'STORE_FAILED');
          finish({ pending: 1, timedOut: false, aborted: Boolean(signal?.aborted), disposed, unavailable: true });
          return;
        }
        const result = { pending: jobs.length, timedOut: false, aborted: Boolean(signal?.aborted), disposed };
        if (disposed || signal?.aborted || !jobs.length) { finish(result); return; }
        const actionable = jobs.some(job => job.status === 'running' || job.status === 'pending'
          || (job.status === 'failed' && job.attempts < job.maxAttempts && job.availableAt));
        if (!actionable) { finish(result); return; }
        if (Date.now() >= deadline) { finish({ ...result, timedOut: true }); return; }
        // This waiter can stop without cancelling work needed by another chat.
        void kick();
        checkTimer = setTimeout(evaluate, Math.max(1, Math.min(100, retryMs, deadline - Date.now())));
      };
      waiters.add(evaluate);
      signal?.addEventListener('abort', evaluate, { once: true });
      evaluate();
    });
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    active?.stop('WORKER_DISPOSED');
    for (const wake of [...waiters]) wake();
    disposePromise = (running ?? Promise.resolve()).then(() => undefined);
    return disposePromise;
  }

  // Creation resumes persisted work; no new chat turn is required to recover it.
  queueMicrotask(() => { if (!disposed) void kick(); });
  return { kick, waitForScopes, dispose, pendingForScopes };
}

export default createSummaryWorker;
