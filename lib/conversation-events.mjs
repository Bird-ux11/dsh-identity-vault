import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const CONVERSATION_IDLE_MS = 10 * 60 * 1000;
const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const clone = value => structuredClone(value);
const chatKey = scope => scope.kind === 'qq-group' ? `group:${scope.groupId}` : scope.kind === 'qq-direct' ? `direct:${scope.qqId}` : 'owner';
const iso = value => { const n = typeof value === 'number' ? value : Date.parse(value); if (!Number.isFinite(n)) fail('INVALID_ARGUMENT', 'Invalid event time.'); return new Date(n).toISOString(); };
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const episodeKey = (sessionId, scope) => JSON.stringify([sessionId, chatKey(scope)]);
const sourceKey = turn => JSON.stringify([turn.sessionId, chatKey(turn.scope), turn.turnId]);
const fingerprint = turn => hash({ ...turn, participants: turn.participants.map(({ personId, ...person }) => person) });
const closingReasons = new Set(['explicit', 'topic', 'capacity', 'idle']);
function validateScope(scope) {
  const qq = id => typeof id === 'string' && /^[1-9]\d{4,19}$/.test(id);
  if (!scope || !['local-owner', 'qq-direct', 'qq-group'].includes(scope.kind)) fail('INVALID_SCOPE', 'Unknown conversation scope.');
  if (scope.kind === 'local-owner' && !exactKeys(scope, ['kind'])) fail('INVALID_SCOPE', 'Owner scope is invalid.');
  if (scope.kind === 'qq-direct' && (!exactKeys(scope, ['kind', 'qqId']) || !qq(scope.qqId))) fail('INVALID_SCOPE', 'Direct scope is invalid.');
  if (scope.kind === 'qq-group' && (!exactKeys(scope, ['kind', 'groupId', 'qqIds']) || !qq(scope.groupId)
    || !Array.isArray(scope.qqIds) || !scope.qqIds.length || scope.qqIds.length > 8 || new Set(scope.qqIds).size !== scope.qqIds.length || scope.qqIds.some(id => !qq(id)))) fail('INVALID_SCOPE', 'Group scope is invalid.');
  return scope;
}
function normalizeTurn(value) {
  if (!exactKeys(value, ['scope', 'sessionId', 'turnId', 'participants', 'selfEventIds', 'at', 'modelSelection'])
    || !textId(value.sessionId) || typeof value.turnId !== 'string' || !/^(0|[1-9]\d*)$/.test(value.turnId) || !Number.isSafeInteger(Number(value.turnId))
    || !Array.isArray(value.participants) || !value.participants.length || value.participants.length > 8
    || !Array.isArray(value.selfEventIds) || !value.selfEventIds.length || value.selfEventIds.length > 300) fail('INVALID_ARGUMENT', 'A completed, attributed conversation turn is required.');
  const qq = id => typeof id === 'string' && /^[1-9]\d{4,19}$/.test(id);
  const scope = validateScope(value.scope);
  if (scope.kind !== 'qq-group' && value.participants.length !== 1) fail('INVALID_SCOPE', 'A private conversation has exactly one participant.');
  const ids = new Set(), people = new Set();
  for (const person of value.participants) {
    if (!exactKeys(person, ['personId', 'scope', 'sourceEventIds']) || !textId(person.personId) || people.has(person.personId)
      || !exactKeys(person.scope, ['kind', 'groupId', 'qqId']) || person.scope.kind !== scope.kind || chatKey(person.scope) !== chatKey(scope)
      || (scope.kind !== 'local-owner' && !qq(person.scope.qqId)) || !Array.isArray(person.sourceEventIds) || !person.sourceEventIds.length) fail('INVALID_EVIDENCE', 'Conversation participant is invalid.');
    if (scope.kind === 'local-owner' && (!exactKeys(person.scope, ['kind']) || person.personId !== 'owner')) fail('INVALID_EVIDENCE', 'Local-owner evidence must belong to the owner.');
    if (scope.kind === 'qq-direct' && !exactKeys(person.scope, ['kind', 'qqId'])) fail('INVALID_EVIDENCE', 'Direct evidence cannot carry group metadata.');
    people.add(person.personId);
    for (const id of person.sourceEventIds) {
      if (!textId(id) || !id.startsWith('user:') || ids.has(id)) fail('INVALID_EVIDENCE', 'Conversation user evidence is invalid.'); ids.add(id);
    }
  }
  if (scope.kind === 'qq-group' && JSON.stringify([...new Set(scope.qqIds)].sort()) !== JSON.stringify(value.participants.map(person => person.scope.qqId).sort())) fail('INVALID_SCOPE', 'Group participants do not match the conversation.');
  for (const id of value.selfEventIds) { if (!textId(id) || !id.startsWith('assistant:') || ids.has(id)) fail('INVALID_EVIDENCE', 'Conversation self evidence is invalid.'); ids.add(id); }
  if (ids.size > 300) fail('INPUT_TOO_LARGE', 'One completed turn exceeds the event evidence limit.');
  if (value.modelSelection !== undefined && (!exactKeys(value.modelSelection, ['provider', 'model']) || !textId(value.modelSelection.provider) || !textId(value.modelSelection.model))) fail('INVALID_ARGUMENT', 'Invalid model selection.');
  return { ...clone(value), at: iso(value.at) };
}

