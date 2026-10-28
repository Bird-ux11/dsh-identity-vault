import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RETENTION_MS } from './event-retention.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const short = (value, limit = 512) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const backends = new Set(['fish', 'billion']);
const chat = scope => scope?.kind === 'local-owner' ? 'owner' : scope?.kind === 'qq-direct' && /^[1-9]\d{4,19}$/.test(scope.qqId)
  ? `direct:${scope.qqId}` : scope?.kind === 'qq-group' && /^[1-9]\d{4,19}$/.test(scope.groupId) ? `group:${scope.groupId}` : null;
const pauseBuffer = new Int32Array(new SharedArrayBuffer(4));
const fields = new Set(['occupation', 'longTermStatus', 'speakingStyle', 'characterStyle']);
const ownKeys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
function validScope(scope) {
  if (!chat(scope)) return false;
  if (scope.kind === 'local-owner') return ownKeys(scope, ['kind']);
  if (scope.kind === 'qq-direct') return ownKeys(scope, ['kind', 'qqId']);
  return ownKeys(scope, ['kind', 'groupId', 'qqId', 'qqIds'])
    && (scope.qqId === undefined || (typeof scope.qqId === 'string' && /^[1-9]\d{4,19}$/.test(scope.qqId)))
    && (scope.qqIds === undefined || (Array.isArray(scope.qqIds) && scope.qqIds.length > 0 && scope.qqIds.length <= 128
      && scope.qqIds.every(id => typeof id === 'string' && /^[1-9]\d{4,19}$/.test(id)) && new Set(scope.qqIds).size === scope.qqIds.length));
}
function validateDecision(decision, record) {
  if (!Array.isArray(decision) || decision.length > 4) fail('INVALID_DECISION', 'Classification must contain at most four important projections.');
  const evidence = new Map(record.evidence.map(item => [item.id, item])), events = new Set();
  return decision.map(item => {
    if (!ownKeys(item, ['eventId', 'scope', 'time', 'changes']) || !/^[a-f0-9]{64}$/.test(item.eventId) || events.has(item.eventId)
      || !validScope(item.scope) || chat(item.scope) !== chat(record.scope) || !iso(item.time) || item.time > record.at
      || !Array.isArray(item.changes) || item.changes.length > 64) fail('INVALID_DECISION', 'Invalid important projection envelope.');
    events.add(item.eventId); const slots = new Set();
    const changes = item.changes.map(change => {
      if (!ownKeys(change, ['personId', 'field', 'operation', 'value', 'sourceEventIds', 'at']) || !short(change.personId)
        || !fields.has(change.field) || !['set', 'clear'].includes(change.operation)
        || !Array.isArray(change.sourceEventIds) || !change.sourceEventIds.length || change.sourceEventIds.length > 300
        || new Set(change.sourceEventIds).size !== change.sourceEventIds.length || change.sourceEventIds.some(id => !evidence.has(id))) fail('INVALID_DECISION', 'Important changes require bounded, real source IDs.');
      if (change.operation === 'set' ? typeof change.value !== 'string' || !change.value.trim() || change.value.length > 500 || change.value.includes('\0')
        : change.value !== undefined && change.value !== '') fail('INVALID_DECISION', 'Invalid enduring state value.');
      const sources = change.sourceEventIds.map(id => evidence.get(id)), author = change.personId === 'self' ? 'owner' : change.personId;
      if (sources.some(source => source.speaker !== 'person' || source.personId !== author)) fail('INVALID_DECISION', 'Important facts require the actual subject, or owner for DSH self.');
      const at = sources.map(source => source.at).sort().at(-1), slot = `${change.personId}:${change.field}`;
      if (at > item.time || (change.at !== undefined && change.at !== at) || slots.has(slot)) fail('INVALID_DECISION', 'Important change time or field is ambiguous.');
      slots.add(slot);
      return { personId: change.personId, field: change.field, operation: change.operation,
        ...(change.operation === 'set' ? { value: change.value } : {}), sourceEventIds: [...change.sourceEventIds], at };
    });
    return { eventId: item.eventId, scope: structuredClone(item.scope), time: item.time, changes };
  });
}
const importantPending = record => !record.classifiedAt && record.decision?.some(item => item.changes.length);
const inputRecord = record => ({ id: record.id, backend: record.backend, sourceKey: record.sourceKey, sessionId: record.sessionId,
  scope: record.scope, at: record.at, evidence: record.evidence, candidates: record.candidates });

