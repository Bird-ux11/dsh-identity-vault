import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MemoryIngress } from './memory-ingress.mjs';
import { createManagedFish, inspectFishPackage } from './managed-fish.mjs';
import { createManagedBillion } from './managed-billion.mjs';
import { summarizeTopics } from './topic-summarizer.mjs';
import { RETENTION_MS } from './event-retention.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const chatKey = scope => `${scope?.kind}:${scope?.groupId ?? scope?.qqId ?? ''}`;
const sid = agent => String(agent?.session?.id || agent?.id || '');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const packagePath = (name, root) => {
  try { return dirname(createRequire(import.meta.url).resolve(`${name}/package.json`)); }
  catch { return join(dirname(root), 'profiles', 'desktop', 'node_modules', name); }
};

/** The only publication authority remains the vault. The children produce
 * temporary candidates; they never mount the old fish store or memory tools. */
export function createManagedMemory({ ctx, root, store, topicStore, loadMessages, modelCallForJob,
  recall, onError = () => {}, onChange = () => {}, retryMs = 5000 } = {}) {
  const ingress = new MemoryIngress({ root }), ledger = new Map(), scopes = new Map(), currentScopes = new Map();
  let fish, billion, ready, stopped = false, lateRunning, timer, lastError = null, lateClassified = 0, disposePromise, closingBackends;
  const enabled = typeof ctx.plugin === 'function';
  const report = (phase, error) => { lastError = error.code || 'BACKEND_FAILED'; onError(phase, error); };
  const closeBackends = () => closingBackends ||= Promise.allSettled([fish, billion].map(backend => Promise.resolve().then(() => backend?.dispose())))
    .then(results => { const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason; });
  function revokedSources(scope, messages, policies = new Map()) {
    if (typeof store.getImpressionEvidencePolicy !== 'function') return false;
    return messages.some(message => {
      const key = `${chatKey(scope)}\0${message.personId}`;
      if (!policies.has(key)) policies.set(key, store.getImpressionEvidencePolicy({ personId: message.personId, scope }));
      return policies.get(key).blockedSourceEventIds.includes(message.id);
    });
  }
  const revokedJob = job => (job.eventIds ?? []).some(id => store.isEventInvalidated?.(id));
  const revokedRecord = (record, policies) => revokedSources(record.scope, record.evidence, policies)
    || record.decision?.some(item => store.isEventInvalidated?.(item.eventId));
  function revokeInvalidRecords() {
    let count = 0; const policies = new Map();
    for (const record of ingress.read().records) if (!record.revokedAt && revokedRecord(record, policies) && ingress.revoke(record.id)) count++;
    if (count) onChange();
    return count;
  }
  function remember(sessionId, scope, messages) {
    let history = ledger.get(sessionId); if (!history) ledger.set(sessionId, history = new Map());
    for (const message of messages) history.set(message.id, { ...message, scope });
    for (const [id, message] of history) if (Date.now() - Date.parse(message.at) >= RETENTION_MS) history.delete(id);
    while (history.size > 300) history.delete(history.keys().next().value);
    while (ledger.size > 32) { const oldest = ledger.keys().next().value; ledger.delete(oldest); scopes.delete(oldest); }
    scopes.set(sessionId, scope);
  }
  const access = (agent, { purpose = 'tool' } = {}) => {
    const sessionId = sid(agent), scope = purpose === 'collect' ? currentScopes.get(sessionId) ?? scopes.get(sessionId) : currentScopes.get(sessionId);
    if (!scope) return null;
    const history = [...(ledger.get(sessionId)?.values() ?? [])], policies = new Map();
    const messages = history.filter(message => chatKey(message.scope) === chatKey(scope)
      && Date.now() - Date.parse(message.at) < RETENTION_MS && !revokedSources(scope, [message], policies)).map(message => ({
      id: message.id.replace(/^(?:user|assistant):/, ''), sourceEventId: message.id,
      personId: message.personId, speaker: message.speaker === 'self' ? 'assistant' : 'user', text: message.text, at: message.at,
    }));
    const knownScopes = new Set(history.map(message => chatKey(message.scope)));
    let invalidJob = false;
    for (const job of topicStore.listJobs({ limit: 10000 })) if (job.sessionId === sessionId) { knownScopes.add(job.chatKey ?? chatKey(job.scope)); invalidJob ||= revokedJob(job); }
    return { sessionId, scope, messages, allowWorkingContext: !invalidJob && !history.some(message => revokedSources(message.scope, [message], policies))
      && [...knownScopes].every(key => key === chatKey(scope)) };
  };
  async function recoverLedger(agent) {
    const sessionId = sid(agent), scope = currentScopes.get(sessionId) ?? scopes.get(sessionId);
    if (!scope) return;
    const jobs = topicStore.listJobs({ status: 'completed', limit: 10000 }).filter(job => job.sessionId === sessionId
      && chatKey(job.scope) === chatKey(scope) && Date.now() - Date.parse(job.at) < RETENTION_MS && !revokedJob(job)).reverse();
    let count = 0;
    for (const job of jobs) {
      if (count + job.sourceEventIds.length > 300) break;
      count += job.sourceEventIds.length;
      if (job.sourceEventIds.every(id => ledger.get(sessionId)?.has(id))) continue;
      try { const messages = await loadMessages(job, {}); if (stopped) return; remember(sessionId, scope, messages); }
      catch (error) { report('backend-source-recovery', error); }
    }
  }
  async function accept(candidate) {
    if (stopped) fail('WORKER_DISPOSED');
    const history = ledger.get(candidate.sessionId), ids = candidate.sourceMessageIds;
    if (!history || !Array.isArray(ids) || !ids.length) fail('SOURCE_UNAVAILABLE');
    const messages = ids.map(id => history.get(id));
    if (messages.some(message => !message || chatKey(message.scope) !== chatKey(candidate.scope))) fail('SOURCE_MISMATCH');
    const result = ingress.submit({ backend: 'billion', sourceKey: candidate.sourceKey, sessionId: candidate.sessionId,
      scope: candidate.scope, messages, candidates: [{ backend: 'billion', text: candidate.text, category: candidate.category,
        sourceMessageIds: ids, at: candidate.at }] });
    if (revokedSources(candidate.scope, messages)) { ingress.revoke(result.id); onChange(); return { ...result, revoked: true }; }
    onChange(); kickLate(); return result;
  }
  async function start() {
    if (stopped) fail('WORKER_DISPOSED');
    if (ready) return ready;
    ready = (async () => {
      closingBackends = null;
      ingress.prune();
      if (!enabled) return;
      const runtimeNode = join(dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
      const nodePath = process.versions.electron && existsSync(runtimeNode) ? runtimeNode : process.execPath;
      const fishRoot = packagePath('dsh-fish-memory', root), billionRoot = packagePath('billion-context', root);
      inspectFishPackage(fishRoot);
      fish = createManagedFish({ packageRoot: fishRoot, nodeExecutable: nodePath,
        onError: error => report('fish', error) });
      billion = createManagedBillion({ ctx, packageRoot: billionRoot, root: join(root, 'managed-billion'), nodePath,
        resolveSessionAccess: access, onCandidate: accept, recall,
        onError: error => report('billion', error) });
      await fish.start();
      if (!stopped) await billion.start();
      if (stopped) { await closeBackends(); return; }
      lastError = null; onChange(); kickLate();
    })().catch(async error => { await Promise.allSettled([closeBackends()]);
      fish = null; billion = null; ready = null; report('backend-start', error); throw error; });
    return ready;
  }
  async function prepare({ job, messages, modelCall, signal }) {
    await start(); signal?.throwIfAborted(); if (stopped) fail('WORKER_DISPOSED');
    if (!enabled) return [];
    revokeInvalidRecords();
    if (revokedJob(job) || revokedSources(job.scope, messages)) return [];
    remember(job.sessionId, job.scope, messages);
    const agent = ctx.agents.list().find(agent => sid(agent) === job.sessionId);
    if (agent) { await recoverLedger(agent); try { await billion.collect(agent); } catch (error) { report('billion-collect', error); } }
    if (!ingress.has('fish', job.sessionId, job.id)) {
      const candidates = await fish.extract({ messages, signal, callModel: modelCall });
      const receipt = ingress.submit({ backend: 'fish', sourceKey: job.id, sessionId: job.sessionId, scope: job.scope, candidates, messages });
      if (revokedJob(job) || revokedSources(job.scope, messages)) { ingress.revoke(receipt.id); onChange(); return []; }
    }
    const selected = ingress.selectedForJob(job, messages);
    ingress.bindToJob(job.id, selected.recordIds);
    return selected.candidates;
  }
  function completed(job) {
    revokeInvalidRecords();
    for (const id of ingress.boundToJob(job.id)) ingress.classified(id);
    kickLate(); onChange();
  }
  async function sourcesFor(record, signal) {
    const requested = new Set(record.evidence.map(item => item.id)), messages = new Map(); let modelJob;
    const jobs = topicStore.listJobs({ status: 'completed', limit: 10000 }).filter(job => job.sessionId === record.sessionId
      && chatKey(job.scope) === chatKey(record.scope) && job.sourceEventIds.some(id => requested.has(id)));
    for (const job of jobs) {
      const loaded = await loadMessages(job, { signal }); modelJob = job;
      for (const message of loaded) if (requested.has(message.id)) messages.set(message.id, message);
    }
    if (messages.size !== requested.size) return null; // Wait for the normal topic to close and publish its Skill.
    for (const item of record.evidence) {
      const found = messages.get(item.id);
      if (found.personId !== item.personId || found.speaker !== item.speaker || found.at !== item.at) fail('SOURCE_MISMATCH');
    }
    return { messages: [...messages.values()].sort((a, b) => a.at.localeCompare(b.at)), modelJob };
  }
  let lateController;
  async function drainLate() {
    await start(); if (!enabled || stopped) return;
    revokeInvalidRecords(); ingress.prune(); lateController = new AbortController();
    const { signal } = lateController;
    try {
      for (const record of ingress.pending()) {
        if (stopped) return;
        if (record.classificationJobId) continue; // The normal job owns this durable classification receipt.
        try {
          let decision = record.decision;
          if (!decision) {
            const source = await sourcesFor(record, signal); if (!source) continue;
            const personIds = [...new Set(source.messages.filter(item => item.speaker === 'person').map(item => item.personId))];
            if (!personIds.length) { ingress.classified(record.id); continue; }
            const modelCall = await modelCallForJob(source.modelJob, { signal });
            const result = await summarizeTopics({ messages: source.messages, candidates: record.candidates,
              scope: { trusted: true, sessionId: record.sessionId, turn: Number(source.modelJob.turnId), personIds,
                ...(record.scope.groupId ? { groupId: record.scope.groupId } : {}) }, modelCall, signal });
            if (revokedRecord(record)) { ingress.revoke(record.id); onChange(); continue; }
            decision = result.topics.filter(topic => topic.stateChanges.length).map((topic, i) => ({ eventId: hash(`${record.id}:${i}`),
              changes: topic.stateChanges.map(({ sourceMessageIds, ...change }) => ({ ...change, sourceEventIds: sourceMessageIds })),
              time: record.at, scope: record.scope }));
            ingress.saveDecision(record.id, decision);
          }
          for (const item of decision) if (item.changes.length) store.promoteCoreEvent(item);
          ingress.classified(record.id); lateClassified++; onChange();
        } catch (error) {
          if (error.code === 'MEMORY_REVOKED') { ingress.revoke(record.id); onChange(); }
          else if (!stopped) report('backend-classify', error);
        }
      }
    } finally { lateController = null; }
  }
  function kickLate() {
    if (stopped || !enabled || lateRunning || timer) return;
    timer = setTimeout(() => { timer = null;
      lateRunning = drainLate().catch(error => { if (!stopped) report('backend-classify', error); }).finally(() => {
        lateRunning = null; if (!stopped) kickLate();
      });
    }, retryMs); timer.unref?.();
  }
  async function collect(agent) { if (!enabled || stopped) return; await start(); await recoverLedger(agent); if (!stopped) await billion.collect(agent); }
  function dispose() {
    if (disposePromise) return disposePromise; stopped = true; if (timer) clearTimeout(timer); lateController?.abort();
    disposePromise = (async () => {
      // Cancel owned startup immediately: a backend's start may wait for its child
      // until dispose interrupts it. Waiting for ready first would prevent cancellation.
      const closing = closeBackends();
      await Promise.allSettled([ready, lateRunning, closing]);
      await closing; ledger.clear(); scopes.clear(); currentScopes.clear();
    })(); return disposePromise;
  }
  return { ingress, start, prepare, completed, remember, collect, dispose,
    authorize(sessionId, scope) { if (scope) currentScopes.set(sessionId, structuredClone(scope)); else currentScopes.delete(sessionId); },
    block(sessionId) { currentScopes.delete(sessionId); },
    status: () => ({ enabled, active: !stopped, lastError, lateClassified,
      fish: fish?.status(), billion: billion?.status(), ingress: ingress.status() }) };
}
