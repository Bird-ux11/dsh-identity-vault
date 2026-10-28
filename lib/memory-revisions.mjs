import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isExpiredEvent, RETENTION_MS } from './event-retention.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export function eventRevisionHash(store, event) {
  if (!event) return null;
  if (event.contentHash) return event.contentHash;
  const projection = store.listCoreEvents({ includeRevoked: true }).find(value => value.id === event.id);
  return projection ? digest(projection) : null;
}
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
function save(file, state) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const content = JSON.stringify(state, null, 2) + '\n';
  if (Buffer.byteLength(content) > 16 * 1024 * 1024) fail('REVISION_CAPACITY', '修订队列容量已满，未覆盖现有记录。');
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const deadline = Date.now() + 1000;
    for (;;) {
      try { fs.renameSync(temp, file); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || Date.now() >= deadline) throw error;
        Atomics.wait(waitBuffer, 0, 0, 10);
      }
    }
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

/** Host-only, synchronous write-ahead queue. The event is blocked before any
 * cross-store mutation. Completed receipts retain hashes, never old summaries.
 * A queued replacement expires at the original Skill cutoff. */
export function createMemoryRevisions({ store, topicStore, root = store?.root, reconcile = () => {},
  onChange = () => {}, onError = () => {}, now = Date.now, autoStart = true,
  retryMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!store || !topicStore || !root) fail('INVALID_ARGUMENT', '修订器需要身份库和事件库。');
  const directory = path.join(root, 'revisions'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'event-queue.json');
  let state = { version: 1, pending: [], receipts: [] }, disposed = false, timer = null;
  let failures = 0, successfulRuns = 0, lastErrorCode = null;
  if (fs.existsSync(file)) {
    try {
      if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error();
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.pending) || !Array.isArray(state.receipts)
        || state.pending.length > 32 || state.pending.some(item => !safeId(item.request?.revisionId)
          || digest(item.request) !== item.hash || !/^[a-f0-9]{64}$/.test(item.request.eventId)
          || !['replace', 'retract'].includes(item.request.action))) throw new Error();
    } catch { fail('REVISION_QUEUE_CORRUPT', '修订队列损坏，未恢复旧记忆或覆盖队列。'); }
  }
  const stats = () => ({ version: 1, pending: state.pending.length, completed: state.receipts.length,
    successfulRuns, failedRuns: failures, lastErrorCode, pendingRetry: state.pending.length > 0, disposed });
  const pendingEvent = eventId => eventId === undefined ? state.pending.length > 0 : state.pending.some(item => item.request.eventId === eventId);
  function schedule() {
    if (disposed || timer || !state.pending.length) return;
    timer = setTimer(() => { timer = null; try { retry(); } catch {} }, retryMs); timer?.unref?.();
  }
  function commit(next) { save(file, next); state = next; }
  function pruneExpired() {
    let changed = false;
    const pending = state.pending.map(item => {
      const event = topicStore.getEvent(item.request.eventId);
      if (item.request.action !== 'replace' || item.expiredReplacement || !(event && (event.status === 'forgotten' || isExpiredEvent(event, now()))
        || (Number.isFinite(item.expiresAt) && item.expiresAt <= now()))) return item;
      changed = true;
      const { body: _body, ...request } = item.request;
      return { ...item, request, hash: digest(request), clientHash: item.clientHash ?? item.hash, expiredReplacement: true };
    });
    if (changed) commit({ ...state, pending });
  }
  function apply(item) {
    pruneExpired();
    item = state.pending.find(value => value.request.revisionId === item.request.revisionId) ?? item;
    const request = item.request;
    store.invalidateEvent({ eventId: request.eventId, revisionId: request.revisionId,
      actor: 'owner', operation: `event-${request.action}`, at: request.at, sourceRefs: item.sourceRefs });
    const event = topicStore.getEvent(request.eventId);
    // Expired bodies are never recreated, even if a replacement was queued
    // before the cutoff. Revoking an enduring MCP projection remains possible.
    const expired = item.expiredReplacement || event && (event.status === 'forgotten' || isExpiredEvent(event, now()));
    let result = { event, alreadyApplied: false };
    if (event && !expired) result = topicStore.applyEventCorrection(request);
    reconcile();
    const receipt = { revisionId: request.revisionId, eventId: request.eventId, action: request.action,
      at: request.at, hash: item.clientHash ?? item.hash, expiredReplacementDiscarded: Boolean(expired && request.action === 'replace') };
    commit({ ...state, pending: state.pending.filter(value => value.request.revisionId !== request.revisionId),
      receipts: [...state.receipts, receipt] });
    onChange();
    return { ok: true, ...receipt, event: result.event, alreadyApplied: result.alreadyApplied };
  }
  function retry() {
    if (disposed) fail('REVISION_DISPOSED', '修订器已停止。');
    let changed = 0, firstError;
    for (const item of [...state.pending]) {
      try { apply(item); changed++; }
      catch (error) { firstError ??= error; failures++; lastErrorCode = error.code || 'REVISION_FAILED'; try { onError(error); } catch {} }
    }
    if (!firstError) { successfulRuns++; lastErrorCode = null; }
    schedule();
    if (firstError) throw firstError;
    return { ...stats(), changed };
  }
  function correctEvent(args) {
    if (disposed) fail('REVISION_DISPOSED', '修订器已停止。');
    const { revisionId = randomUUID(), eventId, expectedContentHash, action, body } = args ?? {};
    if (!safeId(revisionId) || !/^[a-f0-9]{64}$/.test(eventId) || !/^[a-f0-9]{64}$/.test(expectedContentHash)
      || !['replace', 'retract'].includes(action) || (action === 'retract' && body !== undefined)) fail('INVALID_ARGUMENT', '无效的事件修订请求。');
    const existing = state.pending.find(item => item.request.revisionId === revisionId);
    const done = state.receipts.find(item => item.revisionId === revisionId);
    const at = existing?.request.at ?? done?.at ?? new Date(now()).toISOString();
    let request = { revisionId, eventId, expectedContentHash, action, ...(body === undefined ? {} : { body }), at };
    const hash = digest(request);
    if (done) {
      if (done.hash !== hash) fail('REVISION_CONFLICT', '同一修订ID不能表示不同内容。');
      return { ok: true, ...copy(done), alreadyApplied: true };
    }
    if (existing) {
      if ((existing.clientHash ?? existing.hash) !== hash) fail('REVISION_CONFLICT', '同一修订ID不能表示不同内容。');
    } else {
      if (pendingEvent(eventId)) fail('REVISION_PENDING', '该事件已有待完成修订，请先等待恢复。');
      if (state.pending.length >= 32) fail('REVISION_CAPACITY', '修订队列已满。');
      const event = topicStore.getEvent(eventId);
      if (!event) fail('EVENT_NOT_FOUND', '未找到事件元数据。');
      if (eventRevisionHash(store, event) !== expectedContentHash) fail('REVISION_CONFLICT', '事件已变化，请重新读取后修订。');
      if (action === 'retract' && (event.status === 'forgotten' || isExpiredEvent(event, now()))) {
        if (!(store.listCoreEvents({ includeRevoked: true }).some(value => value.id === eventId))) fail('EVENT_FORGOTTEN', '该普通事件已淡忘，且无长期投影需要撤回。');
      } else {
        request = topicStore.prepareEventCorrection(request);
      }
      const sourceRefs = new Map();
      for (const participant of event.participants ?? []) {
        const identity = store.getIdentity({ id: participant.personId, includePrivate: true });
        const selfIds = (identity?.events ?? []).filter(value => value.speaker === 'self' && event.selfEventIds?.includes(value.eventId)
          && value.scope.kind === participant.scope.kind && value.scope.groupId === participant.scope.groupId
          && value.scope.qqId === participant.scope.qqId).map(value => value.eventId);
        const sources = store.getDialogueEvents({ scope: participant.scope, sourceEventIds: [...new Set([...participant.sourceEventIds, ...selfIds])] });
        for (const value of sources) {
          const ref = { authorId: value.authorId, eventId: value.eventId, scope: value.scope.kind === 'qq-group'
            ? { kind: 'qq-group', groupId: value.scope.groupId } : value.scope };
          sourceRefs.set(JSON.stringify(ref), ref);
        }
      }
      const prepared = { request, hash: digest(request), clientHash: hash, expiresAt: Date.parse(event.time) + RETENTION_MS, sourceRefs: [...sourceRefs.values()] };
      commit({ ...state, pending: [...state.pending, prepared] });
      // Invalidate model-facing caches immediately, including on partial failure.
      onChange();
    }
    try { const result = apply(existing ?? state.pending.find(item => item.request.revisionId === revisionId)); successfulRuns++; lastErrorCode = null; return result; }
    catch (error) { failures++; lastErrorCode = error.code || 'REVISION_FAILED'; schedule(); try { onError(error); } catch {}
      return { ok: false, pending: true, revisionId, eventId, code: lastErrorCode,
        message: '修订已进入持久队列；该事件暂不召回，写入成功后才视为完成。' }; }
  }
  if (autoStart) queueMicrotask(() => { if (!disposed) try { retry(); } catch {} });
  return { correctEvent, retry, pruneExpired, pendingEvent, stats, receipts: () => copy(state.receipts),
    dispose() { disposed = true; if (timer) clearTimer(timer); timer = null; } };
}