/** Backend text is a suggestion, never an authority, instruction or profile.
 * The parent supplies the source ledger; backends cannot assign identities. */
export function validateBackendCandidates(candidates, messages) {
  if (!Array.isArray(candidates) || candidates.length > 64 || !Array.isArray(messages)) fail('INVALID_CANDIDATES', 'Invalid backend candidate batch.');
  if (messages.length > 300 || new Set(messages.map(item => item?.id)).size !== messages.length || messages.some(item => !plain(item) || !short(item.id) || !short(item.personId) || !iso(item.at) || !['person', 'self'].includes(item.speaker) || (item.speaker === 'self') !== (item.personId === 'self'))) fail('INVALID_EVIDENCE', 'Invalid public source ledger.');
  const sources = new Map(messages.map(message => [message.id, message]));
  let total = 0;
  return candidates.map(candidate => {
    if (!plain(candidate) || Object.keys(candidate).some(key => !['backend', 'subjectId', 'text', 'category', 'sourceMessageIds', 'at'].includes(key))
      || !backends.has(candidate.backend) || typeof candidate.text !== 'string' || !candidate.text.trim() || candidate.text.length > 4000 || candidate.text.includes('\0')
      || !short(candidate.category, 80) || !Array.isArray(candidate.sourceMessageIds) || !candidate.sourceMessageIds.length || candidate.sourceMessageIds.length > 300
      || new Set(candidate.sourceMessageIds).size !== candidate.sourceMessageIds.length || candidate.sourceMessageIds.some(id => !sources.has(id))) fail('INVALID_CANDIDATES', 'Backend candidate lacks verified sources.');
    const evidence = candidate.sourceMessageIds.map(id => sources.get(id));
    if (evidence.some(source => !iso(source.at) || !['person', 'self'].includes(source.speaker) || !short(source.personId))) fail('INVALID_EVIDENCE', 'Candidate source ledger is invalid.');
    if (candidate.subjectId !== undefined && (!short(candidate.subjectId) || evidence.some(source => source.personId !== candidate.subjectId))) fail('INVALID_EVIDENCE', 'A subject candidate must only cite that subject.');
    const at = evidence.map(source => source.at).sort().at(-1);
    if (candidate.at !== undefined && candidate.at !== at) fail('INVALID_EVIDENCE', 'Candidate time must be its real source time.');
    total += candidate.text.length;
    if (total > 32000) fail('INPUT_TOO_LARGE', 'Backend candidates exceed the bounded classification budget.');
    return { backend: candidate.backend, ...(candidate.subjectId === undefined ? {} : { subjectId: candidate.subjectId }),
      text: candidate.text.trim(), category: candidate.category, sourceMessageIds: [...candidate.sourceMessageIds], at };
  });
}

/** A bounded, temporary inbox for first-layer results. It cannot write a core
 * profile, publish a Skill, or inject a prompt. Only the topic classifier can. */
