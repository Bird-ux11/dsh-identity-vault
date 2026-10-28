import { createHash } from 'node:crypto';
import { validateTopics } from './topic-summarizer.mjs';
import { isExpiredEvent } from './event-retention.mjs';

class SkipLegacy extends Error {
  constructor(code) { super(code); this.code = code; }
}
const skip = code => { throw new SkipLegacy(code); };
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const qq = value => typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
const sameScope = (a, b) => a?.kind === b?.kind && a?.groupId === b?.groupId && a?.qqId === b?.qqId;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function participantScope(value) {
  if (value?.kind === 'local-owner' && value.groupId === undefined && value.qqId === undefined) return { kind: 'local-owner' };
  if (value?.kind === 'qq-direct' && value.groupId === undefined && qq(value.qqId)) return { kind: 'qq-direct', qqId: value.qqId };
  if (value?.kind === 'qq-group' && qq(value.groupId) && qq(value.qqId)) return { kind: 'qq-group', groupId: value.groupId, qqId: value.qqId };
  skip('LEGACY_SCOPE_INVALID');
}

function text(value, max, required = false) {
  if (value === undefined || value === null) { if (required) skip('LEGACY_SUMMARY_MISSING'); return ''; }
  if (typeof value !== 'string' || value.includes('\0')) skip('LEGACY_TEXT_INVALID');
  const trimmed = value.trim();
  if (trimmed.length > max) skip('LEGACY_TEXT_EXCEEDS_LIMIT');
  if (required && !trimmed) skip('LEGACY_SUMMARY_MISSING');
  return trimmed;
}

function prepare(row, store) {
  const impression = row?.impression;
  if (!impression || !validId(row.personId) || !validId(impression.id)) skip('LEGACY_RECORD_INVALID');
  const scope = participantScope(impression.scope);
  const identity = store.getIdentity({ id: row.personId });
  if (!identity || identity.id === 'self' || (scope.kind === 'local-owner' ? identity.id !== 'owner' : identity.qqId !== scope.qqId)) skip('LEGACY_IDENTITY_MISMATCH');
  if (!Array.isArray(impression.sourceEventIds) || !impression.sourceEventIds.length || impression.sourceEventIds.length > 300
    || impression.sourceEventIds.some(value => !validId(value)) || new Set(impression.sourceEventIds).size !== impression.sourceEventIds.length) skip('LEGACY_SOURCE_IDS_INVALID');
  const sourceIds = [...impression.sourceEventIds].sort();
  let records;
  try { records = store.getDialogueEvents({ scope, sourceEventIds: sourceIds }); }
  catch (error) {
    if (error?.code === 'INVALID_EVIDENCE') skip('LEGACY_SOURCE_UNAVAILABLE');
    throw error;
  }
  if (!Array.isArray(records) || records.length !== sourceIds.length) skip('LEGACY_SOURCE_AMBIGUOUS');
  const seen = new Set(), personIds = [], selfIds = [];
  for (const record of records) {
    if (!sourceIds.includes(record?.eventId) || seen.has(record.eventId) || !sameScope(record.scope, scope)
      || !['person', 'self'].includes(record.speaker) || !validId(record.sourceMessageId)
      || record.eventId !== `${record.speaker === 'self' ? 'assistant' : 'user'}:${record.sourceMessageId}`) skip('LEGACY_SOURCE_UNVERIFIED');
    if (record.speaker === 'self') {
      if (record.authorId !== 'self') skip('LEGACY_AUTHOR_MISMATCH');
      selfIds.push(record.eventId);
    } else {
      if (store.getIdentity({ id: record.authorId })?.id !== identity.id) skip('LEGACY_AUTHOR_MISMATCH');
      personIds.push(record.eventId);
    }
    seen.add(record.eventId);
  }
  if (!personIds.length) skip('LEGACY_PERSON_SOURCE_MISSING');
  personIds.sort(); selfIds.sort();
  const stableOriginalId = impression.legacyId ?? impression.id;
  if (!validId(stableOriginalId)) skip('LEGACY_RECORD_INVALID');
  const legacyId = `legacy-impression:${hash([stableOriginalId, scope, sourceIds])}`;
  const topicScope = scope.kind === 'qq-group' ? { kind: scope.kind, groupId: scope.groupId, qqIds: [scope.qqId] } : scope;
  const times = records.map(record => Date.parse(record.at));
  if (times.some(time => !Number.isFinite(time))) skip('LEGACY_TIME_INVALID');
  return { impression, identity, scope, topicScope, sourceIds, records, personIds, selfIds, legacyId, time: new Date(Math.max(...times)).toISOString() };
}

// Age is checked even for unsupported legacy formatting, so an old manual
// record cannot remain available forever through the compatibility fallback.
function ageOf(row, store) {
  const impression = row?.impression;
  if (!impression) return null;
  try {
    const scope = participantScope(impression.scope);
    if (Array.isArray(impression.sourceEventIds) && impression.sourceEventIds.length) {
      const records = store.getDialogueEvents({ scope, sourceEventIds: impression.sourceEventIds });
      if (records.length === impression.sourceEventIds.length && records.every(record => Number.isFinite(Date.parse(record.at)))) {
        return new Date(Math.max(...records.map(record => Date.parse(record.at)))).toISOString();
      }
    }
  } catch (error) { if (!(error instanceof SkipLegacy) && error?.code !== 'INVALID_EVIDENCE' && error?.code !== 'INVALID_ARGUMENT' && error?.code !== 'INVALID_SCOPE') throw error; }
  const time = impression.createdAt ?? impression.updatedAt;
  return Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null;
}