function validateEpisode(episode) {
  if (!exactKeys(episode, ['id', 'key', 'sessionId', 'status', 'lastActivityAt', 'turns', 'reason', 'publication'])
    || !/^[a-f0-9]{64}$/.test(episode.id) || !textId(episode.sessionId) || !['open', 'closing'].includes(episode.status)
    || !Array.isArray(episode.turns) || !episode.turns.length || episode.turns.length > 150 || iso(episode.lastActivityAt) !== episode.lastActivityAt
    || (episode.status === 'open' && (episode.reason !== undefined || episode.publication !== undefined))
    || (episode.status === 'closing' && !closingReasons.has(episode.reason))) fail('CONVERSATION_CORRUPT', 'Conversation episode is invalid.');
  const sources = new Set(), people = new Set(); let previous = -1;
  for (const item of episode.turns) {
    const turn = normalizeTurn(item);
    if (JSON.stringify(turn) !== JSON.stringify(item) || episode.sessionId !== turn.sessionId || episode.key !== episodeKey(turn.sessionId, turn.scope)
      || Number(turn.turnId) <= previous) fail('CONVERSATION_CORRUPT', 'Conversation episode contains inconsistent turns.');
    previous = Number(turn.turnId);
    for (const person of turn.participants) people.add(person.scope.qqId ?? 'owner');
    for (const id of [...turn.selfEventIds, ...turn.participants.flatMap(person => person.sourceEventIds)]) {
      if (sources.has(id)) fail('CONVERSATION_CORRUPT', 'Conversation evidence is repeated across turns.'); sources.add(id);
    }
  }
  if (sources.size > 300 || people.size > 8 || episode.id !== hash(['conversation-v4', episode.key, episode.turns[0].turnId])) fail('CONVERSATION_CORRUPT', 'Conversation episode bounds or id are invalid.');
  if (episode.publication !== undefined) {
    const job = episode.publication, last = episode.turns.at(-1);
    if (!exactKeys(job, ['id', 'scope', 'sessionId', 'turnId', 'participants', 'selfEventIds', 'at', 'turns', 'modelSelection'])
      || job.id !== episode.id || job.sessionId !== episode.sessionId || job.turnId !== last.turnId || job.at !== last.at || !Array.isArray(job.turns) || job.turns.length !== episode.turns.length
      || JSON.stringify(job.selfEventIds) !== JSON.stringify(episode.turns.flatMap(turn => turn.selfEventIds))) fail('CONVERSATION_CORRUPT', 'Conversation publication is invalid.');
    normalizeTurn(Object.fromEntries(Object.entries(job).filter(([key]) => !['id', 'turns'].includes(key))));
    const aggregate = new Map();
    job.turns.forEach((turn, index) => {
      if (!exactKeys(turn, ['turnId', 'participants', 'selfEventIds', 'at'])) fail('CONVERSATION_CORRUPT', 'Publication turn metadata is invalid.');
      const original = episode.turns[index];
      const scope = original.scope.kind === 'qq-group' ? { ...original.scope, qqIds: turn.participants.map(person => person.scope.qqId) } : original.scope;
      normalizeTurn({ ...turn, scope, sessionId: job.sessionId });
      const fixed = item => ({ ...item, participants: item.participants.map(({ personId, ...person }) => person) });
      if (JSON.stringify(fixed(turn)) !== JSON.stringify(fixed({ turnId: original.turnId, participants: original.participants, selfEventIds: original.selfEventIds, at: original.at }))) fail('CONVERSATION_CORRUPT', 'Publication changed original source metadata.');
      for (const person of turn.participants) {
        if (!aggregate.has(person.personId)) aggregate.set(person.personId, { personId: person.personId, scope: person.scope, sourceEventIds: [] });
        aggregate.get(person.personId).sourceEventIds.push(...person.sourceEventIds);
      }
    });
    if (JSON.stringify([...aggregate.values()]) !== JSON.stringify(job.participants) || JSON.stringify(job.modelSelection) !== JSON.stringify(last.modelSelection)) fail('CONVERSATION_CORRUPT', 'Publication aggregation differs from its source turns.');
  }
}