export class MemoryIngress {
  constructor({ root, now = Date.now } = {}) {
    if (!path.isAbsolute(root ?? '') || typeof now !== 'function') fail('INVALID_ARGUMENT', 'Ingress needs an absolute data directory.');
    this.root = root; this.file = path.join(root, 'backend-candidates.json'); this.lock = this.file + '.lock'; this.now = now;
    fs.mkdirSync(root, { recursive: true });
    this.counts = { accepted: 0, reused: 0 };
  }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, records: [] };
    let state;
    try {
      const stat = fs.lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) fail('STORE_CORRUPT', 'Candidate inbox is not a bounded regular file.');
      state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch { fail('STORE_CORRUPT', 'Candidate inbox is unreadable; it was preserved.'); }
    if (state?.version !== 1 || Object.keys(state).some(key => !['version', 'records', 'stats'].includes(key)) || !Array.isArray(state.records) || state.records.length > 1000) fail('STORE_CORRUPT', 'Candidate inbox has invalid metadata.');
    if (state.stats !== undefined && (!ownKeys(state.stats, ['expired', 'expiredUnclassified', 'revoked'])
      || !['expired', 'expiredUnclassified'].every(key => Number.isSafeInteger(state.stats[key]) && state.stats[key] >= 0)
      || (state.stats.revoked !== undefined && (!Number.isSafeInteger(state.stats.revoked) || state.stats.revoked < 0)))) fail('STORE_CORRUPT', 'Candidate expiration counts are invalid.');
    const ids = new Set();
    for (const record of state.records) {
      if (!ownKeys(record, ['id', 'backend', 'sourceKey', 'sessionId', 'scope', 'at', 'evidence', 'candidates', 'classifiedAt', 'decision', 'inputHash', 'compacted', 'classificationJobId', 'revokedAt', 'revocationCode'])
        || !/^[a-f0-9]{64}$/.test(record.id) || ids.has(record.id) || !short(record.sessionId) || !short(record.sourceKey, 1024)
        || !backends.has(record.backend) || !validScope(record.scope) || !iso(record.at) || !Array.isArray(record.candidates) || record.candidates.length > 64
        || !Array.isArray(record.evidence) || !record.evidence.length || record.evidence.length > 300 || record.evidence.some(item => !short(item.id) || !short(item.personId) || !iso(item.at) || !['person', 'self'].includes(item.speaker))
        || (record.classifiedAt !== undefined && !iso(record.classifiedAt)) || (record.compacted !== undefined && record.compacted !== true)
        || (record.classificationJobId !== undefined && (!short(record.classificationJobId) || record.decision !== undefined))
        || (record.inputHash !== undefined && !/^[a-f0-9]{64}$/.test(record.inputHash))) fail('STORE_CORRUPT', 'Candidate inbox contains invalid provenance.');
      if ((record.revokedAt !== undefined || record.revocationCode !== undefined) && (!iso(record.revokedAt) || record.revocationCode !== 'MEMORY_REVOKED'
        || record.classifiedAt !== record.revokedAt || record.candidates.length || record.decision !== undefined || record.compacted !== undefined || !record.inputHash)) fail('STORE_CORRUPT', 'Revoked candidates must contain metadata only.');
      try {
        validateBackendCandidates(record.candidates, record.evidence);
        if (record.candidates.some(candidate => candidate.backend !== record.backend)) fail('INVALID_CANDIDATES', 'Mixed backend record.');
        if (record.decision !== undefined) validateDecision(record.decision, record);
      } catch { fail('STORE_CORRUPT', 'Candidate inbox evidence or classification differs from its body.'); }
      if (record.at !== record.evidence.map(item => item.at).sort().at(-1)
        || (record.compacted && (!record.decision?.some(item => item.changes.length) || record.candidates.length || !record.inputHash))
        || (!record.compacted && !record.revokedAt && record.inputHash && record.inputHash !== hash(inputRecord(record)))) fail('STORE_CORRUPT', 'Candidate source times or committed payload hash changed.');
      if (record.id !== hash([record.backend, record.sessionId, record.sourceKey])) fail('STORE_CORRUPT', 'Candidate inbox key was changed.');
      ids.add(record.id);
    }
    return state;
  }
  transaction(change) {
    let lock;
    try { lock = fs.openSync(this.lock, 'wx'); } catch (error) { if (error.code === 'EEXIST') fail('STORE_LOCKED', 'Candidate inbox is busy.'); throw error; }
    let temporary;
    try {
      const state = this.read(), before = JSON.stringify(state), result = change(state), after = JSON.stringify(state);
      if (after !== before) {
        if (Buffer.byteLength(after) > 8 * 1024 * 1024) fail('INPUT_TOO_LARGE', 'Candidate inbox reached its storage budget.');
        temporary = this.file + '.' + randomUUID() + '.tmp';
        const handle = fs.openSync(temporary, 'wx');
        try { fs.writeFileSync(handle, after); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
        const deadline = Date.now() + 500;
        for (;;) {
          try { fs.renameSync(temporary, this.file); temporary = null; break; }
          catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) fail('STORE_WRITE_FAILED', 'Candidate inbox commit failed.'); Atomics.wait(pauseBuffer, 0, 0, 10); }
        }
      }
      return result;
    } finally {
      if (temporary) try { fs.unlinkSync(temporary); } catch {}
      fs.closeSync(lock); fs.unlinkSync(this.lock);
    }
  }
  submit({ backend, sourceKey, sessionId, scope, candidates, messages } = {}) {
    if (!backends.has(backend) || !short(sourceKey, 1024) || !short(sessionId) || !validScope(scope)) fail('INVALID_ARGUMENT', 'Candidate envelope must come from a trusted session.');
    const clean = validateBackendCandidates(candidates, messages);
    if (clean.some(candidate => candidate.backend !== backend)) fail('INVALID_CANDIDATES', 'Backend envelope does not match its candidates.');
    const ids = new Set(clean.flatMap(candidate => candidate.sourceMessageIds));
    // Empty extraction is also durable: retrying classification need not spend
    // a second fish-model call just because the first result had no candidates.
    const evidence = messages.filter(message => ids.size ? ids.has(message.id) : true).map(({ id, speaker, personId, at }) => ({ id, speaker, personId, at }));
    if (!evidence.length || evidence.length > 300 || evidence.some(item => !iso(item.at))) fail('INVALID_EVIDENCE', 'Candidate envelope needs timestamped public evidence.');
    const at = evidence.map(item => item.at).sort().at(-1), id = hash([backend, sessionId, sourceKey]);
    if (this.now() - Date.parse(at) >= RETENTION_MS) fail('EVENT_FORGOTTEN', 'Expired evidence cannot create new backend candidates.');
    const record = { id, backend, sourceKey, sessionId, scope: structuredClone(scope), at, evidence, candidates: clean };
    record.inputHash = hash(inputRecord(record));
    return this.transaction(state => {
      const old = state.records.find(item => item.id === id);
      if (old) {
        if (old.revokedAt) { this.counts.reused++; return { id, alreadyAccepted: true, revoked: true }; }
        if ((old.inputHash ?? hash(inputRecord(old))) !== record.inputHash) fail('EVENT_CONFLICT', 'A backend result key already identifies different evidence.');
        this.counts.reused++; return { id, alreadyAccepted: true };
      }
      this.#pruneState(state);
      if (state.records.length >= 1000) fail('INPUT_TOO_LARGE', 'Candidate inbox is full; result must be retried.');
      state.records.push(record); this.counts.accepted++; return { id, alreadyAccepted: false };
    });
  }
  has(backend, sessionId, sourceKey) { return this.read().records.some(record => record.id === hash([backend, sessionId, sourceKey]) && (this.now() - Date.parse(record.at) < RETENTION_MS || importantPending(record))); }
  selectedForJob(job, messages) {
    validateBackendCandidates([], messages);
    const sources = new Map(messages.map(message => [message.id, message])), selected = new Map(), recordIds = []; let size = 0;
    const records = this.read().records.filter(record => !record.classifiedAt && record.decision === undefined
      && (record.classificationJobId === undefined || record.classificationJobId === job.id)
      && record.sessionId === job.sessionId && chat(record.scope) === chat(job.scope) && this.now() - Date.parse(record.at) < RETENTION_MS
      && record.evidence.every(item => { const source = sources.get(item.id); return source && source.personId === item.personId && source.speaker === item.speaker && source.at === item.at; }));
    for (const record of records) {
      const additions = new Map(record.candidates.map(candidate => [hash(candidate), candidate]));
      for (const key of selected.keys()) additions.delete(key);
      const extra = [...additions.values()].reduce((total, candidate) => total + candidate.text.length, 0);
      if (selected.size + additions.size > 64 || size + extra > 32000) continue;
      for (const [key, candidate] of additions) selected.set(key, candidate); size += extra; recordIds.push(record.id);
    }
    return { recordIds, candidates: validateBackendCandidates([...selected.values()], messages) };
  }
  forJob(job, messages) { return this.selectedForJob(job, messages).candidates; }
  /** Persist the exact whole-record selection before a normal topic calls its
   * classifier. Replay may finish this receipt without classifying it again. */
  bindToJob(jobId, recordIds) {
    if (!short(jobId) || !Array.isArray(recordIds) || recordIds.length > 1000
      || new Set(recordIds).size !== recordIds.length || recordIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) fail('INVALID_ARGUMENT', 'A classification binding requires a job and distinct candidate IDs.');
    return this.transaction(state => {
      const records = recordIds.map(id => {
        const record = state.records.find(item => item.id === id);
        if (!record) fail('NOT_FOUND', 'Candidate no longer exists.');
        if (record.classificationJobId !== undefined) {
          if (record.classificationJobId !== jobId) fail('EVENT_CONFLICT', 'Another topic owns this classification.');
          return record;
        }
        if (record.classifiedAt || record.decision !== undefined) fail('ALREADY_CLASSIFIED', 'This candidate already has a classification.');
        if (this.now() - Date.parse(record.at) >= RETENTION_MS) fail('EVENT_FORGOTTEN', 'Expired candidates cannot start a new classification.');
        return record;
      });
      for (const record of records) record.classificationJobId = jobId;
      return [...recordIds];
    });
  }
  boundToJob(jobId) {
    if (!short(jobId)) fail('INVALID_ARGUMENT', 'A classification binding requires a job ID.');
    return this.read().records.filter(record => record.classificationJobId === jobId).map(record => record.id);
  }
  pending() { return this.read().records.filter(record => !record.classifiedAt && (this.now() - Date.parse(record.at) < RETENTION_MS || importantPending(record))); }
  saveDecision(id, decision) { return this.transaction(state => {
    const record = state.records.find(item => item.id === id); if (!record) fail('NOT_FOUND', 'Candidate no longer exists.');
    if (record.revokedAt) fail('MEMORY_REVOKED', 'Revoked backend candidates cannot be classified again.');
    if (record.classificationJobId !== undefined) fail('EVENT_CONFLICT', 'The bound topic owns this classification.');
    if (record.classifiedAt && record.decision === undefined) fail('ALREADY_CLASSIFIED', 'A completed topic already classified these candidates.');
    const clean = validateDecision(decision, record);
    if (record.decision !== undefined && JSON.stringify(validateDecision(record.decision, record)) !== JSON.stringify(clean)) fail('EVENT_CONFLICT', 'Classification is already durable.');
    if (record.decision === undefined && this.now() - Date.parse(record.at) >= RETENTION_MS) fail('EVENT_FORGOTTEN', 'Unknown expired candidates cannot start a new classification.');
    record.decision = clean;
  }); }
  classified(id) { return this.transaction(state => { const record = state.records.find(item => item.id === id); if (record && !record.classifiedAt) record.classifiedAt = new Date(this.now()).toISOString(); }); }
  /** Terminal receipt for corrected evidence. Keep only provenance and a digest,
   * so retries cannot restore candidate text or a rejected durable projection. */
  revoke(id) { return this.transaction(state => {
    const record = state.records.find(item => item.id === id); if (!record || record.revokedAt) return false;
    record.inputHash ??= hash(inputRecord(record));
    record.revokedAt = new Date(this.now()).toISOString(); record.classifiedAt = record.revokedAt; record.revocationCode = 'MEMORY_REVOKED';
    record.candidates = []; delete record.decision; delete record.compacted;
    state.stats ??= { expired: 0, expiredUnclassified: 0 }; state.stats.revoked = (state.stats.revoked ?? 0) + 1;
    return true;
  }); }
  completeJob(job, messages) {
    const ids = new Set(this.selectedForJob(job, messages).recordIds);
    return this.transaction(state => { for (const record of state.records) if (ids.has(record.id)) record.classifiedAt ||= new Date(this.now()).toISOString(); });
  }
  #pruneState(state) {
    const kept = []; let removed = 0, unclassified = 0;
    for (const record of state.records) {
      if (this.now() - Date.parse(record.at) < RETENTION_MS) { kept.push(record); continue; }
      if (importantPending(record)) {
        // The durable classification is all a write retry needs. Discard the
        // casual backend text at its normal deadline, keep only facts+provenance.
        record.inputHash ??= hash(inputRecord(record)); record.candidates = []; record.compacted = true; kept.push(record); continue;
      }
      removed++; if (!record.classifiedAt && record.decision === undefined) unclassified++;
    }
    if (removed) { state.stats ??= { expired: 0, expiredUnclassified: 0 }; state.stats.expired += removed; state.stats.expiredUnclassified += unclassified; }
    state.records = kept; return removed;
  }
  prune() { return this.transaction(state => this.#pruneState(state)); }
  status() { const state = this.read(), records = state.records; return { ...this.counts, expired: state.stats?.expired ?? 0,
    revokedBatches: state.stats?.revoked ?? 0,
    expiredUnclassified: state.stats?.expiredUnclassified ?? 0, pendingImportantProjections: records.filter(importantPending).length,
    pendingCandidateBatches: records.filter(item => !item.classifiedAt).length, classifiedBatches: records.filter(item => item.classifiedAt).length,
    fishBatches: records.filter(record => record.backend === 'fish').length, billionBatches: records.filter(record => record.backend === 'billion').length }; }
}