function importInput(data) {
  const { impression, identity, scope, topicScope, sourceIds, records, personIds, selfIds, legacyId } = data;
  const summary = text(impression.summary, 800, true);
  const said = text(impression.otherSaid || summary, 600, true);
  // Without assistant evidence no old selfSaid assertion is promoted to a fact.
  // With evidence but no attributed summary, retain the legacy fallback instead
  // of guessing what self said or omitting covered assistant sources.
  const selfText = selfIds.length ? text(impression.selfSaid, 1000) : '';
  if (selfIds.length && !selfText) skip('LEGACY_SELF_SUMMARY_MISSING');
  const short = summary.replace(/\s+/g, ' ').split(/[。！？!?\r\n]/, 1)[0].trim() || summary;
  const title = `旧事件：${short.slice(0, 48)}`;
  const trigger = short.slice(0, 40).trim() || '旧事件';
  const body = { topic: title, importance: 0.5, triggers: [trigger], summary,
    participants: [{ personId: identity.id, said, sourceMessageIds: personIds }],
    selfSaid: { text: selfText, sourceMessageIds: selfIds },
    conclusion: { text: summary, sourceMessageIds: sourceIds }, sourceMessageIds: sourceIds };
  const messages = records.map(record => ({ id: record.eventId, speaker: record.speaker, personId: record.speaker === 'self' ? 'self' : identity.id }));
  try { validateTopics([body], { messages, personIds: [identity.id] }); }
  catch { skip('LEGACY_SCHEMA_INVALID'); }
  const time = data.time;
  // An old summary may span turns; use the explicit migration marker rather
  // than inventing one original session/turn for mixed evidence.
  const sessions = [...new Set(records.map(record => record.sessionId).filter(validId))];
  const turns = [...new Set(records.map(record => record.turnId).filter(value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))))];
  const hasOneSession = sessions.length === 1 && records.every(record => record.sessionId === sessions[0]);
  const hasOneTurn = hasOneSession && turns.length === 1 && records.every(record => record.turnId === turns[0]);
  return { id: legacyId, scope: topicScope, time: new Date(time).toISOString(), topicsBody: body,
    participants: [{ personId: identity.id, scope, sourceEventIds: personIds }], selfEventIds: selfIds,
    sessionId: hasOneSession ? sessions[0] : 'legacy-import', turnId: hasOneTurn ? turns[0] : '0' };
}

/** Copy verifiable legacy summaries into immutable topic Skills without changing
 * the old store. No model, transcript body, or guessed source is involved.
 * Unsupported old rows remain available to the host's existing fallback.
 */
export function migrateLegacyTopics({ store, topicStore, now = Date.now() } = {}) {
  if (!store?.listLegacyImpressions || !store?.getDialogueEvents || !store?.getIdentity
    || !topicStore?.importLegacy || !topicStore?.listEvents || !topicStore?.readEvent || !topicStore?.getEvent) throw new TypeError('Legacy migration requires identity and topic stores.');
  const current = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(new Date(current).getTime())) throw new TypeError('Legacy migration requires a valid current time.');
  const rows = store.listLegacyImpressions();
  const existing = new Map();
  for (const event of topicStore.listEvents({ limit: 100000 })) {
    if (!event.legacyId) continue;
    const found = existing.get(event.legacyId) ?? []; found.push(event); existing.set(event.legacyId, found);
  }
  const result = { total: rows.length, imported: 0, alreadyImported: 0, expired: 0, expiredRecords: [], skipped: 0, skipReasons: {}, skippedRecords: [], events: [] };
  const emitted = new Set();
  const append = events => { for (const event of events) if (!emitted.has(event.id)) { emitted.add(event.id); result.events.push(event); } };
  const recordRef = row => ({ personId: row.personId, impressionId: row.impression.id,
    ...(validId(row.impression.legacyId) ? { legacyId: row.impression.legacyId } : {}) });
  const expired = row => { result.expired++; if (validId(row?.personId) && validId(row?.impression?.id)) result.expiredRecords.push(recordRef(row)); };
  for (const row of rows) {
    try {
      const time = ageOf(row, store);
      if (time && isExpiredEvent({ time }, current)) { expired(row); continue; }
      const data = prepare(row, store), tombstone = topicStore.getEvent(hash(['legacy', data.legacyId, 0]));
      const prior = existing.get(data.legacyId) ?? (tombstone ? [tombstone] : null);
      if (prior?.some(event => event.status === 'forgotten' || isExpiredEvent(event, current))) { expired(row); continue; }
      if (prior) {
        // Canonical ids can change after owner binding. Preserve published
        // history and let normal identity redirects resolve the old ids.
        for (const event of prior) topicStore.readEvent(event.id);
        result.alreadyImported++; append(prior); continue;
      }
      const imported = topicStore.importLegacy(importInput(data));
      if (!Array.isArray(imported?.events) || imported.events.length !== 1) throw new Error('Legacy topic import did not return one immutable event.');
      if (imported.events.some(event => event.status === 'forgotten')) { expired(row); continue; }
      existing.set(data.legacyId, imported.events); append(imported.events); result.imported++;
    } catch (error) {
      if (!(error instanceof SkipLegacy)) throw error;
      result.skipped++; result.skipReasons[error.code] = (result.skipReasons[error.code] ?? 0) + 1;
      if (validId(row?.personId) && validId(row?.impression?.id)) result.skippedRecords.push(recordRef(row));
    }
  }
  return result;
}