function validateState(state) {
  if (!exactKeys(state, ['version', 'episodes', 'processed']) || state.version !== 1 || !Array.isArray(state.episodes) || !Array.isArray(state.processed)) fail('CONVERSATION_CORRUPT', 'Conversation queue shape is invalid.');
  const ids = new Set(), openKeys = new Set(), processed = new Set();
  for (const episode of state.episodes) {
    validateEpisode(episode);
    if (ids.has(episode.id) || (episode.status === 'open' && openKeys.has(episode.key))) fail('CONVERSATION_CORRUPT', 'Duplicate conversation episode.');
    ids.add(episode.id); if (episode.status === 'open') openKeys.add(episode.key);
  }
  for (const item of state.processed) {
    if (!exactKeys(item, ['key', 'at', 'fingerprint']) || typeof item.key !== 'string' || item.key.length > 1024 || iso(item.at) !== item.at
      || !/^[a-f0-9]{64}$/.test(item.fingerprint) || processed.has(item.key)) fail('CONVERSATION_CORRUPT', 'Processed turn metadata is invalid.');
    processed.add(item.key);
  }
  for (const episode of state.episodes) for (const turn of episode.turns) if (state.processed.find(item => item.key === sourceKey(turn))?.fingerprint !== fingerprint(turn)) fail('CONVERSATION_CORRUPT', 'Conversation turn lacks matching durable deduplication metadata.');
  return state;
}

export function explicitTopicBoundary(text) {
  if (typeof text !== 'string') return null;
  // Only direct conversational closing phrases count; quoted instructions and
  // statements about the phrase itself do not automatically end an episode.
  const input = text.trim();
  if (input.length > 160 || /[“”"「」『』]|什么意思|这句话|这个词|不要|别结束/.test(input)) return null;
  if (/^(我们)?(先)?(换个话题|换一个话题|说点别的|聊点别的)[，,。.!！\s]/.test(input + ' ')) return 'before';
  if (/^(好[的吧]?[,，。\s]*)?(今天|这次|这个话题|这件事|我们)?(就|先)?(聊到这里|到此为止|先这样|到这里|结束这个话题|下次再聊|不聊了)[吧了。.!！\s]*$/.test(input)
    || /^(结束这个话题|结束这段对话|下次再聊|先这样|再见)[吧了。.!！\s]*$/.test(input)) return 'after';
  return null;
}

/** Durable references only. Completed turns are grouped until an explicit
 * boundary or ten idle minutes, then atomically handed to the topic queue. */
export class ConversationEvents {
  constructor({ root, store, onClosed, onChange = () => {}, onError = () => {}, now = () => Date.now(), autoStart = true, idleMs = CONVERSATION_IDLE_MS }) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || typeof onClosed !== 'function' || typeof now !== 'function' || !store?.getIdentity || !store?.getDialogueEvents
      || typeof onChange !== 'function' || typeof onError !== 'function' || typeof autoStart !== 'boolean' || !Number.isInteger(idleMs) || idleMs < 1 || idleMs > TEN_DAYS) fail('INVALID_ARGUMENT', 'Conversation queue requires a root, identity store and publisher.');
    this.root = root; this.file = path.join(root, 'conversations.json'); this.lock = path.join(root, 'conversations.lock');
    this.store = store; this.onClosed = onClosed; this.onChange = onChange; this.onError = onError; this.now = now;
    this.idleMs = idleMs; this.busy = new Set(); this.disposed = false; this.timer = null;
    fs.mkdirSync(root, { recursive: true });
    if (fs.lstatSync(root).isSymbolicLink()) fail('INVALID_PATH', 'Conversation directory cannot be a link.');
    this.initialized = false;
    if (!fs.existsSync(this.file)) this.transaction(() => {});
    else this.read();
    this.initialized = true;
    if (autoStart) queueMicrotask(() => { if (!this.disposed) this.runDue(); });
  }
  read() {
    if (!fs.existsSync(this.file)) {
      if (this.initialized) fail('CONVERSATION_MISSING', 'Conversation queue disappeared; no replacement was created.');
      return { version: 1, episodes: [], processed: [] };
    }
    if (fs.lstatSync(this.file).isSymbolicLink() || fs.statSync(this.file).size > 32 * 1024 * 1024) fail('CONVERSATION_CORRUPT', 'Conversation queue is invalid.');
    let state; try { state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { fail('CONVERSATION_CORRUPT', 'Conversation queue is unreadable.'); }
    try { return validateState(state); }
    catch { fail('CONVERSATION_CORRUPT', 'Conversation queue integrity validation failed; the original file was preserved.'); }
  }
  transaction(operation) {
    let fd; const deadline = Date.now() + 5000, sleep = new Int32Array(new SharedArrayBuffer(4));
    while (fd === undefined) {
      try { fd = fs.openSync(this.lock, 'wx', 0o600); }
      catch (error) { if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || Date.now() >= deadline) fail('CONVERSATION_LOCKED', 'Conversation queue is locked.'); Atomics.wait(sleep, 0, 0, 10); }
    }
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      const state = this.read(), before = JSON.stringify(state), result = operation(state);
      validateState(state);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024 * 1024) fail('CONVERSATION_FULL', 'Conversation metadata reached its storage bound.');
      if (this.initialized && serialized === before) return clone(result);
      const output = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(output, serialized); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      const until = Date.now() + 500;
      while (true) try { fs.renameSync(temp, this.file); break; }
      catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= until) throw error; Atomics.wait(sleep, 0, 0, 10); }
      return clone(result);
    } finally { try { fs.unlinkSync(temp); } catch {} fs.closeSync(fd); fs.unlinkSync(this.lock); }
  }
  assertLive() { if (this.disposed) fail('CONVERSATION_DISPOSED', 'The conversation queue is disposed.'); }
  hold(sessionId) {
    this.assertLive(); if (!textId(sessionId)) fail('INVALID_ARGUMENT', 'A session id is required.');
    // A new message after the idle threshold closes the previous conversation
    // before holding the newly active reply. Steers of an active reply do not.
    if (!this.busy.has(sessionId)) this.runDue();
    this.busy.add(sessionId); this.schedule();
  }
  release(sessionId) { this.assertLive(); if (!textId(sessionId)) fail('INVALID_ARGUMENT', 'A session id is required.'); this.busy.delete(sessionId); this.schedule(); }
  validateEvidence(turn) {
    const selfSeen = new Set(); let latestAt = null;
    for (const participant of turn.participants) {
      const identity = this.store.getIdentity({ id: participant.personId });
      const expected = participant.scope.kind === 'local-owner' ? this.store.getIdentity({ id: 'owner' }) : this.store.getIdentity({ qqId: participant.scope.qqId });
      if (!identity || identity.id !== expected?.id || identity.id === 'self') fail('INVALID_EVIDENCE', 'Conversation participant differs from the actual source identity.');
      const events = this.store.getDialogueEvents({ scope: participant.scope, sourceEventIds: [...participant.sourceEventIds, ...turn.selfEventIds] });
      for (const event of events) {
        const isSelf = turn.selfEventIds.includes(event.eventId);
        if (event.sessionId !== turn.sessionId || event.turnId !== turn.turnId || event.speaker !== (isSelf ? 'self' : 'person')) fail('INVALID_EVIDENCE', 'Conversation evidence differs from its session, turn or author.');
        const at = iso(event.at); if (!latestAt || at > latestAt) latestAt = at;
        if (isSelf) selfSeen.add(event.eventId);
      }
    }
    if (selfSeen.size !== turn.selfEventIds.length) fail('INVALID_EVIDENCE', 'Conversation self evidence is incomplete.');
    return latestAt;
  }
  appendTurn(input, { close = false } = {}) {
    this.assertLive(); if (typeof close !== 'boolean') fail('INVALID_ARGUMENT', 'The close flag must be a boolean.');
    const turn = normalizeTurn(input), now = this.now(), key = episodeKey(turn.sessionId, turn.scope);
    turn.at = this.validateEvidence(turn);
    if (now - Date.parse(turn.at) >= TEN_DAYS) return { expired: true };
    const result = this.transaction(state => {
      state.episodes = state.episodes.filter(item => now - Date.parse(item.turns.at(-1).at) < TEN_DAYS);
      const retainedKeys = new Set(state.episodes.flatMap(item => item.turns.map(sourceKey)));
      state.processed = state.processed.filter(item => now - Date.parse(item.at) < TEN_DAYS || retainedKeys.has(item.key));
      const processedKey = sourceKey(turn), previous = state.processed.find(item => item.key === processedKey);
      if (previous) { if (previous.fingerprint !== fingerprint(turn)) fail('TURN_CONFLICT', 'The same turn already has different source metadata.'); return { duplicate: true }; }
      let episode = state.episodes.find(item => item.key === key && item.status === 'open');
      if (episode && Number(episode.turns.at(-1).turnId) >= Number(turn.turnId)) fail('TURN_CONFLICT', 'Conversation turns must be in order.');
      if (episode && !this.busy.has(turn.sessionId) && now - Date.parse(episode.lastActivityAt) >= this.idleMs) { episode.status = 'closing'; episode.reason = 'idle'; episode = null; }
      const count = item => item.selfEventIds.length + item.participants.reduce((n, person) => n + person.sourceEventIds.length, 0);
      const allPeople = new Set([...(episode?.turns ?? []), turn].flatMap(item => item.participants.map(person => person.scope.qqId ?? 'owner')));
      if (episode && (episode.turns.reduce((n, item) => n + count(item), 0) + count(turn) > 300 || allPeople.size > 8)) { episode.status = 'closing'; episode.reason = 'capacity'; episode = null; }
      if (!episode) { episode = { id: hash(['conversation-v4', key, turn.turnId]), key, sessionId: turn.sessionId, status: 'open', lastActivityAt: iso(now), turns: [] }; state.episodes.push(episode); }
      episode.turns.push(turn); episode.lastActivityAt = iso(Math.min(now, Date.parse(turn.at)));
      if (close) { episode.status = 'closing'; episode.reason = 'explicit'; }
      state.processed.push({ key: processedKey, at: turn.at, fingerprint: fingerprint(turn) }); return { episodeId: episode.id, turns: episode.turns.length, closing: close };
    });
    this.publishClosing(); this.schedule(); this.onChange(); return result;
  }
  close({ sessionId, scope, reason = 'explicit' }) {
    this.assertLive(); if (!textId(sessionId) || !closingReasons.has(reason)) fail('INVALID_ARGUMENT', 'A session id and known closing reason are required.');
    // Closing identifies a chat, so group membership may be omitted here.
    if (scope?.kind === 'qq-group' && scope.qqIds === undefined) { if (!exactKeys(scope, ['kind', 'groupId']) || !/^[1-9]\d{4,19}$/.test(scope.groupId)) fail('INVALID_SCOPE', 'Invalid group scope.'); }
    else validateScope(scope);
    this.transaction(state => { for (const episode of state.episodes) if (episode.status === 'open' && episode.sessionId === sessionId && episode.key === episodeKey(sessionId, scope)) { episode.status = 'closing'; episode.reason = reason; } });
    this.publishClosing(); this.schedule(); this.onChange();
  }
  jobFor(episode) {
    const turns = episode.turns.map(turn => {
      if (this.validateEvidence(turn) !== turn.at) fail('INVALID_EVIDENCE', 'Persisted event time differs from its actual dialogue sources.');
      return { ...turn, participants: turn.participants.map(person => ({ ...person, personId: this.store.getIdentity({ id: person.personId }).id })) };
    }), last = turns.at(-1), byId = new Map();
    for (const turn of turns) for (const person of turn.participants) {
      const personId = this.store.getIdentity({ id: person.personId })?.id;
      if (!personId) fail('IDENTITY_NOT_FOUND', 'A conversation participant no longer resolves.');
      if (!byId.has(personId)) byId.set(personId, { personId, scope: person.scope, sourceEventIds: [] });
      byId.get(personId).sourceEventIds.push(...person.sourceEventIds);
    }
    const participants = [...byId.values()], scope = last.scope.kind === 'qq-group'
      ? { kind: 'qq-group', groupId: last.scope.groupId, qqIds: [...new Set(participants.map(person => person.scope.qqId))].sort() } : last.scope;
    return { id: episode.id, scope, sessionId: episode.sessionId, turnId: last.turnId, participants,
      selfEventIds: turns.flatMap(turn => turn.selfEventIds), at: last.at,
      turns: turns.map(({ turnId, participants, selfEventIds, at }) => ({ turnId, participants, selfEventIds, at })),
      ...(last.modelSelection ? { modelSelection: last.modelSelection } : {}) };
  }
  publishClosing() {
    if (this.disposed) return;
    for (const episode of this.read().episodes.filter(item => item.status === 'closing')) {
      try {
        if (this.now() - Date.parse(episode.turns.at(-1).at) < TEN_DAYS) {
          const job = this.transaction(state => {
            const current = state.episodes.find(item => item.id === episode.id);
            if (!current) return null;
            current.publication ??= this.jobFor(current);
            return current.publication;
          });
          if (!job) continue;
          for (let index = 0; index < job.turns.length; index++) if (this.validateEvidence({ ...job.turns[index], sessionId: job.sessionId, scope: episode.turns[index].scope }) !== job.turns[index].at) fail('INVALID_EVIDENCE', 'Publication time differs from its actual dialogue sources.');
          const result = this.onClosed(job, { reason: episode.reason });
          if (result && typeof result.then === 'function') fail('ASYNC_PUBLISH_UNSUPPORTED', 'Conversation publishing must commit synchronously before acknowledgement.');
        }
        this.transaction(state => { state.episodes = state.episodes.filter(item => item.id !== episode.id); });
      } catch (error) { this.onError(error); }
    }
  }
  runDue() {
    if (this.disposed) return;
    try {
      const now = this.now();
      this.transaction(state => {
        state.episodes = state.episodes.filter(item => now - Date.parse(item.turns.at(-1).at) < TEN_DAYS);
        const retainedKeys = new Set(state.episodes.flatMap(item => item.turns.map(sourceKey)));
        state.processed = state.processed.filter(item => now - Date.parse(item.at) < TEN_DAYS || retainedKeys.has(item.key));
        for (const episode of state.episodes) if (episode.status === 'open' && !this.busy.has(episode.sessionId)
          && now - Date.parse(episode.lastActivityAt) >= this.idleMs) { episode.status = 'closing'; episode.reason = 'idle'; }
      });
      this.publishClosing(); this.onChange();
    } catch (error) { this.onError(error); }
    this.schedule();
  }
  schedule() {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.disposed) return;
    let episodes;
    try { episodes = this.read().episodes.filter(item => !this.busy.has(item.sessionId)); }
    catch (error) { this.onError(error); return; }
    if (!episodes.length) return;
    const due = Math.min(...episodes.map(item => item.status === 'closing' ? this.now() + 60000 : Date.parse(item.lastActivityAt) + this.idleMs));
    this.timer = setTimeout(() => this.runDue(), Math.max(1, Math.min(60000, due - this.now()))); this.timer.unref?.();
  }
  status() { const episodes = this.read().episodes; return { pendingConversations: episodes.length, pendingTurns: episodes.reduce((n, item) => n + item.turns.length, 0), idleMinutes: this.idleMs / 60000 }; }
  dispose() { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.busy.clear(); }
}
