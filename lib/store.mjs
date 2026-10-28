import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class IdentityStoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'IdentityStoreError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new IdentityStoreError(code, message); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const copy = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const textProfileFields = new Set(['displayName', 'description', 'persona', 'notes', 'speakingStyle', 'characterStyle', 'occupation', 'longTermStatus']);
const profileFields = new Set([...textProfileFields, 'traits', 'preferences']);
const memoryStateFields = new Set(['speakingStyle', 'characterStyle', 'occupation', 'longTermStatus']);
const stateFieldLabels = { speakingStyle: '说话风格', characterStyle: '人物风格', occupation: '职业', longTermStatus: '长期状态' };

function numberId(value, name) {
  if (typeof value !== 'string' || !/^[0-9]{5,20}$/.test(value)) {
    fail('INVALID_ID', `${name} must be a decimal string containing 5–20 digits.`);
  }
  // Decimal identifiers are canonical strings, never JavaScript numbers.
  if (value[0] === '0') fail('INVALID_ID', `${name} must not have a leading zero.`);
  return value;
}

function shortText(value, name, max = 512, optional = false) {
  if (value == null && optional) return undefined;
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || value.includes('\0')) {
    fail('INVALID_ARGUMENT', `${name} must be a string of at most ${max} characters.`);
  }
  return value;
}

function timestamp(value) {
  if (value == null) return now();
  if (typeof value !== 'string' && typeof value !== 'number') fail('INVALID_ARGUMENT', 'Invalid timestamp.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_ARGUMENT', 'Invalid timestamp.');
  return date.toISOString();
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('INVALID_SCOPE', 'A trusted context scope is required.');
  if (scope.kind === 'local-owner') {
    if (scope.groupId !== undefined || scope.qqId !== undefined) fail('INVALID_SCOPE', 'Local owner scope does not accept a QQ or group identity.');
    return { kind: 'local-owner' };
  }
  if (scope.kind === 'qq-direct') {
    if (scope.groupId !== undefined) fail('INVALID_SCOPE', 'Direct scope does not accept a group identity.');
    return { kind: 'qq-direct', qqId: numberId(scope.qqId, 'qqId') };
  }
  if (scope.kind === 'qq-group') return { kind: 'qq-group', groupId: numberId(scope.groupId, 'groupId'), qqId: numberId(scope.qqId, 'qqId') };
  fail('INVALID_SCOPE', 'Unknown context scope.');
}

const scopeKey = scope => `${scope.kind}:${scope.groupId ?? ''}:${scope.qqId ?? ''}`;
const sameScope = (a, b) => Boolean(a && b && scopeKey(a) === scopeKey(b));
const visibilityOf = scope => scope.kind === 'local-owner' ? 'owner-private' : scope.kind;
function argsScope(args) {
  return normalizeScope(args.scope ?? { kind: 'qq-group', groupId: args.groupId, qqId: args.qqId });
}
function validJobId(id) {
  shortText(id, 'job id', 256);
  if (['__proto__', 'prototype', 'constructor'].includes(id)) fail('INVALID_ARGUMENT', 'Reserved job id.');
  return id;
}
function sourceIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1_000) fail('INVALID_ARGUMENT', '1–1000 source event ids are required.');
  return [...new Set(ids.map(id => shortText(id, 'sourceEventId')))];
}

function scopeMatchesPerson(person, scope) {
  return scope.kind === 'local-owner' ? person.id === 'owner'
    : person.qqId === scope.qqId && (scope.kind !== 'qq-group' || own(person.memberships, scope.groupId));
}

function scopedIdentity(person, scope) {
  const result = { id: person.id, kind: person.kind, canonicalRef: person.id, profile: copy(person.profile) };
  for (const item of person.memoryStateSuppressions ?? []) if (item.lane === '*' || item.lane === memoryLane(scope)) delete result.profile[item.field];
  if (person.qqId !== undefined) result.qqId = person.qqId;
  if (person.id === 'owner') {
    result.bound = person.qqId !== null;
    if (scope.kind !== 'local-owner') result.profile = own(person.profile, 'displayName') ? { displayName: person.profile.displayName } : {};
  }
  if (scope.kind === 'qq-group') result.membership = copy(person.memberships[scope.groupId]);
  return result;
}

function eventMetadata(event) {
  const result = {};
  for (const key of ['eventId', 'scope', 'visibility', 'groupId', 'qqId', 'speaker', 'authorId', 'sessionId', 'turnId', 'sourceRef', 'sourceMessageId', 'at']) {
    if (event[key] !== undefined) result[key] = copy(event[key]);
  }
  return result;
}

// A topic can involve several people in one group; evidence keeps its original
// per-person scope so shared topic links never turn into shared authorship.
function normalizeTopicScope(scope) {
  if (scope?.kind === 'qq-group') return { kind: 'qq-group', groupId: numberId(scope.groupId, 'groupId') };
  return normalizeScope(scope);
}
const topicScopeKey = scope => `${scope.kind}:${scope.groupId ?? ''}:${scope.kind === 'qq-direct' ? scope.qqId : ''}`;
const sameTopicScope = (a, b) => topicScopeKey(a) === topicScopeKey(b);
const memoryLane = scope => scope.kind === 'qq-group' ? 'qq-group' : topicScopeKey(scope);
const memoryStateKey = item => `${memoryLane(item.scope)}:${item.field}`;
function memoryOrder(a, b) { return a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId); }
function mergeMemoryState(person, item) {
  person.memoryState ??= [];
  const index = person.memoryState.findIndex(previous => memoryStateKey(previous) === memoryStateKey(item));
  if (index >= 0 && memoryOrder(item, person.memoryState[index]) <= 0) return false;
  if (index < 0) person.memoryState.push(item); else person.memoryState[index] = item;
  return true;
}
function mergeMemoryOverride(person, item) {
  person.memoryStateOverrides ??= [];
  const index = person.memoryStateOverrides.findIndex(previous => previous.field === item.field && previous.lane === item.lane);
  if (index < 0) person.memoryStateOverrides.push(item);
  else if (item.at > person.memoryStateOverrides[index].at) person.memoryStateOverrides[index] = item;
}
const stateManuallyOverridden = (person, item) => (person.memoryStateOverrides ?? [])
  .some(override => override.field === item.field && (override.lane === '*' || override.lane === memoryLane(item.scope)) && override.at >= item.at);

// Correction records contain identifiers, provenance and digests only. In
// particular, a correction never creates a second permanent episode archive.
const revisionDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revisionData = state => state.memoryRevisions ??= { generation: 0, receipts: {}, events: {}, retractions: [], audit: [] };
function correctionInput({ revisionId, actor, reason, at }, operation) {
  validJobId(revisionId);
  if (actor !== 'owner') fail('FORBIDDEN', 'Memory corrections require the trusted owner.');
  if (reason !== undefined) shortText(reason, 'revision reason', 1000, true);
  return { revisionId, actor, operation, at: timestamp(at), ...(reason === undefined ? {} : { reasonHash: revisionDigest(reason) }) };
}
function correctionSeen(state, meta, target) {
  let normalizedTarget = target;
  const previous = state.memoryRevisions?.audit.find(item => item.revisionId === meta.revisionId);
  const targetPerson = value => value?.startsWith('qq/') ? resolve(state, state.qqIndex[value.slice(3)] ?? '') : resolve(state, value ?? '');
  if (target.personId && previous?.target.personId && targetPerson(target.personId)?.id === targetPerson(previous.target.personId)?.id)
    normalizedTarget = { ...target, personId: previous.target.personId };
  const digest = revisionDigest({ operation: meta.operation, actor: meta.actor, reasonHash: meta.reasonHash ?? null, target: normalizedTarget });
  const receipt = state.memoryRevisions?.receipts[meta.revisionId];
  if (receipt && receipt !== digest) fail('REVISION_CONFLICT', 'This correction ID already describes a different operation.');
  return { digest, seen: Boolean(receipt) };
}
function recordCorrection(state, meta, digest, target) {
  const revisions = revisionData(state);
  revisions.generation++;
  revisions.receipts[meta.revisionId] = digest;
  revisions.audit.push({ ...meta, target, digest, version: revisions.generation });
}
function blockedEvidence(state, eventId, scope, sourceEventIds = [], authorId) {
  return Object.values(state.memoryRevisions?.events ?? {}).some(item => item.relatedEventIds.includes(eventId)
    || item.sources.some(source => sameTopicScope(source.scope, scope) && (!authorId || resolve(state, source.authorId)?.id === resolve(state, authorId)?.id)
      && sourceEventIds.includes(source.eventId)));
}
function rejectedImpressionEvidence(state, person, dimension, scope, supports) {
  return (state.memoryRevisions?.retractions ?? []).some(item => resolve(state, item.personId)?.id === person.id
    && item.dimension === dimension && memoryLane(item.scope) === memoryLane(scope)
    && supports.some(support => item.eventIds.includes(support.eventId) || support.sourceEventIds.some(id => item.sourceEventIds.includes(id))));
}
function stateEvidence(state, target, scope, ids) {
  const author = target.id === 'self' ? state.special.owner : target;
  const events = author.events.filter(event => event.speaker === 'person' && event.authorId === author.id && sameTopicScope(event.scope, scope) && ids.includes(event.eventId));
  if (!ids.every(id => events.some(event => event.eventId === id))) fail('INVALID_EVIDENCE', 'Long-term state requires actual statements by that person; self state requires owner-authored statements.');
  return { author, events, at: events.map(event => timestamp(event.at)).sort().at(-1) };
}
function topicLocation(value) {
  if (typeof value === 'string') return { uri: shortText(value, 'location', 4_096) };
  const result = safeObject(value, 'location');
  const allowed = new Set(['skillName', 'skillId', 'path', 'uri']);
  if (!Object.keys(result).length || Object.keys(result).some(key => !allowed.has(key))) fail('INVALID_ARGUMENT', 'Topic location accepts only skillName, skillId, path and uri metadata.');
  for (const [key, item] of Object.entries(result)) shortText(item, `location.${key}`, 4_096);
  return result;
}
function sourceRefKey(ref) { return `${ref.canonicalRef}\0${scopeKey(ref.scope)}\0${ref.eventId}\0${ref.speaker}`; }
function retention(state) { return state.retention ??= { expiredBefore: null, topicEventIds: [], legacyImpressions: [] }; }
function evidenceTime(person, scope, ids) {
  const times = person.events.filter(event => sameScope(event.scope, scope) && ids.includes(event.eventId)).map(event => event.at);
  return times.length ? times.sort().at(-1) : null;
}
function expiredEvidence(state, person, scope, ids) {
  const at = evidenceTime(person, scope, ids);
  return Boolean(state.retention?.expiredBefore && at && at <= state.retention.expiredBefore);
}
function forgottenImpression(state, person, scope, id, ids) {
  return (state.retention?.legacyImpressions ?? []).some(item => resolve(state, item.personId)?.id === person.id && sameScope(item.scope, scope)
    && (item.impressionId === id || (item.sourceEventIds.length === ids.length && item.sourceEventIds.every(value => ids.includes(value)))));
}
function forgetJob(job, at) {
  if (job.status === 'forgotten') return false;
  if (job.claimToken) job.forgottenClaimToken = job.claimToken;
  job.status = 'forgotten'; job.forgottenAt = at; job.updatedAt = at; job.availableAt = null;
  delete job.claimToken; delete job.workerId; delete job.leaseUntil; delete job.errorCode;
  return true;
}
function forgetImpression(state, person, impression, at) {
  const record = retention(state);
  if (!forgottenImpression(state, person, impression.scope, impression.id, impression.sourceEventIds)) record.legacyImpressions.push({ personId: person.id, impressionId: impression.id, scope: copy(impression.scope), sourceEventIds: [...impression.sourceEventIds] });
  person.impressions.splice(person.impressions.indexOf(impression), 1);
  for (const job of Object.values(state.summaryJobs)) if (resolve(state, job.targetId)?.id === person.id && sameScope(job.scope, impression.scope)
    && (job.impressionId === impression.id || (job.sourceEventIds.length === impression.sourceEventIds.length && job.sourceEventIds.every(id => impression.sourceEventIds.includes(id))))) forgetJob(job, at);
}
function mergeTopicReference(person, reference) {
  person.topicRefs ??= [];
  const existing = person.topicRefs.find(item => item.eventId === reference.eventId && sameTopicScope(item.scope, reference.scope));
  if (!existing) { person.topicRefs.push(reference); return true; }
  if (JSON.stringify(existing.location) !== JSON.stringify(reference.location)) fail('TOPIC_CONFLICT', 'The topic already points to a different location.');
  const seen = new Set(existing.sourceRefs.map(sourceRefKey));
  for (const ref of reference.sourceRefs) if (!seen.has(sourceRefKey(ref))) { existing.sourceRefs.push(ref); seen.add(sourceRefKey(ref)); }
  return false;
}

const impressionDimensions = new Set(['speakingStyle', 'interactionStyle']);
const longTermImpressionKey = item => `${memoryLane(item.scope)}:${item.dimension}:${item.key}`;
const shanghaiDate = time => new Date(Date.parse(time) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
function impressionText(value, name, max) {
  shortText(value, name, max);
  if (/[\u0000-\u001f\u007f]/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('INVALID_ARGUMENT', `Invalid ${name}.`);
  return value;
}
function impressionSupportKey(item) { return `${item.eventId}\0${item.time}`; }
function canonicalSupports(supports) {
  return [...supports].sort((a, b) => a.time.localeCompare(b.time) || a.eventId.localeCompare(b.eventId));
}
/** Overlapping source IDs are one independent experience, even if several
 * Skills or a Skill and its MCP projection name that experience separately. */
function impressionThreshold(supports) {
  const parents = supports.map((_, index) => index), sources = new Map();
  const root = index => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
  for (let index = 0; index < supports.length; index++) for (const id of supports[index].sourceEventIds) {
    if (sources.has(id)) parents[root(index)] = root(sources.get(id)); else sources.set(id, index);
  }
  const experiences = new Map();
  for (let index = 0; index < supports.length; index++) {
    const key = root(index), time = supports[index].time;
    if (!experiences.has(key) || time < experiences.get(key)) experiences.set(key, time);
  }
  const days = new Set([...experiences.values()].map(shanghaiDate));
  if (experiences.size < 3 || days.size < 2) fail('INSUFFICIENT_EVIDENCE', 'A tentative impression requires three independent experiences across two Shanghai dates.');
}
function impressionSources(state, person, scope, ids, time) {
  const people = person.id === 'self' ? allPeople(state) : [person];
  const matching = people.flatMap(author => author.events.filter(event => sameTopicScope(event.scope, scope)
    && event.speaker === (person.id === 'self' ? 'self' : 'person')
    && event.authorId === person.id && ids.includes(event.eventId)));
  if (!ids.length || !ids.every(id => matching.some(event => event.eventId === id))
    || matching.some(event => timestamp(event.at) > time)) fail('INVALID_EVIDENCE', 'An impression must cite actual speech by its subject in the source context.');
}
function impressionProof(state, person, requested, laneScope) {
  const permitted = scope => memoryLane(scope) === memoryLane(laneScope);
  if (blockedEvidence(state, requested.eventId, laneScope)) fail('MEMORY_REVOKED', 'A corrected or retracted event cannot support an automatic impression.');
  const previous = (person.longTermImpressions ?? []).flatMap(item => item.supports)
    .find(item => item.eventId === requested.eventId && item.time === requested.time && permitted(item.scope));
  if (previous) {
    if (blockedEvidence(state, previous.eventId, previous.scope, previous.sourceEventIds, person.id)) fail('MEMORY_REVOKED', 'The impression evidence was revoked.');
    impressionSources(state, person, previous.scope, previous.sourceEventIds, previous.time);
    return copy(previous);
  }
  const topic = (person.topicRefs ?? []).find(ref => ref.eventId === requested.eventId && permitted(ref.scope));
  let proof;
  if (topic) {
    if (topic.at !== requested.time) fail('INVALID_EVIDENCE', 'The impression support time differs from its event.');
    const ids = topic.sourceRefs.filter(source => source.speaker === (person.id === 'self' ? 'self' : 'person')
      && source.authorId === person.id).map(source => source.eventId);
    proof = { eventId: topic.eventId, time: topic.at, scope: copy(topic.scope), sourceEventIds: [...new Set(ids)].sort() };
  } else {
    const core = state.coreEvents?.[requested.eventId];
    if (core && permitted(core.scope)) {
      if (core.time !== requested.time) fail('INVALID_EVIDENCE', 'The impression support time differs from its important event.');
      const ids = core.changes.filter(change => change.personId === person.id && change.sourceAuthorId === person.id).flatMap(change => change.sourceEventIds);
      proof = { eventId: core.id, time: core.time, scope: copy(core.scope), sourceEventIds: [...new Set(ids)].sort() };
    }
  }
  if (!proof || !permitted(proof.scope)) fail('INVALID_EVIDENCE', 'The impression support is not an event attributed to this subject and visibility lane.');
  if (blockedEvidence(state, proof.eventId, proof.scope, proof.sourceEventIds, person.id)) fail('MEMORY_REVOKED', 'The impression evidence was revoked.');
  impressionSources(state, person, proof.scope, proof.sourceEventIds, proof.time);
  return proof;
}
function validateLongTermImpression(state, person, item) {
  if (!item || Object.keys(item).some(key => !['personId', 'key', 'dimension', 'summary', 'status', 'scope', 'supports', 'firstSupportedAt', 'lastSupportedAt', 'updatedAt'].includes(key))
    || item.personId !== person.id || item.status !== 'inferred' || !impressionDimensions.has(item.dimension)) fail('INVALID_ARGUMENT', 'Invalid tentative impression.');
  impressionText(item.key, 'impression key', 80); impressionText(item.summary, 'impression summary', 500);
  const scope = normalizeTopicScope(item.scope);
  if (!Array.isArray(item.supports) || item.supports.length < 3 || item.supports.length > 1000) fail('INVALID_EVIDENCE', 'Invalid impression evidence count.');
  const seen = new Set();
  for (const support of item.supports) {
    if (!support || Object.keys(support).some(key => !['eventId', 'time', 'scope', 'sourceEventIds'].includes(key))
      || timestamp(support.time) !== support.time || seen.has(support.eventId)) fail('INVALID_EVIDENCE', 'Invalid or repeated impression evidence.');
    impressionText(support.eventId, 'support event id', 512); seen.add(support.eventId);
    const evidenceScope = normalizeTopicScope(support.scope), ids = sourceIds(support.sourceEventIds);
    if (memoryLane(evidenceScope) !== memoryLane(scope) || ids.length !== support.sourceEventIds.length) fail('INVALID_EVIDENCE', 'Impression evidence crossed its visibility lane.');
    impressionSources(state, person, evidenceScope, ids, support.time);
  }
  const sorted = canonicalSupports(item.supports);
  if (item.firstSupportedAt !== sorted[0].time || item.lastSupportedAt !== sorted.at(-1).time
    || timestamp(item.updatedAt) !== item.updatedAt) fail('INVALID_EVIDENCE', 'Impression chronology differs from its support.');
  impressionThreshold(item.supports);
}
function mergeLongTermImpression(person, item) {
  person.longTermImpressions ??= [];
  const index = person.longTermImpressions.findIndex(previous => longTermImpressionKey(previous) === longTermImpressionKey(item));
  if (index < 0) { person.longTermImpressions.push(item); return; }
  const previous = person.longTermImpressions[index], merged = new Map(previous.supports.map(value => [value.eventId, value]));
  for (const support of item.supports) {
    if (merged.has(support.eventId) && JSON.stringify(merged.get(support.eventId)) !== JSON.stringify(support)) fail('IMPRESSION_CONFLICT', 'Merged identities disagree about an impression support.');
    merged.set(support.eventId, support);
  }
  const supports = canonicalSupports([...merged.values()]);
  const newer = item.lastSupportedAt > previous.lastSupportedAt || (item.lastSupportedAt === previous.lastSupportedAt && item.updatedAt > previous.updatedAt) ? item : previous;
  person.longTermImpressions[index] = { ...newer, personId: person.id, supports, firstSupportedAt: supports[0].time, lastSupportedAt: supports.at(-1).time };
}

function safeObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', `${name} must be an object.`);
  const inspect = (item, depth = 0) => {
    if (depth > 12) fail('INVALID_ARGUMENT', `${name} is nested too deeply.`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach(v => inspect(v, depth + 1)); return; }
    if (typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      fail('INVALID_ARGUMENT', `${name} must contain only JSON values.`);
    }
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('INVALID_ARGUMENT', `Unsafe key in ${name}.`);
      inspect(child, depth + 1);
    }
  };
  inspect(value);
  if (JSON.stringify(value).length > 200_000) fail('INVALID_ARGUMENT', `${name} is too large.`);
  return copy(value);
}

function initialState() {
  const at = now();
  return {
    schemaVersion: 2, revision: 0, createdAt: at, updatedAt: at,
    special: {
      self: { id: 'self', kind: 'self', profile: {}, createdAt: at, updatedAt: at, eventRefs: [] },
      owner: { id: 'owner', kind: 'owner', qqId: null, profile: {}, createdAt: at, updatedAt: at, memberships: {}, events: [], impressions: [], mergedFrom: [], profileConflicts: [] },
    },
    groups: {}, direct: {}, qqIndex: {}, redirects: {}, summaryJobs: {},
  };
}

function resolve(state, id) {
  const visited = new Set();
  while (own(state.redirects, id)) {
    if (visited.has(id)) fail('STORE_CORRUPT', 'Identity redirect cycle.');
    visited.add(id);
    id = state.redirects[id];
  }
  if (id === 'self' || id === 'owner') return state.special[id];
  const directMatch = /^direct\/([0-9]{5,20})$/.exec(id);
  if (directMatch) {
    const record = state.direct[directMatch[1]];
    return record && !own(record, 'ref') && record.id === id ? record : null;
  }
  const match = /^groups\/([0-9]{5,20})\/people\/([0-9]{5,20})$/.exec(id);
  if (!match) return null;
  const record = state.groups[match[1]]?.people?.[match[2]];
  return record && !own(record, 'ref') && record.id === id ? record : null;
}

function allPeople(state) {
  const people = [state.special.owner];
  for (const entry of Object.values(state.direct ?? {})) if (!own(entry, 'ref')) people.push(entry);
  for (const group of Object.values(state.groups)) {
    for (const entry of Object.values(group.people)) if (!own(entry, 'ref')) people.push(entry);
  }
  return people;
}

function upgradeState(state) {
  if (state?.schemaVersion !== 1) return state;
  // Only add new structural fields. No existing body, reference or timestamp is dropped.
  state.schemaVersion = 2;
  state.direct = {};
  state.summaryJobs = {};
  for (const person of allPeople(state)) {
    for (const event of person.events) {
      event.scope = { kind: 'qq-group', groupId: event.groupId, qqId: person.qqId };
      event.visibility = 'qq-group';
    }
    for (const impression of person.impressions) {
      impression.scope = { kind: 'qq-group', groupId: impression.groupId, qqId: person.qqId };
      impression.visibility = 'qq-group';
    }
  }
  for (const ref of state.special.self.eventRefs) {
    const person = resolve(state, ref.canonicalRef);
    ref.scope = { kind: 'qq-group', groupId: ref.groupId, qqId: person?.qqId };
  }
  return state;
}

function relocateReferences(state, oldRef, newRef) {
  state.redirects[oldRef] = newRef;
  for (const group of Object.values(state.groups)) {
    for (const entry of Object.values(group.people)) if (entry.ref === oldRef) entry.ref = newRef;
  }
  for (const entry of Object.values(state.direct)) if (entry.ref === oldRef) entry.ref = newRef;
  for (const ref of state.special.self.eventRefs) {
    if (ref.canonicalRef === oldRef) {
      ref.canonicalRef = newRef;
      if (ref.authorId === oldRef) ref.authorId = newRef;
    }
  }
  for (const job of Object.values(state.summaryJobs)) if (job.targetId === oldRef) job.targetId = newRef;
  for (const event of Object.values(state.memoryRevisions?.events ?? {})) for (const source of event.sources) if (source.authorId === oldRef) source.authorId = newRef;
  for (const item of state.memoryRevisions?.retractions ?? []) if (item.personId === oldRef) item.personId = newRef;
  for (const event of Object.values(state.coreEvents ?? {})) for (const item of event.changes) {
    if (item.personId === oldRef) item.personId = newRef;
    if (item.sourceAuthorId === oldRef) item.sourceAuthorId = newRef;
  }
  for (const person of [state.special.self, ...allPeople(state)]) {
    for (const item of person.longTermImpressions ?? []) if (item.personId === oldRef) item.personId = newRef;
    for (const item of person.memoryState ?? []) {
      if (item.personId === oldRef) item.personId = newRef;
      if (item.sourceAuthorId === oldRef) item.sourceAuthorId = newRef;
    }
    for (const topic of person.topicRefs ?? []) for (const source of topic.sourceRefs) {
      if (source.canonicalRef === oldRef) source.canonicalRef = newRef;
      if (source.authorId === oldRef) source.authorId = newRef;
    }
  }
}

function validateState(state) {
  try {
    if (!state || state.schemaVersion !== 2 || !Number.isSafeInteger(state.revision) || state.revision < 0) throw Error('Unsupported schema or revision.');
    for (const name of ['groups', 'direct', 'qqIndex', 'redirects', 'special', 'summaryJobs']) {
      if (!state[name] || typeof state[name] !== 'object' || Array.isArray(state[name])) throw Error(`Invalid ${name}.`);
    }
    if (state.memoryRevisions !== undefined) {
      const revisions = state.memoryRevisions;
      if (!revisions || Object.keys(revisions).some(key => !['generation', 'receipts', 'events', 'retractions', 'audit'].includes(key))
        || !Number.isSafeInteger(revisions.generation) || revisions.generation < 0 || !Array.isArray(revisions.audit)
        || !Array.isArray(revisions.retractions) || !revisions.events || !revisions.receipts) throw Error('Invalid memory revision metadata.');
      for (const [id, digest] of Object.entries(revisions.receipts)) {
        validJobId(id); if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid revision receipt.');
      }
      for (const [id, event] of Object.entries(revisions.events)) {
        shortText(id, 'invalidated event ID');
        if (event.eventId !== id || Object.keys(event).some(key => !['eventId', 'revisionId', 'operation', 'at', 'relatedEventIds', 'sources'].includes(key))
          || !['event-retract', 'event-replace'].includes(event.operation) || !own(revisions.receipts, event.revisionId)
          || timestamp(event.at) !== event.at || !Array.isArray(event.relatedEventIds) || !event.relatedEventIds.includes(id) || !Array.isArray(event.sources)) throw Error('Invalid event revision barrier.');
        for (const related of event.relatedEventIds) shortText(related, 'related event ID');
        for (const source of event.sources) {
          if (Object.keys(source).some(key => !['authorId', 'eventId', 'scope'].includes(key)) || !resolve(state, source.authorId)) throw Error('Invalid revoked evidence.');
          shortText(source.eventId, 'revoked source ID'); normalizeTopicScope(source.scope);
        }
      }
      for (const item of revisions.retractions) {
        if (Object.keys(item).some(key => !['personId', 'scope', 'dimension', 'key', 'eventIds', 'sourceEventIds', 'revisionId', 'at'].includes(key))
          || !resolve(state, item.personId) || !impressionDimensions.has(item.dimension) || !own(revisions.receipts, item.revisionId)
          || timestamp(item.at) !== item.at || !Array.isArray(item.eventIds) || !Array.isArray(item.sourceEventIds)) throw Error('Invalid impression retraction barrier.');
        normalizeTopicScope(item.scope); impressionText(item.key, 'retracted impression key', 80);
        for (const id of [...item.eventIds, ...item.sourceEventIds]) shortText(id, 'retracted proof ID');
      }
      for (const item of revisions.audit) {
        if (Object.keys(item).some(key => !['revisionId', 'actor', 'operation', 'at', 'reasonHash', 'target', 'digest', 'version'].includes(key))
          || item.actor !== 'owner' || !['event-retract', 'event-replace', 'impression-retract', 'profile-patch'].includes(item.operation)
          || timestamp(item.at) !== item.at || !Number.isInteger(item.version) || item.version < 1 || item.version > revisions.generation
          || revisions.receipts[item.revisionId] !== item.digest || (item.reasonHash !== undefined && !/^[a-f0-9]{64}$/.test(item.reasonHash))) throw Error('Invalid revision audit record.');
        safeObject(item.target, 'revision target');
      }
    }
    if (state.retention !== undefined) {
      const record = state.retention;
      if (!record || Object.keys(record).some(key => !['expiredBefore', 'topicEventIds', 'legacyImpressions'].includes(key)) || !Array.isArray(record.topicEventIds) || !Array.isArray(record.legacyImpressions)) throw Error('Invalid retention metadata.');
      if (record.expiredBefore !== null && timestamp(record.expiredBefore) !== record.expiredBefore) throw Error('Invalid retention cutoff.');
      if (new Set(record.topicEventIds).size !== record.topicEventIds.length) throw Error('Duplicate forgotten topic.');
      for (const id of record.topicEventIds) shortText(id, 'forgotten topic id');
      for (const item of record.legacyImpressions) {
        if (Object.keys(item).some(key => !['personId', 'impressionId', 'scope', 'sourceEventIds'].includes(key))) throw Error('Invalid forgotten impression metadata.');
        const person = resolve(state, item.personId), scope = normalizeScope(item.scope);
        if (!person || !scopeMatchesPerson(person, scope)) throw Error('Invalid forgotten impression identity.');
        shortText(item.impressionId, 'forgotten impression id'); sourceIds(item.sourceEventIds);
      }
    }
    if (state.special.self?.id !== 'self' || state.special.self.kind !== 'self' || !Array.isArray(state.special.self.eventRefs)) throw Error('Invalid self record.');
    safeObject(state.special.self.profile, 'self profile');
    if (state.special.owner?.id !== 'owner' || state.special.owner.kind !== 'owner') throw Error('Invalid owner record.');
    if (state.memoryStateReceipts !== undefined) {
      safeObject(state.memoryStateReceipts, 'memory state receipts');
      for (const [id, digest] of Object.entries(state.memoryStateReceipts)) {
        validJobId(id);
        if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid memory state receipt.');
      }
    }
    if (state.coreEvents !== undefined) {
      safeObject(state.coreEvents, 'core events');
      for (const [eventId, event] of Object.entries(state.coreEvents)) {
        if (!/^[a-f0-9]{64}$/.test(eventId) || !event || Object.keys(event).some(key => !['id', 'time', 'scope', 'changes'].includes(key))
          || event.id !== eventId || timestamp(event.time) !== event.time || !Array.isArray(event.changes) || !event.changes.length || event.changes.length > 64) throw Error('Invalid important event projection.');
        const scope = normalizeTopicScope(event.scope);
        for (const item of event.changes) {
          const person = resolve(state, item.personId);
          if (!person || !memoryStateFields.has(item.field) || !['set', 'clear'].includes(item.operation)
            || Object.keys(item).some(key => !['personId', 'field', 'operation', 'value', 'scope', 'at', 'eventId', 'sourceEventIds', 'sourceAuthorId'].includes(key))
            || item.eventId !== eventId || !sameTopicScope(item.scope, scope)) throw Error('Invalid important event fact.');
          if (item.operation === 'set') shortText(item.value, 'important fact', 500); else if (item.value !== undefined) throw Error('Cleared important fact has a value.');
          const evidence = stateEvidence(state, person, scope, sourceIds(item.sourceEventIds));
          if (item.at !== evidence.at || item.at > event.time || item.sourceAuthorId !== evidence.author.id) throw Error('Important event evidence changed.');
        }
      }
    }
    for (const person of allPeople(state)) {
      if (!person.profile || !person.memberships || !Array.isArray(person.events) || !Array.isArray(person.impressions)) throw Error('Invalid person record.');
      if (!['person', 'owner'].includes(person.kind)) throw Error('Invalid person kind.');
      safeObject(person.profile, 'profile');
      if (person.qqId !== null) numberId(person.qqId, 'qqId');
      if (person.kind === 'person' && (person.qqId == null || (!person.id.startsWith('groups/') && !person.id.startsWith('direct/')))) throw Error('Invalid canonical person.');
      if (person.qqId && state.qqIndex[person.qqId] !== person.id) throw Error('Canonical identity missing from QQ index.');
      const events = new Set();
      for (const event of person.events) {
        const scope = normalizeScope(event.scope);
        if (!['self', 'person'].includes(event.speaker) || !event.eventId || !scopeMatchesPerson(person, scope) || event.visibility !== visibilityOf(scope)) throw Error('Invalid event scope.');
        if (event.groupId !== scope.groupId || (event.qqId !== undefined && event.qqId !== scope.qqId)) throw Error('Inconsistent event scope.');
        if (event.authorId !== (event.speaker === 'self' ? 'self' : person.id)) throw Error('Invalid event author.');
        const key = `${scopeKey(scope)}\0${event.eventId}\0${event.speaker}`;
        if (events.has(key)) throw Error('Duplicate event.');
        events.add(key);
      }
      for (const groupId of Object.keys(person.memberships)) {
        const entry = state.groups[groupId]?.people?.[person.qqId];
        if (!entry || (entry.ref ?? entry.id) !== person.id) throw Error('Invalid membership reference.');
      }
      for (const impression of person.impressions) {
        const scope = normalizeScope(impression.scope);
        if (!scopeMatchesPerson(person, scope) || impression.visibility !== visibilityOf(scope) || !Array.isArray(impression.sourceEventIds)) throw Error('Invalid impression scope.');
        if (!impression.sourceEventIds.every(id => person.events.some(event => sameScope(event.scope, scope) && event.eventId === id))) throw Error('Invalid impression evidence.');
      }
    }
    for (const [qqId, entry] of Object.entries(state.direct)) {
      numberId(qqId, 'qqId');
      if ((entry.ref ?? entry.id) !== state.qqIndex[qqId] || resolve(state, state.qqIndex[qqId])?.qqId !== qqId) throw Error('Invalid direct reference.');
      if (own(entry, 'ref') && Object.keys(entry).length !== 1) throw Error('Direct reference contains copied profile data.');
      if (!own(entry, 'ref') && entry.id !== `direct/${qqId}`) throw Error('Invalid direct canonical path.');
    }
    for (const [groupId, group] of Object.entries(state.groups)) {
      numberId(groupId, 'groupId');
      if (group.id !== groupId || !group.people || typeof group.people !== 'object') throw Error('Invalid group.');
      for (const [qqId, entry] of Object.entries(group.people)) {
        numberId(qqId, 'qqId');
        const canonical = state.qqIndex[qqId];
        if (!canonical || (entry.ref ?? entry.id) !== canonical) throw Error('Dangling group reference.');
        if (own(entry, 'ref') && Object.keys(entry).length !== 1) throw Error('Group reference contains copied profile data.');
        if (!own(entry, 'ref') && entry.id !== `groups/${groupId}/people/${qqId}`) throw Error('Canonical path mismatch.');
        const person = resolve(state, canonical);
        if (!person || person.qqId !== qqId || !own(person.memberships, groupId)) throw Error('Invalid canonical target.');
      }
    }
    for (const [qqId, ref] of Object.entries(state.qqIndex)) {
      numberId(qqId, 'qqId');
      if (resolve(state, ref)?.qqId !== qqId) throw Error('Invalid QQ index target.');
    }
    for (const id of Object.keys(state.redirects)) if (!resolve(state, id)) throw Error('Dangling identity redirect.');
    for (const ref of state.special.self.eventRefs) {
      const person = resolve(state, ref.canonicalRef);
      if (!person?.events.some(event => event.eventId === ref.eventId && event.speaker === ref.speaker && sameScope(event.scope, ref.scope))) throw Error('Dangling self event reference.');
    }
    for (const person of [state.special.self, ...allPeople(state)]) {
      if (person.memoryStateSuppressions !== undefined) {
        if (!Array.isArray(person.memoryStateSuppressions)) throw Error('Invalid revoked-field suppressions.');
        for (const item of person.memoryStateSuppressions) if (!memoryStateFields.has(item.field) || typeof item.lane !== 'string'
          || Object.keys(item).some(key => !['field', 'lane', 'at', 'revisionId'].includes(key)) || timestamp(item.at) !== item.at
          || !own(state.memoryRevisions?.receipts ?? {}, item.revisionId)) throw Error('Invalid revoked-field suppression.');
      }
      if (person.longTermImpressions !== undefined) {
        if (!Array.isArray(person.longTermImpressions) || person.longTermImpressions.length > 128) throw Error('Invalid long-term impressions.');
        const keys = new Set();
        for (const item of person.longTermImpressions) {
          validateLongTermImpression(state, person, item);
          const key = longTermImpressionKey(item);
          if (keys.has(key)) throw Error('Duplicate long-term impression.');
          keys.add(key);
        }
      }
      if (person.memoryStateOverrides !== undefined) {
        if (!Array.isArray(person.memoryStateOverrides)) throw Error('Invalid manual state override metadata.');
        const keys = new Set();
        for (const item of person.memoryStateOverrides) {
          if (!item || Object.keys(item).some(key => !['field', 'lane', 'at'].includes(key)) || !memoryStateFields.has(item.field) || !['*', 'qq-group'].includes(item.lane) || timestamp(item.at) !== item.at) throw Error('Invalid manual state override.');
          const key = `${item.field}:${item.lane}`;
          if (keys.has(key)) throw Error('Duplicate manual state override.');
          keys.add(key);
        }
      }
      if (person.memoryState !== undefined) {
        if (!Array.isArray(person.memoryState)) throw Error('Invalid maintained state.');
        const keys = new Set();
        for (const item of person.memoryState) {
          if (!item || Object.keys(item).some(key => !['personId', 'field', 'operation', 'value', 'scope', 'at', 'eventId', 'sourceEventIds', 'sourceAuthorId'].includes(key))) throw Error('Unsupported maintained state data.');
          const scope = normalizeTopicScope(item.scope);
          if (item.personId !== person.id || !memoryStateFields.has(item.field) || !['set', 'clear'].includes(item.operation)) throw Error('Invalid maintained state identity or field.');
          if (item.operation === 'set') shortText(item.value, 'state value', 500); else if (item.value !== undefined) throw Error('Cleared state must not retain a value.');
          shortText(item.eventId, 'state source event');
          const evidence = stateEvidence(state, person, scope, sourceIds(item.sourceEventIds));
          if (item.at !== evidence.at || item.sourceAuthorId !== evidence.author.id) throw Error('Maintained state differs from its actual evidence.');
          const key = memoryStateKey(item);
          if (keys.has(key)) throw Error('Duplicate current state.');
          keys.add(key);
        }
      }
      if (person.topicRefs === undefined) continue; // Existing v1/v2 files remain valid without rewriting.
      if (!Array.isArray(person.topicRefs)) throw Error('Invalid topic references.');
      const seen = new Set();
      for (const topic of person.topicRefs) {
        if (Object.keys(topic).some(key => !['eventId', 'scope', 'at', 'location', 'sourceRefs'].includes(key))) throw Error('Topic reference contains unsupported data.');
        shortText(topic.eventId, 'topic eventId');
        const scope = normalizeTopicScope(topic.scope);
        const key = `${topicScopeKey(scope)}\0${topic.eventId}`;
        if (seen.has(key)) throw Error('Duplicate topic reference.');
        seen.add(key); topicLocation(topic.location); timestamp(topic.at);
        if (!Array.isArray(topic.sourceRefs) || !topic.sourceRefs.length) throw Error('Topic evidence is missing.');
        const sources = new Set();
        for (const source of topic.sourceRefs) {
          const target = resolve(state, source.canonicalRef);
          if (!target || (person.id !== 'self' && target.id !== person.id)) throw Error('Topic evidence belongs to a different identity.');
          if (!sameTopicScope(source.scope, scope) || (person.id === 'self' && source.speaker !== 'self')) throw Error('Invalid topic evidence scope or author.');
          const event = target.events.find(item => item.eventId === source.eventId && item.speaker === source.speaker && sameScope(item.scope, source.scope));
          if (!event || event.authorId !== source.authorId || sources.has(sourceRefKey(source))) throw Error('Invalid topic evidence.');
          if (Object.keys(source).some(key => !['canonicalRef', 'eventId', 'scope', 'visibility', 'groupId', 'qqId', 'speaker', 'authorId', 'sessionId', 'turnId', 'sourceRef', 'sourceMessageId', 'at'].includes(key))) throw Error('Topic evidence contains unsupported data.');
          if (Object.keys(source).some(key => key !== 'canonicalRef' && JSON.stringify(source[key]) !== JSON.stringify(event[key]))) throw Error('Topic evidence metadata differs from its source.');
          sources.add(sourceRefKey(source));
        }
      }
    }
    for (const [id, job] of Object.entries(state.summaryJobs)) {
      validJobId(id);
      const person = resolve(state, job.targetId);
      const scope = normalizeScope(job.scope);
      if (id !== job.id || !person || !scopeMatchesPerson(person, scope) || !['pending', 'running', 'failed', 'completed', 'forgotten'].includes(job.status)) throw Error('Invalid summary job.');
      if (!Number.isInteger(job.attempts) || !Number.isInteger(job.maxAttempts) || job.attempts < 0 || job.maxAttempts < 1 || job.attempts > job.maxAttempts) throw Error('Invalid summary job attempts.');
      if (!Array.isArray(job.sourceEventIds) || !job.sourceEventIds.length || !job.sourceEventIds.every(eventId => person.events.some(event => event.eventId === eventId && sameScope(event.scope, scope)))) throw Error('Invalid summary job sources.');
      if (job.status === 'running' && (!job.claimToken || !job.leaseUntil || !job.workerId)) throw Error('Invalid running job lease.');
      if (job.status === 'completed' && !person.impressions.some(item => item.id === job.impressionId && sameScope(item.scope, scope))) throw Error('Completed summary has no impression.');
      if (job.status === 'forgotten' && (!job.forgottenAt || job.availableAt !== null || job.claimToken || job.workerId || job.leaseUntil)) throw Error('Invalid forgotten job.');
    }
  } catch (error) {
    throw new IdentityStoreError('STORE_CORRUPT', 'Identity store failed integrity validation; the original file was preserved.', { cause: error });
  }
  return state;
}

function view(state, person, { groupId, includePrivate = false } = {}) {
  if (!person) return null;
  if (person.id === 'owner' && person.qqId === null && !includePrivate) return { id: 'owner', kind: 'owner', bound: false, canonicalRef: 'owner' };
  const base = { id: person.id, kind: person.kind, canonicalRef: person.id, profile: copy(person.profile) };
  for (const item of person.memoryStateSuppressions ?? []) if (includePrivate || !groupId || item.lane === '*' || item.lane === 'qq-group') delete base.profile[item.field];
  if (person.id === 'self') {
    base.eventRefs = copy(person.eventRefs.filter(ref => includePrivate || (groupId && ref.groupId === groupId)));
    return base;
  }
  base.qqId = person.qqId;
  if (person.id === 'owner') {
    base.bound = person.qqId !== null;
    if (!includePrivate) base.profile = own(person.profile, 'displayName') ? { displayName: person.profile.displayName } : {};
  }
  if (includePrivate) {
    base.memberships = copy(person.memberships);
    base.events = copy(person.events);
    base.impressions = copy(person.impressions);
    if (person.mergedFrom) base.mergedFrom = copy(person.mergedFrom);
    if (person.profileConflicts) base.profileConflicts = copy(person.profileConflicts);
  } else if (groupId) {
    if (!own(person.memberships, groupId)) return null;
    base.membership = copy(person.memberships[groupId]);
    base.events = copy(person.events.filter(event => event.groupId === groupId));
    base.impressions = copy(person.impressions.filter(impression => impression.groupId === groupId));
  }
  return base;
}

/** A synchronous, transaction-based store. Callers must supply trusted actor/scope.
 * Never expose includePrivate or actor as model-controlled authorization switches.
 * Filesystem access and model shell tools are outside this store's trust boundary.
 */
export class IdentityStore {
  constructor({ root, lockTimeoutMs = 5_000 } = {}) {
    if (typeof root !== 'string' || !root.trim()) fail('INVALID_ARGUMENT', 'root is required.');
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'identity-state.json');
    this.backupFile = path.join(this.root, 'identity-state.previous.json');
    this.lockFile = path.join(this.root, 'identity-state.lock');
    this.lockTimeoutMs = Math.max(0, Math.min(30_000, Number(lockTimeoutMs) || 0));
    fs.mkdirSync(this.root, { recursive: true });
    if (!fs.existsSync(this.file)) this.#transaction(() => null, true);
    else this.#read();
  }

  #read(allowNew = false) {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' && allowNew && !fs.existsSync(this.backupFile)) return initialState();
      throw new IdentityStoreError(error.code === 'ENOENT' ? 'STORE_MISSING' : 'STORE_READ_FAILED', 'Cannot read identity store; no replacement was created.', { cause: error });
    }
    let state;
    try { state = JSON.parse(text); }
    catch (error) { throw new IdentityStoreError('STORE_CORRUPT', 'Identity store is not valid JSON; no replacement was created.', { cause: error }); }
    try { return validateState(upgradeState(state)); }
    catch (error) {
      if (error instanceof IdentityStoreError && error.code === 'STORE_CORRUPT') throw error;
      throw new IdentityStoreError('STORE_CORRUPT', 'Identity store could not be migrated; the original file was preserved.', { cause: error });
    }
  }

  #lock() {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      let fd;
      try {
        fd = fs.openSync(this.lockFile, 'wx', 0o600);
      } catch (error) {
        const occupied = error.code === 'EEXIST';
        // Windows can report a sharing/delete-pending race as permission denied
        // while another process releases the file. Retry exclusive creation only;
        // never unlink a lock that this writer did not create.
        const windowsSharingRace = process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code);
        if (!occupied && !windowsSharingRace) throw new IdentityStoreError('LOCK_FAILED', 'Cannot acquire identity store lock.', { cause: error });
        if (Date.now() >= deadline) {
          if (occupied) fail('STORE_LOCKED', 'Identity store is locked by another writer. Retry; a crashed writer may require manual lock recovery.');
          throw new IdentityStoreError('LOCK_FAILED', 'Identity store lock access was denied throughout the retry window.', { cause: error });
        }
        Atomics.wait(sleepBuffer, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
        continue;
      }
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: now() }));
        fs.fsyncSync(fd);
        return fd;
      } catch (error) {
        // Metadata/fsync failures happened after successful acquisition. Do not
        // reinterpret them as contention or retry a genuine write failure.
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(this.lockFile); } catch {}
        throw new IdentityStoreError('LOCK_FAILED', 'Cannot initialize identity store lock.', { cause: error });
      }
    }
  }

  #persist(state, { purgeBackup = false } = {}) {
    validateState(state);
    const temp = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    const backupTemp = `${this.backupFile}.tmp-${process.pid}-${randomUUID()}`;
    const writeDurably = (file, contents) => {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, contents, 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    };
    const renameDurably = (source, destination) => {
      // Windows readers/antivirus can briefly deny replacing an existing JSON
      // file. Keep our exclusive writer lock and the same fully fsynced temp
      // file while retrying only sharing-related errors for a bounded interval.
      const deadline = Date.now() + 500;
      while (true) {
        try { fs.renameSync(source, destination); return; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
          Atomics.wait(sleepBuffer, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
        }
      }
    };
    try {
      writeDurably(temp, `${JSON.stringify(state, null, 2)}\n`);
      if (fs.existsSync(this.file)) {
        // Retention commits must not leave the forgotten summary body in the
        // automatic previous-state backup. Both files receive the clean state.
        writeDurably(backupTemp, purgeBackup ? `${JSON.stringify(state, null, 2)}\n` : fs.readFileSync(this.file));
        renameDurably(backupTemp, this.backupFile);
      }
      renameDurably(temp, this.file);
    } catch (error) {
      throw new IdentityStoreError('STORE_WRITE_FAILED', 'Identity store transaction could not be committed; the prior main state was preserved.', { cause: error });
    } finally {
      for (const file of [temp, backupTemp]) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') { /* Preserve original transaction error. */ } } }
    }
  }

  #transaction(change, initialize = false, { purgeBackup = false } = {}) {
    const fd = this.#lock();
    try {
      const exists = fs.existsSync(this.file);
      const state = this.#read(initialize);
      if (initialize && exists) return null;
      const before = initialize ? null : JSON.stringify(state);
      const result = change(state);
      // Idle worker polls and idempotent retries must not rewrite the full store.
      if (!initialize && JSON.stringify(state) === before) return result == null ? result : copy(result);
      if (!initialize) state.revision += 1;
      state.updatedAt = now();
      this.#persist(state, { purgeBackup });
      return result == null ? result : copy(result);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(this.lockFile);
    }
  }

  #observe(state, { groupId, qqId, displayName, sessionId, sourceEventId, at }) {
    let person = own(state.qqIndex, qqId) ? resolve(state, state.qqIndex[qqId]) : null;
    const created = !person;
    if (!own(state.groups, groupId)) state.groups[groupId] = { id: groupId, people: {} };
    const group = state.groups[groupId];
    if (person?.id.startsWith('direct/')) {
      const oldRef = person.id;
      const newRef = `groups/${groupId}/people/${qqId}`;
      person.id = newRef;
      person.firstGroupId = groupId;
      for (const event of person.events) if (event.authorId === oldRef) event.authorId = newRef;
      group.people[qqId] = person;
      state.direct[qqId] = { ref: newRef };
      state.qqIndex[qqId] = newRef;
      relocateReferences(state, oldRef, newRef);
    }
    if (!person) {
      const id = `groups/${groupId}/people/${qqId}`;
      person = { id, kind: 'person', qqId, profile: {}, firstGroupId: groupId, createdAt: at, updatedAt: at, memberships: {}, events: [], impressions: [] };
      group.people[qqId] = person;
      state.qqIndex[qqId] = id;
    } else if (!own(group.people, qqId)) group.people[qqId] = { ref: person.id };
    const membership = person.memberships[groupId] ?? { groupId, firstSeenAt: at, lastSeenAt: at, sessionIds: [] };
    membership.firstSeenAt = membership.firstSeenAt < at ? membership.firstSeenAt : at;
    membership.lastSeenAt = membership.lastSeenAt > at ? membership.lastSeenAt : at;
    if (displayName !== undefined) membership.displayName = displayName;
    if (sessionId && !membership.sessionIds.includes(sessionId)) membership.sessionIds.push(sessionId);
    if (sourceEventId) membership.lastSourceEventId = sourceEventId;
    person.memberships[groupId] = membership;
    person.updatedAt = now();
    return { person, created };
  }

  status() {
    const state = this.#read();
    const people = allPeople(state);
    const jobs = { pending: 0, running: 0, failed: 0, completed: 0, forgotten: 0 };
    for (const job of Object.values(state.summaryJobs)) jobs[job.status] += 1;
    return { schemaVersion: 2, revision: state.revision, ownerBound: state.special.owner.qqId !== null, selfId: 'self', ownerId: 'owner', groups: Object.keys(state.groups).length, people: Object.keys(state.qqIndex).length, exchanges: people.reduce((n, p) => n + p.events.length, 0), impressions: people.reduce((n, p) => n + p.impressions.length, 0), longTermImpressions: [state.special.self, ...people].reduce((n, p) => n + (p.longTermImpressions?.length ?? 0), 0), jobs, summaryJobs: { ...jobs } };
  }

  observeParticipant(args) {
    const data = {
      groupId: numberId(args?.groupId, 'groupId'), qqId: numberId(args?.qqId, 'qqId'),
      displayName: shortText(args.displayName, 'displayName', 200, true),
      sessionId: shortText(args.sessionId, 'sessionId', 512, true),
      sourceEventId: shortText(args.sourceEventId, 'sourceEventId', 512, true), at: timestamp(args.at),
    };
    return this.#transaction(state => {
      const { person, created } = this.#observe(state, data);
      return { identity: view(state, person, { groupId: data.groupId }), canonicalRef: person.id, created };
    });
  }

  bindOwner({ qqId, displayName } = {}) {
    numberId(qqId, 'qqId');
    shortText(displayName, 'displayName', 200, true);
    return this.#transaction(state => {
      const owner = state.special.owner;
      if (owner.qqId && owner.qqId !== qqId) fail('OWNER_ALREADY_BOUND', 'Owner is already bound to a different QQ identity.');
      const oldRef = state.qqIndex[qqId];
      if (oldRef && oldRef !== 'owner') {
        const old = resolve(state, oldRef);
        if (!old || old.kind !== 'person') fail('IDENTITY_CONFLICT', 'QQ identity cannot be merged into owner.');
        for (const [key, value] of Object.entries(old.profile)) {
          if (!own(owner.profile, key)) owner.profile[key] = value;
          else if (JSON.stringify(owner.profile[key]) !== JSON.stringify(value)) owner.profileConflicts.push({ from: oldRef, field: key, value, at: now() });
        }
        owner.memberships = { ...owner.memberships, ...old.memberships };
        for (const event of old.events) {
          const existing = owner.events.find(item => item.eventId === event.eventId && item.speaker === event.speaker && sameScope(item.scope, event.scope));
          if (!existing) owner.events.push({ ...event, authorId: event.speaker === 'self' ? 'self' : 'owner' });
          else if (JSON.stringify(eventMetadata({ ...existing, authorId: 'owner' })) !== JSON.stringify(eventMetadata({ ...event, authorId: 'owner' }))) fail('EVENT_CONFLICT', 'Owner merge found conflicting evidence for the same source.');
        }
        for (const impression of old.impressions) {
          const existing = owner.impressions.find(item => item.id === impression.id);
          if (existing) {
            // Independent local/QQ records can use the same human supplied id.
            // Retain both bodies and the old id, and retarget any completed job.
            const oldId = impression.id;
            impression.id = `merged:${randomUUID()}`;
            impression.legacyId = oldId;
            impression.mergedFromIdentity = oldRef;
            for (const job of Object.values(state.summaryJobs)) {
              if (job.targetId === oldRef && job.impressionId === oldId) job.impressionId = impression.id;
            }
          }
          owner.impressions.push(impression);
        }
        for (const reference of old.topicRefs ?? []) mergeTopicReference(owner, reference);
        for (const item of old.longTermImpressions ?? []) mergeLongTermImpression(owner, { ...item, personId: 'owner' });
        for (const item of old.memoryState ?? []) mergeMemoryState(owner, { ...item, personId: 'owner', sourceAuthorId: item.sourceAuthorId === oldRef ? 'owner' : item.sourceAuthorId });
        for (const item of old.memoryStateOverrides ?? []) mergeMemoryOverride(owner, item);
        for (const item of old.memoryStateSuppressions ?? []) {
          owner.memoryStateSuppressions ??= [];
          if (!owner.memoryStateSuppressions.some(value => value.field === item.field && value.lane === item.lane)) owner.memoryStateSuppressions.push(item);
        }
        if (owner.memoryStateSuppressions) owner.memoryStateSuppressions = owner.memoryStateSuppressions.filter(item => !(owner.memoryStateOverrides ?? []).some(override =>
          override.field === item.field && (override.lane === '*' || override.lane === item.lane) && override.at >= item.at));
        if (owner.memoryState) owner.memoryState = owner.memoryState.filter(item => !stateManuallyOverridden(owner, item));
        owner.mergedFrom.push({ id: oldRef, firstGroupId: old.firstGroupId, at: now() });
        for (const group of Object.values(state.groups)) if (own(group.people, qqId)) group.people[qqId] = { ref: 'owner' };
        if (own(state.direct, qqId)) state.direct[qqId] = { ref: 'owner' };
        if (old.directSeen) owner.directSeen = old.directSeen;
        relocateReferences(state, oldRef, 'owner');
      }
      owner.qqId = qqId;
      state.qqIndex[qqId] = 'owner';
      if (displayName !== undefined) owner.profile.displayName = displayName;
      owner.updatedAt = now();
      return { identity: view(state, owner, { includePrivate: true }), canonicalRef: 'owner', merged: Boolean(oldRef && oldRef !== 'owner') };
    });
  }

  getIdentity({ qqId, id, groupId, includePrivate = false } = {}) {
    if (!qqId && !id) fail('INVALID_ARGUMENT', 'qqId or id is required.');
    if (qqId !== undefined) numberId(qqId, 'qqId');
    if (id !== undefined) shortText(id, 'id');
    if (groupId !== undefined) numberId(groupId, 'groupId');
    if (typeof includePrivate !== 'boolean') fail('INVALID_ARGUMENT', 'includePrivate must be a boolean.');
    const state = this.#read();
    const person = resolve(state, qqId ? state.qqIndex[qqId] ?? '' : id);
    if (id && qqId && resolve(state, id)?.id !== person?.id) fail('IDENTITY_CONFLICT', 'id and qqId identify different people.');
    return view(state, person, { groupId, includePrivate });
  }

  /** Trusted maintenance input. The topic summarizer validates the meaning;
   * this transaction independently verifies authorship, scope and source time.
   * Kept separately from manually edited profile fields and never aged out. */
  applyMemoryState({ eventId, scope, changes, time, persistCoreEvent = false } = {}) {
    eventId = validJobId(eventId); scope = normalizeTopicScope(scope);
    if (time === undefined) fail('INVALID_ARGUMENT', 'The actual topic time is required.');
    time = timestamp(time);
    if (!Array.isArray(changes) || changes.length > 64) fail('INVALID_ARGUMENT', 'Long-term state changes must be an array of at most 64 items.');
    const inputs = changes.map(change => {
      change = safeObject(change, 'state change');
      if (Object.keys(change).some(key => !['personId', 'field', 'operation', 'value', 'sourceEventIds', 'at'].includes(key))) fail('INVALID_ARGUMENT', 'Unsupported state change field.');
      const personId = shortText(change.personId, 'personId');
      if (!memoryStateFields.has(change.field)) fail('INVALID_PROFILE_FIELD', 'Only established long-term style, occupation and status can be maintained.');
      if (!['set', 'clear'].includes(change.operation)) fail('INVALID_ARGUMENT', 'State operation must be set or clear.');
      if (change.operation === 'set') shortText(change.value, 'state value', 500);
      else if (change.value !== '' && change.value !== undefined) fail('INVALID_ARGUMENT', 'A clear operation has an empty value.');
      return { personId, field: change.field, operation: change.operation, ...(change.operation === 'set' ? { value: change.value } : {}),
        sourceEventIds: sourceIds(change.sourceEventIds).sort(), ...(change.at === undefined ? {} : { at: timestamp(change.at) }) };
    });
    return this.#transaction(state => {
      if (blockedEvidence(state, eventId, scope)) fail('MEMORY_REVOKED', 'This event has been corrected or retracted.');
      const prepared = inputs.map(input => {
        const person = resolve(state, input.personId);
        if (!person) fail('NOT_FOUND', 'The state target identity does not exist.');
        const evidence = stateEvidence(state, person, scope, input.sourceEventIds);
        if (blockedEvidence(state, eventId, scope, input.sourceEventIds, evidence.author.id)) fail('MEMORY_REVOKED', 'This state change cites revoked evidence.');
        if ((input.at !== undefined && input.at !== evidence.at) || evidence.at > time) fail('INVALID_EVIDENCE', 'A state change must use its actual evidence time and cannot occur after its topic.');
        const item = { personId: person.id, field: input.field, operation: input.operation, ...(input.operation === 'set' ? { value: input.value } : {}),
          scope, at: evidence.at, eventId, sourceEventIds: input.sourceEventIds, sourceAuthorId: evidence.author.id };
        // Stable across direct-to-group relocation and later owner binding.
        const stableTarget = person.id === 'self' ? 'self' : scope.kind === 'local-owner' ? 'owner' : `qq/${person.qqId}`;
        return { person, item, signature: { ...item, personId: stableTarget, sourceAuthorId: scope.kind === 'local-owner' ? 'owner' : `qq/${evidence.author.qqId}` } };
      });
      const fingerprints = prepared.map(value => JSON.stringify(value.signature)).sort();
      const digest = createHash('sha256').update(JSON.stringify({ eventId, scope, time, changes: fingerprints })).digest('hex');
      const previous = state.memoryStateReceipts?.[eventId];
      // The projection contains only evidence-checked enduring facts, never the
      // original mixed topic summary, casual dialogue or subjective evaluations.
      if (persistCoreEvent) {
        if (!/^[a-f0-9]{64}$/.test(eventId) || !prepared.length) fail('INVALID_ARGUMENT', 'A core event needs a topic hash and at least one verified long-term change.');
        if (previous && previous !== digest) fail('STATE_CONFLICT', 'The topic already committed different state changes.');
        const projection = { id: eventId, time, scope, changes: [...prepared]
          .sort((a, b) => JSON.stringify(a.signature).localeCompare(JSON.stringify(b.signature))).map(value => value.item) };
        const existing = state.coreEvents?.[eventId];
        if (existing && JSON.stringify(existing) !== JSON.stringify(projection)) fail('STATE_CONFLICT', 'The important event already has a different projection.');
        if (!existing) (state.coreEvents ??= {})[eventId] = projection;
      }
      if (previous) {
        if (previous !== digest) fail('STATE_CONFLICT', 'The same topic already committed different state changes.');
        return { eventId, applied: [], ignored: prepared.map(({ item }) => ({ personId: item.personId, field: item.field })), alreadyApplied: true };
      }
      // Equal-source-time contradictory changes in one topic are ambiguous,
      // so fail the whole write instead of making array order decide the truth.
      const seen = new Map();
      for (const { item } of prepared) {
        const key = `${item.personId}:${memoryStateKey(item)}:${item.at}`;
        if (seen.has(key) && seen.get(key) !== JSON.stringify(item)) fail('STATE_CONFLICT', 'A topic contains conflicting changes for the same field and evidence time.');
        seen.set(key, JSON.stringify(item));
      }
      const applied = [], ignored = [];
      for (const { person, item } of prepared.sort((a, b) => memoryOrder(a.item, b.item))) {
        if (!stateManuallyOverridden(person, item) && mergeMemoryState(person, item)) { person.updatedAt = now(); applied.push(item); }
        else ignored.push({ personId: item.personId, field: item.field });
      }
      (state.memoryStateReceipts ??= {})[eventId] = digest;
      return { eventId, applied, ignored, alreadyApplied: false };
    });
  }

  /** Durable first phase of an owner correction. The coordinator can safely
   * retry the subsequent Skill write after this transaction has committed. */
  invalidateEvent({ eventId, revisionId, actor, reason, at, operation = 'event-retract', sourceRefs = [] } = {}) {
    validJobId(eventId);
    if (!['event-retract', 'event-replace'].includes(operation)) fail('INVALID_ARGUMENT', 'Invalid event correction operation.');
    if (!Array.isArray(sourceRefs) || sourceRefs.length > 1000) fail('INVALID_ARGUMENT', 'Correction source references must be a bounded list.');
    const suppliedSources = sourceRefs.map(source => {
      if (!source || Object.keys(source).some(key => !['authorId', 'eventId', 'scope'].includes(key))) fail('INVALID_EVIDENCE', 'Correction source references contain only author, source ID and scope.');
      return { authorId: shortText(source.authorId, 'source author'), eventId: shortText(source.eventId, 'source event ID'), scope: normalizeTopicScope(source.scope) };
    });
    const meta = correctionInput({ revisionId, actor, reason, at }, operation), target = { eventId };
    return this.#transaction(state => {
      const receipt = correctionSeen(state, meta, target);
      if (receipt.seen) return { eventId, revisionId, alreadyApplied: true, invalidation: state.memoryRevisions.events[eventId] };
      const people = [state.special.self, ...allPeople(state)], sources = new Map();
      const addSource = (authorId, id, scope) => {
        authorId = resolve(state, authorId)?.id;
        if (!authorId) fail('INVALID_EVIDENCE', 'Correction source identity no longer exists.');
        const value = { authorId, eventId: id, scope: normalizeTopicScope(scope) };
        sources.set(JSON.stringify(value), value);
      };
      const old = state.memoryRevisions?.events[eventId];
      // The host can retain provenance from the topic manifest before its
      // ordinary Skill and person link expire. It still cannot invent speech.
      for (const source of suppliedSources) {
        const author = resolve(state, source.authorId), holders = author?.id === 'self' ? allPeople(state) : author ? [author] : [];
        if (!holders.some(person => person.events.some(event => event.eventId === source.eventId && event.authorId === author.id
          && sameTopicScope(event.scope, source.scope)))) fail('INVALID_EVIDENCE', 'The supplied correction source is not actual speech by its attributed author.');
        addSource(author.id, source.eventId, source.scope);
      }
      for (const source of old?.sources ?? []) addSource(source.authorId, source.eventId, source.scope);
      for (const person of people) {
        for (const ref of person.topicRefs ?? []) if (ref.eventId === eventId) for (const source of ref.sourceRefs) addSource(source.authorId, source.eventId, source.scope);
        for (const impression of person.longTermImpressions ?? []) for (const support of impression.supports) if (support.eventId === eventId)
          for (const id of support.sourceEventIds) addSource(person.id, id, support.scope);
        for (const item of person.memoryState ?? []) if (item.eventId === eventId) for (const id of item.sourceEventIds) addSource(item.sourceAuthorId, id, item.scope);
      }
      const core = state.coreEvents?.[eventId];
      for (const item of core?.changes ?? []) for (const id of item.sourceEventIds) addSource(item.sourceAuthorId, id, item.scope);
      const related = new Set([eventId, ...(old?.relatedEventIds ?? [])]), sourceList = [...sources.values()];
      const overlaps = (scope, ids, authorId) => sourceList.some(source => sameTopicScope(source.scope, scope)
        && resolve(state, source.authorId)?.id === resolve(state, authorId)?.id && ids.includes(source.eventId));
      for (const person of people) {
        for (const ref of person.topicRefs ?? []) if (ref.sourceRefs.some(source => overlaps(source.scope, [source.eventId], source.authorId))) related.add(ref.eventId);
        for (const impression of person.longTermImpressions ?? []) for (const support of impression.supports)
          if (overlaps(support.scope, support.sourceEventIds, person.id)) related.add(support.eventId);
      }
      for (const event of Object.values(state.coreEvents ?? {})) if (event.changes.some(item => overlaps(item.scope, item.sourceEventIds, item.sourceAuthorId))) related.add(event.id);
      const record = { eventId, revisionId, operation, at: meta.at, relatedEventIds: [...related].sort(), sources: sourceList };
      revisionData(state).events[eventId] = record;
      let removedImpressions = 0, removedStates = 0, removedLegacyImpressions = 0;
      for (const person of people) {
        const impressions = person.longTermImpressions ?? [];
        person.longTermImpressions = impressions.filter(item => !item.supports.some(support => related.has(support.eventId) || overlaps(support.scope, support.sourceEventIds, person.id)));
        removedImpressions += impressions.length - person.longTermImpressions.length;
        const current = person.memoryState ?? [];
        person.memoryState = current.filter(item => {
          if (!related.has(item.eventId) && !overlaps(item.scope, item.sourceEventIds, item.sourceAuthorId)) return true;
          person.memoryStateSuppressions ??= [];
          const lane = memoryLane(item.scope);
          person.memoryStateSuppressions = person.memoryStateSuppressions.filter(value => value.field !== item.field || value.lane !== lane);
          person.memoryStateSuppressions.push({ field: item.field, lane, at: meta.at, revisionId });
          removedStates++; return false;
        });
        if (person.id !== 'self') {
          for (const event of person.events) if (overlaps(event.scope, [event.eventId], event.authorId)) delete event.text;
          for (const item of [...person.impressions]) if (overlaps(item.scope, item.sourceEventIds, person.id) || overlaps(item.scope, item.sourceEventIds, 'self')) {
            forgetImpression(state, person, item, meta.at); removedLegacyImpressions++;
          }
        }
      }
      for (const job of Object.values(state.summaryJobs)) if (blockedEvidence(state, job.id, job.scope, job.sourceEventIds)) forgetJob(job, meta.at);
      recordCorrection(state, meta, receipt.digest, target);
      return { eventId, revisionId, alreadyApplied: false, removedImpressions, removedStates, removedLegacyImpressions, invalidation: record };
    }, false, { purgeBackup: true });
  }

  getEventInvalidation(eventId) {
    shortText(eventId, 'eventId');
    const state = this.#read();
    const versions = new Map((state.memoryRevisions?.audit ?? []).map(item => [item.revisionId, item.version]));
    const event = Object.values(state.memoryRevisions?.events ?? {}).filter(item => item.relatedEventIds.includes(eventId))
      .sort((a, b) => versions.get(b.revisionId) - versions.get(a.revisionId))[0];
    return event ? copy(event) : null;
  }

  isEventInvalidated(eventId) { return Boolean(this.getEventInvalidation(eventId)); }

  listInvalidatedEvents() {
    const state = this.#read();
    return copy(Object.values(state.memoryRevisions?.events ?? {}));
  }

  getRevisionAudit({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_ARGUMENT', 'Revision audit limit must be 1–1000.');
    const state = this.#read();
    return copy((state.memoryRevisions?.audit ?? []).slice(-limit).reverse());
  }

  getRevisionRecord(revisionId) {
    validJobId(revisionId);
    const state = this.#read(), record = state.memoryRevisions?.audit.find(item => item.revisionId === revisionId);
    return record ? copy(record) : null;
  }

  retractLongTermImpression({ personId, scope, key, dimension, revisionId, actor, reason, at } = {}) {
    shortText(personId, 'personId'); scope = normalizeTopicScope(scope); impressionText(key, 'impression key', 80);
    if (!impressionDimensions.has(dimension)) fail('INVALID_ARGUMENT', 'Invalid impression dimension.');
    const meta = correctionInput({ revisionId, actor, reason, at }, 'impression-retract');
    return this.#transaction(state => {
      const person = resolve(state, personId);
      if (!person) fail('NOT_FOUND', 'Identity not found.');
      const target = { personId: person.id === 'self' ? 'self' : person.qqId ? `qq/${person.qqId}` : 'owner', scope, dimension, key };
      const receipt = correctionSeen(state, meta, target);
      if (receipt.seen) return { personId: person.id, revisionId, alreadyApplied: true };
      const item = (person.longTermImpressions ?? []).find(value => value.key === key && value.dimension === dimension && memoryLane(value.scope) === memoryLane(scope));
      if (!item) fail('NOT_FOUND', 'The inferred impression was not found in this visibility lane.');
      const barrier = { personId: person.id, scope, key, dimension, revisionId, at: meta.at,
        eventIds: [...new Set(item.supports.map(value => value.eventId))].sort(),
        sourceEventIds: [...new Set(item.supports.flatMap(value => value.sourceEventIds))].sort() };
      revisionData(state).retractions.push(barrier);
      person.longTermImpressions = person.longTermImpressions.filter(value => value !== item);
      recordCorrection(state, meta, receipt.digest, target);
      return { personId: person.id, revisionId, alreadyApplied: false, removed: { key, dimension } };
    });
  }

  /** Host worker policy; contains no episode or impression text. */
  getImpressionEvidencePolicy({ personId, scope } = {}) {
    shortText(personId, 'personId'); scope = normalizeTopicScope(scope);
    const state = this.#read(), person = resolve(state, personId);
    if (!person) fail('NOT_FOUND', 'Identity not found.');
    const events = Object.values(state.memoryRevisions?.events ?? {}), blockedEventIds = new Set(), blockedSourceEventIds = new Set();
    for (const item of events) {
      for (const id of item.relatedEventIds) blockedEventIds.add(id);
      for (const source of item.sources) if (resolve(state, source.authorId)?.id === person.id && memoryLane(source.scope) === memoryLane(scope)) blockedSourceEventIds.add(source.eventId);
    }
    const dimensions = new Map();
    for (const item of state.memoryRevisions?.retractions ?? []) if (resolve(state, item.personId)?.id === person.id && memoryLane(item.scope) === memoryLane(scope)) {
      if (!dimensions.has(item.dimension)) dimensions.set(item.dimension, { dimension: item.dimension, eventIds: new Set(), sourceEventIds: new Set() });
      const record = dimensions.get(item.dimension);
      for (const id of item.eventIds) record.eventIds.add(id);
      for (const id of item.sourceEventIds) record.sourceEventIds.add(id);
    }
    return { revision: state.memoryRevisions?.generation ?? 0, blockedEventIds: [...blockedEventIds].sort(), blockedSourceEventIds: [...blockedSourceEventIds].sort(),
      rejectedDimensions: [...dimensions.values()].map(item => ({ dimension: item.dimension, eventIds: [...item.eventIds].sort(), sourceEventIds: [...item.sourceEventIds].sort() })) };
  }

  getMemoryState({ id, qqId, scope, includePrivate = false, crossGroup = false } = {}) {
    if (!id && !qqId) fail('INVALID_ARGUMENT', 'id or qqId is required.');
    if (id !== undefined) shortText(id, 'id');
    if (qqId !== undefined) numberId(qqId, 'qqId');
    if (typeof includePrivate !== 'boolean' || typeof crossGroup !== 'boolean') fail('INVALID_ARGUMENT', 'State visibility flags must be trusted booleans.');
    if (scope !== undefined) scope = normalizeTopicScope(scope);
    const state = this.#read(), person = resolve(state, qqId ? state.qqIndex[qqId] ?? '' : id);
    if (id && qqId && resolve(state, id)?.id !== person?.id) fail('IDENTITY_CONFLICT', 'id and qqId identify different people.');
    if (!person || (!includePrivate && (!scope || scope.kind === 'local-owner'))) return [];
    return copy((person.memoryState ?? []).filter(item => includePrivate || sameTopicScope(item.scope, scope)
      || (crossGroup && scope.kind === 'qq-group' && item.scope.kind === 'qq-group')));
  }

  /** Host-only synthesis writes a tentative expression pattern, never a
   * confirmed identity field. The model supplies no permanent event body. */
  upsertLongTermImpressions({ personId, scope, impressions, at } = {}) {
    shortText(personId, 'personId'); scope = normalizeTopicScope(scope); at = timestamp(at);
    if (!Array.isArray(impressions) || impressions.length > 16) fail('INVALID_ARGUMENT', 'At most sixteen tentative impressions may be written together.');
    const inputs = impressions.map(value => {
      value = safeObject(value, 'long-term impression');
      if (Object.keys(value).some(key => !['key', 'dimension', 'summary', 'supports'].includes(key))
        || !impressionDimensions.has(value.dimension)) fail('INVALID_ARGUMENT', 'Only speaking and interaction patterns can be inferred.');
      const key = impressionText(value.key, 'impression key', 80), summary = impressionText(value.summary, 'impression summary', 500);
      if (!Array.isArray(value.supports)) fail('INVALID_EVIDENCE', 'Impression supports must be an event list.');
      if (value.supports.length > 1000) fail('IMPRESSION_CAPACITY_EXCEEDED', 'This impression reached its 1000-support evidence capacity; existing evidence was preserved.');
      const supports = new Map();
      for (const support of value.supports) {
        if (!support || Object.keys(support).some(key => !['eventId', 'time'].includes(key)) || support.time === undefined) fail('INVALID_EVIDENCE', 'Supports contain only event ID and original event time.');
        const eventId = impressionText(support.eventId, 'support event id', 512), time = timestamp(support.time);
        if (supports.has(eventId) && supports.get(eventId).time !== time) fail('INVALID_EVIDENCE', 'A repeated support cannot change its event time.');
        supports.set(eventId, { eventId, time });
      }
      if (supports.size < 3) fail('INSUFFICIENT_EVIDENCE', 'Three independent events are required.');
      return { key, dimension: value.dimension, summary, supports: canonicalSupports([...supports.values()]) };
    });
    return this.#transaction(state => {
      const person = resolve(state, personId);
      if (!person) fail('NOT_FOUND', 'The impression target identity does not exist.');
      if ((scope.kind === 'local-owner' && !['owner', 'self'].includes(person.id))
        || (person.id !== 'self' && scope.kind === 'qq-direct' && person.qqId !== scope.qqId)
        || (person.id !== 'self' && scope.kind === 'qq-group' && !own(person.memberships, scope.groupId))) fail('INVALID_SCOPE', 'The impression scope does not belong to its subject.');
      const keys = new Set(), prepared = [], unchanged = [];
      for (const input of inputs) {
        const key = longTermImpressionKey({ ...input, scope });
        if (keys.has(key)) fail('IMPRESSION_CONFLICT', 'A batch cannot write an impression twice.');
        keys.add(key);
        const supports = canonicalSupports(input.supports.map(support => impressionProof(state, person, support, scope)));
        if (rejectedImpressionEvidence(state, person, input.dimension, scope, supports)) fail('MEMORY_REVOKED', 'A retracted impression requires entirely new independent evidence.');
        impressionThreshold(supports);
        const previous = (person.longTermImpressions ?? []).find(item => longTermImpressionKey(item) === key);
        const item = { personId: person.id, key: input.key, dimension: input.dimension, summary: input.summary, status: 'inferred',
          scope: copy(previous?.scope ?? scope), supports, firstSupportedAt: supports[0].time, lastSupportedAt: supports.at(-1).time, updatedAt: at };
        if (previous) {
          const existing = new Set(previous.supports.map(impressionSupportKey)), incoming = new Set(supports.map(impressionSupportKey));
          if ([...existing].some(id => !incoming.has(id)) || item.lastSupportedAt < previous.lastSupportedAt) fail('STALE_IMPRESSION', 'A stale synthesis cannot drop previously committed evidence.');
          const sameEvidence = existing.size === incoming.size;
          if (sameEvidence && previous.summary === item.summary) { unchanged.push(input.key); continue; }
          const priorSources = new Set(previous.supports.flatMap(support => support.sourceEventIds));
          if (previous.summary !== item.summary && (sameEvidence || !supports.some(support => support.sourceEventIds.some(id => !priorSources.has(id))))) fail('IMPRESSION_CONFLICT', 'Changing an inferred impression requires new independent speech evidence.');
          if (at < previous.updatedAt) fail('STALE_IMPRESSION', 'An earlier synthesis cannot replace a later committed impression.');
        }
        validateLongTermImpression(state, person, item); prepared.push(item);
      }
      const next = [...(person.longTermImpressions ?? [])];
      for (const item of prepared) {
        const index = next.findIndex(previous => longTermImpressionKey(previous) === longTermImpressionKey(item));
        if (index < 0) next.push(item); else next[index] = item;
      }
      if (next.length > 128) fail('IMPRESSION_CAPACITY_EXCEEDED', 'This identity reached its 128-impression capacity; existing impressions were preserved.');
      if (prepared.length) { person.longTermImpressions = next; person.updatedAt = now(); }
      return { personId: person.id, applied: prepared.map(item => ({ key: item.key, dimension: item.dimension })), unchanged, alreadyApplied: prepared.length === 0 };
    });
  }

  getLongTermImpressions({ id, qqId, scope, crossGroup = false, includePrivate = false } = {}) {
    if (!id && !qqId) fail('INVALID_ARGUMENT', 'id or qqId is required.');
    if (id !== undefined) shortText(id, 'id');
    if (qqId !== undefined) numberId(qqId, 'qqId');
    if (typeof crossGroup !== 'boolean' || typeof includePrivate !== 'boolean') fail('INVALID_ARGUMENT', 'Impression visibility flags must be trusted booleans.');
    if (scope !== undefined) scope = normalizeTopicScope(scope);
    const state = this.#read(), person = resolve(state, qqId ? state.qqIndex[qqId] ?? '' : id);
    if (id && qqId && resolve(state, id)?.id !== person?.id) fail('IDENTITY_CONFLICT', 'id and qqId identify different people.');
    if (!person || (!includePrivate && (!scope || scope.kind === 'local-owner'))) return [];
    return copy((person.longTermImpressions ?? []).filter(item => includePrivate
      || (scope.kind === 'qq-group' && item.scope.kind === 'qq-group' && (crossGroup || item.supports.every(support => sameTopicScope(support.scope, scope))))
      || (scope.kind === 'qq-direct' && sameTopicScope(item.scope, scope)))
      .map(item => ({ ...item, supports: item.supports.map(({ eventId, time }) => ({ eventId, time })) })));
  }

  /** Host maintenance inventory only. Never expose this cross-identity view as
   * a model tool or resource; MCP reads always use getMemoryState filtering. */
  listMemoryState() {
    const state = this.#read();
    return copy([state.special.self, ...allPeople(state)].flatMap(person => person.memoryState ?? []));
  }

  /** Atomic promotion plus current-state update. Ordinary Skill deletion never
   * touches this MCP history; original author/time metadata remains its proof. */
  promoteCoreEvent(args = {}) { return this.applyMemoryState({ ...args, persistCoreEvent: true }); }

  #coreEventView(state, event, changes = event.changes) {
    const revoked = blockedEvidence(state, event.id, event.scope)
      || changes.some(item => blockedEvidence(state, event.id, item.scope, item.sourceEventIds, item.sourceAuthorId));
    const visibleChanges = changes.map(item => {
      const person = resolve(state, item.personId);
      const current = (person.memoryState ?? []).find(value => memoryStateKey(value) === memoryStateKey(item));
      const matches = current?.eventId === item.eventId && current.at === item.at;
      return { ...copy(item), status: revoked ? 'revoked' : matches ? (item.operation === 'clear' ? 'cleared' : 'current') : 'superseded' };
    });
    const participants = [...new Set(changes.flatMap(item => [item.personId, item.sourceAuthorId]))].map(id => resolve(state, id))
      .filter(Boolean).map(person => ({ personId: person.id, ...(person.qqId ? { qqId: person.qqId } : {}) }));
    const scope = event.scope.kind === 'qq-group'
      ? { ...event.scope, qqIds: [...new Set(participants.map(person => person.qqId).filter(Boolean))].sort() } : copy(event.scope);
    const fields = [...new Set(changes.map(item => stateFieldLabels[item.field]))];
    return { id: event.id, time: event.time, scope, participants, topic: `${fields.join('、')}的长期记录`,
      triggers: [...new Set([...fields, ...(changes.some(item => item.field === 'occupation') ? ['工作', '就业'] : []),
        ...(changes.some(item => item.field === 'longTermStatus') ? ['状态', '近况'] : []),
        ...changes.filter(item => item.operation === 'set').map(item => item.value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 128)).filter(Boolean)])].slice(0, 32),
      changes: visibleChanges, status: revoked ? 'revoked' : visibleChanges.some(item => item.status === 'current') ? 'current'
        : visibleChanges.some(item => item.status === 'cleared') ? 'cleared' : 'superseded' };
  }

  #coreEventViews(state, includeRevoked = false) {
    const events = Object.values(state.coreEvents ?? {}).map(event => this.#coreEventView(state, event)).filter(event => includeRevoked || event.status !== 'revoked'), groups = new Map();
    const normalized = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    for (const event of events) {
      if (event.status === 'revoked') continue;
      // Conservative equality only: same visibility and complete attributed
      // enduring facts. Similar occupations or different audiences never merge.
      const key = JSON.stringify([event.scope, event.changes.map(item => [item.personId, item.sourceAuthorId, item.field, item.operation, normalized(item.value)])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(event);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => Number(b.status !== 'superseded') - Number(a.status !== 'superseded') || b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
      const primary = group[0]; primary.duplicateIds = group.slice(1).map(event => event.id).sort();
      primary.occurrences = [...group].sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id)).map(event => ({ eventId: event.id,
        time: event.time, status: event.status, sources: event.changes.map(item => ({ personId: item.personId, field: item.field,
          sourceAuthorId: item.sourceAuthorId, sourceEventIds: [...item.sourceEventIds], at: item.at })) }));
      for (const event of group.slice(1)) event.duplicateOf = primary.id;
    }
    return events;
  }

  /** Host-only inventory. Model-facing reads must use the filtered API below. */
  listCoreEvents({ includeRevoked = false } = {}) {
    if (typeof includeRevoked !== 'boolean') fail('INVALID_ARGUMENT', 'includeRevoked must be a trusted boolean.');
    const state = this.#read();
    return this.#coreEventViews(state, includeRevoked);
  }

  getCoreEvents({ id, qqId, eventId, scope, includePrivate = false, crossGroup = false, includeRevoked = false } = {}) {
    if (!id && !qqId && !eventId) fail('INVALID_ARGUMENT', 'An identity or important event ID is required.');
    if (eventId !== undefined && !/^[a-f0-9]{64}$/.test(eventId)) fail('INVALID_ARGUMENT', 'Invalid important event ID.');
    if (id !== undefined) shortText(id, 'id');
    if (qqId !== undefined) numberId(qqId, 'qqId');
    if (typeof includePrivate !== 'boolean' || typeof crossGroup !== 'boolean' || typeof includeRevoked !== 'boolean') fail('INVALID_ARGUMENT', 'Trusted visibility flags are required.');
    if (scope !== undefined) scope = normalizeTopicScope(scope);
    const state = this.#read(), person = id || qqId ? resolve(state, qqId ? state.qqIndex[qqId] ?? '' : id) : null;
    if ((id || qqId) && !person) return [];
    if (id && qqId && resolve(state, id)?.id !== person?.id) fail('IDENTITY_CONFLICT', 'Identity selectors differ.');
    if (!includePrivate && (!scope || scope.kind === 'local-owner')) return [];
    return this.#coreEventViews(state, includeRevoked).filter(event => (!eventId || event.id === eventId)
      && (includePrivate || sameTopicScope(event.scope, scope) || (crossGroup && scope.kind === 'qq-group' && event.scope.kind === 'qq-group')))
      .flatMap(event => {
        const changes = person ? event.changes.filter(item => item.personId === person.id) : event.changes;
        if (!changes.length) return [];
        return [{ ...this.#coreEventView(state, event, changes), ...(event.duplicateOf ? { duplicateOf: event.duplicateOf } : {}),
          ...(event.duplicateIds ? { duplicateIds: event.duplicateIds, occurrences: event.occurrences.map(occurrence => ({ ...occurrence,
            sources: person ? occurrence.sources.filter(source => source.personId === person.id) : occurrence.sources })) } : {}) }];
      });
  }

  updateProfile({ id, patch, actor, groupId, revisionId, reason, at } = {}) {
    shortText(id, 'id');
    if (groupId !== undefined) numberId(groupId, 'groupId');
    const clean = safeObject(patch, 'patch');
    const meta = revisionId === undefined ? null : correctionInput({ revisionId, actor, reason, at }, 'profile-patch');
    for (const [key, value] of Object.entries(clean)) {
      if (!profileFields.has(key)) fail('INVALID_PROFILE_FIELD', `Unsupported profile field: ${key}.`);
      if (value !== null && textProfileFields.has(key)) shortText(value, key, key === 'displayName' ? 200 : 30_000, true);
      if (value !== null && key === 'traits' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) fail('INVALID_ARGUMENT', 'traits must be an array of strings.');
      if (value !== null && key === 'preferences') safeObject(value, 'preferences');
    }
    return this.#transaction(state => {
      const person = resolve(state, id);
      if (!person) fail('NOT_FOUND', 'Identity was not found.');
      if (actor !== 'owner' && !(actor === 'self' && person.kind === 'person' && groupId && own(person.memberships, groupId))) fail('FORBIDDEN', 'Only the trusted owner can edit self/owner; self may update a known participant profile in its own group.');
      const target = { personId: person.id === 'self' ? 'self' : person.qqId ? `qq/${person.qqId}` : 'owner',
        ...(groupId ? { groupId } : {}), fields: Object.keys(clean).sort(), patchHash: revisionDigest(clean) };
      const receipt = meta ? correctionSeen(state, meta, target) : null;
      if (receipt?.seen) return view(state, person, { groupId, includePrivate: actor === 'owner' && !groupId });
      for (const [key, value] of Object.entries(clean)) { if (value === null) delete person.profile[key]; else person.profile[key] = value; }
      // An explicit, authorized profile correction must be observable even if
      // older automatic state had precedence. Keep receipts and a content-free
      // time barrier so retries or late old topics cannot undo the correction.
      const fields = new Set(Object.keys(clean).filter(field => memoryStateFields.has(field)));
      if (fields.size) {
        const lane = groupId ? 'qq-group' : '*', at = meta?.at ?? now();
        if (person.memoryState) person.memoryState = person.memoryState.filter(item => !fields.has(item.field) || (lane !== '*' && memoryLane(item.scope) !== lane));
        if (person.memoryStateSuppressions) person.memoryStateSuppressions = person.memoryStateSuppressions.filter(item => !fields.has(item.field) || (lane !== '*' && item.lane !== lane));
        for (const field of fields) mergeMemoryOverride(person, { field, lane, at });
      }
      if (meta) recordCorrection(state, meta, receipt.digest, target);
      person.updatedAt = now();
      // Owner authority does not make a group response a private/local response.
      return view(state, person, { groupId, includePrivate: actor === 'owner' && !groupId });
    });
  }

  recordExchange(args = {}) {
    const groupId = numberId(args.groupId, 'groupId');
    const qqId = numberId(args.qqId, 'qqId');
    const eventId = shortText(args.eventId, 'eventId');
    const sessionId = shortText(args.sessionId, 'sessionId', 512, true);
    const sourceRef = shortText(args.sourceRef, 'sourceRef', 2_048, true);
    const sourceMessageId = shortText(args.sourceMessageId, 'sourceMessageId', 512, true);
    const text = shortText(args.text, 'text', 100_000, true);
    const at = timestamp(args.at);
    if (!['person', 'self'].includes(args.speaker)) fail('INVALID_ARGUMENT', 'speaker must be person or self.');
    return this.#transaction(state => {
      const retainedText = state.retention?.expiredBefore && at <= state.retention.expiredBefore ? undefined : text;
      const { person } = this.#observe(state, { groupId, qqId, sessionId, sourceEventId: eventId, at });
      const existing = person.events.find(event => event.eventId === eventId && event.speaker === args.speaker);
      if (existing) {
        if (existing.groupId !== groupId || (retainedText !== undefined && existing.text !== retainedText) || (sourceRef !== undefined && existing.sourceRef !== sourceRef) || (sourceMessageId !== undefined && existing.sourceMessageId !== sourceMessageId)) fail('EVENT_CONFLICT', 'An event with this eventId and speaker already has different evidence.');
        return { event: existing, canonicalRef: person.id, created: false };
      }
      const scope = { kind: 'qq-group', groupId, qqId };
      const event = { eventId, scope, visibility: 'qq-group', groupId, qqId, speaker: args.speaker, authorId: args.speaker === 'self' ? 'self' : person.id, at };
      if (sessionId !== undefined) event.sessionId = sessionId;
      if (sourceRef !== undefined) event.sourceRef = sourceRef;
      if (sourceMessageId !== undefined) event.sourceMessageId = sourceMessageId;
      if (retainedText !== undefined) event.text = retainedText;
      person.events.push(event);
      state.special.self.eventRefs.push({ canonicalRef: person.id, scope, groupId, eventId, speaker: event.speaker, authorId: event.authorId, at });
      state.special.self.updatedAt = now();
      return { event, canonicalRef: person.id, created: true };
    });
  }

  #scopePerson(state, scope, { create = false, sessionId, sourceEventId, at = now(), displayName } = {}) {
    if (scope.kind === 'local-owner') return state.special.owner;
    if (scope.kind === 'qq-group' && create) return this.#observe(state, { ...scope, sessionId, sourceEventId, at, displayName }).person;
    let person = resolve(state, state.qqIndex[scope.qqId] ?? '');
    if (scope.kind === 'qq-group') return person && own(person.memberships, scope.groupId) ? person : null;
    if (!create) return person;
    if (!person) {
      const id = `direct/${scope.qqId}`;
      person = { id, kind: 'person', qqId: scope.qqId, profile: {}, createdAt: at, updatedAt: at, memberships: {}, events: [], impressions: [] };
      state.direct[scope.qqId] = person;
      state.qqIndex[scope.qqId] = id;
    } else if (!own(state.direct, scope.qqId)) state.direct[scope.qqId] = { ref: person.id };
    const seen = person.directSeen ?? { firstSeenAt: at, lastSeenAt: at, sessionIds: [] };
    seen.firstSeenAt = seen.firstSeenAt < at ? seen.firstSeenAt : at;
    seen.lastSeenAt = seen.lastSeenAt > at ? seen.lastSeenAt : at;
    if (sessionId && !seen.sessionIds.includes(sessionId)) seen.sessionIds.push(sessionId);
    if (displayName !== undefined) seen.displayName = displayName;
    person.directSeen = seen;
    return person;
  }

  resolveScope({ scope, displayName, sessionId, sourceEventId, at } = {}) {
    scope = normalizeScope(scope);
    shortText(displayName, 'displayName', 200, true);
    shortText(sessionId, 'sessionId', 512, true);
    shortText(sourceEventId, 'sourceEventId', 512, true);
    const time = timestamp(at);
    return this.#transaction(state => {
      const person = this.#scopePerson(state, scope, { create: true, displayName, sessionId, sourceEventId, at: time });
      return { identity: scopedIdentity(person, scope), canonicalRef: person.id };
    });
  }

  recordDialogue(args = {}) {
    const scope = normalizeScope(args.scope);
    if (args.text !== undefined) fail('INVALID_ARGUMENT', 'recordDialogue stores source references only, not message text.');
    const eventId = shortText(args.eventId, 'eventId');
    if (!['person', 'self'].includes(args.speaker)) fail('INVALID_ARGUMENT', 'speaker must be person or self.');
    const metadata = {};
    for (const key of ['sessionId', 'turnId', 'sourceRef', 'sourceMessageId']) {
      const value = shortText(args[key], key, key === 'sourceRef' ? 2_048 : 512, true);
      if (value !== undefined) metadata[key] = value;
    }
    if (args.visibility !== undefined && args.visibility !== visibilityOf(scope)) fail('INVALID_SCOPE', 'Visibility must match the trusted context scope.');
    const at = timestamp(args.at);
    return this.#transaction(state => {
      const person = this.#scopePerson(state, scope, { create: true, sessionId: metadata.sessionId, sourceEventId: eventId, at });
      if (args.identityId && resolve(state, args.identityId)?.id !== person.id) fail('IDENTITY_CONFLICT', 'Identity does not match the trusted context scope.');
      const existing = person.events.find(event => sameScope(event.scope, scope) && event.eventId === eventId && event.speaker === args.speaker);
      if (existing) {
        for (const [key, value] of Object.entries(metadata)) if (existing[key] !== undefined && existing[key] !== value) fail('EVENT_CONFLICT', 'The source event already has different metadata.');
        for (const [key, value] of Object.entries(metadata)) if (existing[key] === undefined) existing[key] = value;
        return { event: eventMetadata(existing), canonicalRef: person.id, created: false };
      }
      const event = { eventId, scope, visibility: visibilityOf(scope), ...metadata, speaker: args.speaker, authorId: args.speaker === 'self' ? 'self' : person.id, at };
      if (scope.qqId) event.qqId = scope.qqId;
      if (scope.groupId) event.groupId = scope.groupId;
      person.events.push(event);
      person.updatedAt = now();
      const ref = { canonicalRef: person.id, scope, eventId, speaker: event.speaker, authorId: event.authorId, at };
      if (scope.groupId) ref.groupId = scope.groupId;
      state.special.self.eventRefs.push(ref);
      state.special.self.updatedAt = now();
      return { event: eventMetadata(event), canonicalRef: person.id, created: true };
    });
  }

  getDialogueEvents({ scope, sourceEventIds } = {}) {
    scope = normalizeScope(scope);
    const ids = sourceIds(sourceEventIds);
    const state = this.#read();
    const person = this.#scopePerson(state, scope);
    const events = person?.events.filter(event => sameScope(event.scope, scope) && ids.includes(event.eventId)) ?? [];
    if (!ids.every(id => events.some(event => event.eventId === id))) fail('INVALID_EVIDENCE', 'Some requested source events are missing from this context.');
    return events.map(eventMetadata);
  }

  attachTopicReferences({ eventId, scope, participants, selfSourceEventIds, at, location, retain = false } = {}) {
    eventId = shortText(eventId, 'topic eventId');
    if (typeof retain !== 'boolean') fail('INVALID_ARGUMENT', 'retain must be a trusted host boolean.');
    scope = normalizeTopicScope(scope); location = topicLocation(location); at = timestamp(at);
    if (!Array.isArray(participants) || !participants.length || participants.length > 1_000) fail('INVALID_ARGUMENT', 'Topic participants are required.');
    const inputs = participants.map(item => ({ personId: shortText(item?.personId, 'personId'), sourceEventIds: sourceIds(item?.sourceEventIds) }));
    const selfIds = selfSourceEventIds === undefined ? null : Array.isArray(selfSourceEventIds) && selfSourceEventIds.length === 0 ? [] : sourceIds(selfSourceEventIds);
    return this.#transaction(state => {
      if (state.retention?.topicEventIds.includes(eventId) || (!retain && state.retention?.expiredBefore && at <= state.retention.expiredBefore)) return { eventId, attached: [], selfCreated: false, forgotten: true };
      const attached = [], selfRefs = [], selfSeen = new Set();
      for (const input of inputs) {
        const person = resolve(state, input.personId);
        if (!person || person.id === 'self') fail('INVALID_EVIDENCE', 'A topic participant must be an existing person or owner.');
        const events = person.events.filter(event => sameTopicScope(event.scope, scope) && input.sourceEventIds.includes(event.eventId));
        if (!input.sourceEventIds.every(id => events.some(event => event.eventId === id))) fail('INVALID_EVIDENCE', 'Every topic source must belong to this participant and context.');
        const sourceRefs = events.map(event => ({ canonicalRef: person.id, ...eventMetadata(event) }));
        const created = mergeTopicReference(person, { eventId, scope, at, location, sourceRefs });
        attached.push({ personId: person.id, created });
        for (const ref of sourceRefs) {
          if (ref.speaker !== 'self' || (selfIds && !selfIds.includes(ref.eventId)) || selfSeen.has(sourceRefKey(ref))) continue;
          selfSeen.add(sourceRefKey(ref)); selfRefs.push(ref);
        }
      }
      if (selfIds && !selfIds.every(id => selfRefs.some(ref => ref.eventId === id))) fail('INVALID_EVIDENCE', 'Self topic evidence must be an actual self-authored source from these participants.');
      const selfCreated = selfRefs.length ? mergeTopicReference(state.special.self, { eventId, scope, at, location, sourceRefs: selfRefs }) : false;
      return { eventId, attached, selfCreated };
    });
  }

  /** Trusted host retention, never a model-controlled identity mutation. Only
   * topic links and explicitly identified old summary bodies are removed. */
  forgetTopicReferences({ eventIds = [], legacyImpressions = [] } = {}) {
    if (!Array.isArray(eventIds) || eventIds.length > 100_000 || !Array.isArray(legacyImpressions) || legacyImpressions.length > 100_000) fail('INVALID_ARGUMENT', 'Retention ids must be bounded arrays.');
    const ids = [...new Set(eventIds.map(id => shortText(id, 'topic eventId')))];
    const legacy = legacyImpressions.map(item => ({ personId: shortText(item?.personId, 'personId'), impressionId: shortText(item?.impressionId, 'impressionId'), ...(item.scope === undefined ? {} : { scope: normalizeScope(item.scope) }) }));
    return this.#transaction(state => {
      let removedReferences = 0, removedImpressions = 0;
      const at = now();
      if (ids.length) {
        const record = retention(state);
        const previous = new Set(record.topicEventIds);
        for (const id of ids) if (!previous.has(id)) record.topicEventIds.push(id);
        const forgotten = new Set(ids);
        for (const person of [state.special.self, ...allPeople(state)]) {
          if (!person.topicRefs) continue;
          const retained = person.topicRefs.filter(item => !forgotten.has(item.eventId));
          removedReferences += person.topicRefs.length - retained.length;
          person.topicRefs = retained;
        }
      }
      for (const item of legacy) {
        const person = resolve(state, item.personId);
        if (!person || person.id === 'self') continue;
        // After owner binding two former identities can have reused the same
        // manual id. A repeated old request must not delete the other context.
        if ((state.retention?.legacyImpressions ?? []).some(value => resolve(state, value.personId)?.id === person.id && value.impressionId === item.impressionId && (!item.scope || sameScope(value.scope, item.scope)))) continue;
        const impression = person.impressions.find(value => value.id === item.impressionId && (!item.scope || sameScope(value.scope, item.scope)));
        if (!impression) continue;
        forgetImpression(state, person, impression, at); removedImpressions++;
      }
      return { eventIds: ids, removedReferences, removedImpressions };
    }, false, { purgeBackup: true });
  }

  /** Inclusive event-end cutoff. The cutoff only advances; delayed summary
   * jobs cannot extend an old event's lifetime by generating it today. */
  expireImpressions({ before } = {}) {
    if (before === undefined) fail('INVALID_ARGUMENT', 'An explicit retention cutoff is required.');
    before = timestamp(before);
    return this.#transaction(state => {
      const record = retention(state);
      if (record.expiredBefore === null || before > record.expiredBefore) record.expiredBefore = before;
      let removedImpressions = 0, removedLegacyTexts = 0;
      const previouslyForgottenJobs = Object.values(state.summaryJobs).filter(job => job.status === 'forgotten').length;
      const removed = [], at = now();
      for (const person of allPeople(state)) {
        // v0.1 could optionally retain a raw text copy. That copy is episodic
        // content too; remove only it, keeping all author/source provenance.
        for (const event of person.events) if (event.at <= record.expiredBefore && own(event, 'text')) { delete event.text; removedLegacyTexts++; }
        for (const impression of [...person.impressions]) {
          if (!expiredEvidence(state, person, impression.scope, impression.sourceEventIds)) continue;
          removed.push({ personId: person.id, impressionId: impression.id, scope: copy(impression.scope), sourceEventIds: [...impression.sourceEventIds] });
          forgetImpression(state, person, impression, at); removedImpressions++;
        }
      }
      for (const job of Object.values(state.summaryJobs)) {
        const person = resolve(state, job.targetId);
        if (expiredEvidence(state, person, job.scope, job.sourceEventIds)) forgetJob(job, at);
      }
      return { before: record.expiredBefore, removedImpressions, removedLegacyTexts, forgottenJobs: Object.values(state.summaryJobs).filter(job => job.status === 'forgotten').length - previouslyForgottenJobs, removed };
    }, false, { purgeBackup: true });
  }

  getTopicReferences({ id, qqId, scope, crossGroup = false, includePrivate = false } = {}) {
    if (!id && !qqId) fail('INVALID_ARGUMENT', 'id or qqId is required.');
    if (id !== undefined) shortText(id, 'id');
    if (qqId !== undefined) numberId(qqId, 'qqId');
    if (typeof crossGroup !== 'boolean' || typeof includePrivate !== 'boolean') fail('INVALID_ARGUMENT', 'Visibility flags must be trusted booleans.');
    if (scope !== undefined) scope = normalizeTopicScope(scope);
    const state = this.#read();
    const person = resolve(state, qqId ? state.qqIndex[qqId] ?? '' : id);
    if (id && qqId && resolve(state, id)?.id !== person?.id) fail('IDENTITY_CONFLICT', 'id and qqId identify different people.');
    if (!person || (!scope && !includePrivate)) return [];
    // An unbound local-owner view is private, never inferred from a topic id.
    if (scope?.kind === 'local-owner' && !includePrivate) return [];
    return copy((person.topicRefs ?? []).filter(ref => {
      if (includePrivate) return true;
      if (sameTopicScope(ref.scope, scope)) return true;
      return crossGroup && scope.kind === 'qq-group' && ref.scope.kind === 'qq-group';
    }));
  }

  getImpressions({ scope, crossGroup = false, limit = 12 } = {}) {
    scope = normalizeScope(scope);
    if (typeof crossGroup !== 'boolean') fail('INVALID_ARGUMENT', 'crossGroup must be a trusted boolean policy.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) fail('INVALID_ARGUMENT', 'limit must be between 1 and 1000.');
    const state = this.#read();
    const person = this.#scopePerson(state, scope);
    if (!person) return { identity: null, canonicalRef: null, impressions: [] };
    const impressions = person.impressions.filter(item => {
      if (scope.kind === 'local-owner') return true;
      if (sameScope(item.scope, scope)) return true;
      return crossGroup && scope.kind === 'qq-group' && item.scope.kind === 'qq-group' && item.scope.qqId === scope.qqId;
    }).sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '') || a.id.localeCompare(b.id)).slice(0, limit);
    return { identity: scopedIdentity(person, scope), canonicalRef: person.id, impressions: copy(impressions) };
  }

  /** Trusted host migration only. Never publish this administrator inventory as
   * a model tool: it intentionally enumerates every retained legacy summary. */
  listLegacyImpressions() {
    const state = this.#read();
    return allPeople(state).flatMap(person => person.impressions.map(impression => ({
      personId: person.id, ...(person.qqId ? { qqId: person.qqId } : {}), impression: copy(impression),
    })));
  }

  #putImpression(state, args) {
    const scope = argsScope(args);
    const { id = randomUUID(), summary, otherSaid, selfSaid, conclusion } = args;
    shortText(id, 'id');
    if (args.visibility !== undefined && args.visibility !== visibilityOf(scope)) fail('INVALID_SCOPE', 'Visibility must match the trusted context scope.');
    const content = {};
    for (const [key, value] of Object.entries({ summary, otherSaid, selfSaid, conclusion })) {
      if (value !== undefined) content[key] = shortText(value, key, 30_000, true);
    }
    if (!Object.values(content).some(value => value.trim())) fail('INVALID_ARGUMENT', 'Impression content is required.');
    const evidence = sourceIds(args.sourceEventIds);
      const person = this.#scopePerson(state, scope);
      if (!person) fail('NOT_FOUND', 'Participant was not observed in this context.');
      if (args.identityId && resolve(state, args.identityId)?.id !== person.id) fail('IDENTITY_CONFLICT', 'Identity does not match the trusted context scope.');
      if (!evidence.every(eventId => person.events.some(event => sameScope(event.scope, scope) && event.eventId === eventId))) fail('INVALID_EVIDENCE', 'Every source event must belong to this participant and context.');
      if (blockedEvidence(state, id, scope, evidence)) fail('MEMORY_REVOKED', 'The summary cites corrected or retracted evidence.');
      if (expiredEvidence(state, person, scope, evidence) || forgottenImpression(state, person, scope, id, evidence)) fail('MEMORY_FORGOTTEN', 'This event has already expired or been forgotten; its summary cannot be restored.');
      const existing = person.impressions.find(item => item.id === id);
      if (existing && !sameScope(existing.scope, scope)) fail('FORBIDDEN', 'Cannot overwrite another context’s impression.');
      if (existing?.sourceJobId && existing.sourceJobId !== args.sourceJobId) fail('IMPRESSION_CONFLICT', 'A completed job impression cannot be overwritten by an unrelated writer.');
      const impression = { ...(existing ?? {}), ...content, id, scope, visibility: visibilityOf(scope), sourceEventIds: evidence, createdAt: existing?.createdAt ?? now(), updatedAt: now() };
      if (scope.groupId) impression.groupId = scope.groupId;
      if (scope.qqId) impression.qqId = scope.qqId;
      if (args.sourceJobId) impression.sourceJobId = args.sourceJobId;
      if (existing) person.impressions[person.impressions.indexOf(existing)] = impression;
      else person.impressions.push(impression);
      person.updatedAt = now();
      return { impression, canonicalRef: person.id, created: !existing };
  }

  putImpression(args = {}) {
    return this.#transaction(state => this.#putImpression(state, args));
  }

  upsertSummaryJob({ id, scope, sessionId, turnId, sourceEventIds, modelSelection, maxAttempts = 3 } = {}) {
    validJobId(id); scope = normalizeScope(scope);
    shortText(sessionId, 'sessionId'); shortText(turnId, 'turnId');
    const ids = sourceIds(sourceEventIds);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) fail('INVALID_ARGUMENT', 'maxAttempts must be between 1 and 10.');
    let selection;
    if (modelSelection !== undefined) {
      selection = { provider: shortText(modelSelection?.provider, 'provider', 200), model: shortText(modelSelection?.model, 'model', 200) };
    }
    return this.#transaction(state => {
      const person = this.#scopePerson(state, scope);
      if (!person || !ids.every(eventId => person.events.some(event => event.eventId === eventId && sameScope(event.scope, scope)))) fail('INVALID_EVIDENCE', 'Summary job sources must already exist in its trusted context.');
      if (blockedEvidence(state, id, scope, ids)) fail('MEMORY_REVOKED', 'The summary job cites corrected or retracted evidence.');
      const existing = own(state.summaryJobs, id) ? state.summaryJobs[id] : undefined;
      if (existing) {
        if (!sameScope(existing.scope, scope) || existing.targetId !== person.id || existing.sessionId !== sessionId || existing.turnId !== turnId) fail('JOB_CONFLICT', 'This job id belongs to a different dialogue.');
        const additions = ids.filter(eventId => !existing.sourceEventIds.includes(eventId));
        if (additions.length && ['running', 'completed', 'forgotten'].includes(existing.status)) fail('JOB_IMMUTABLE', 'Cannot change the evidence of a running, completed or forgotten summary job.');
        if (selection && existing.modelSelection && JSON.stringify(selection) !== JSON.stringify(existing.modelSelection)) fail('JOB_CONFLICT', 'This job already selected a different model.');
        if (additions.length) existing.sourceEventIds.push(...additions);
        if (selection && !existing.modelSelection) existing.modelSelection = selection;
        return existing;
      }
      // A second id cannot summarize the same target/turn/context a second time.
      const duplicate = Object.values(state.summaryJobs).find(job => job.targetId === person.id && sameScope(job.scope, scope) && job.sessionId === sessionId && job.turnId === turnId);
      if (duplicate) {
        if (!ids.every(eventId => duplicate.sourceEventIds.includes(eventId))) fail('JOB_CONFLICT', 'This dialogue turn already has a summary job with different evidence.');
        return duplicate;
      }
      if (expiredEvidence(state, person, scope, ids) || forgottenImpression(state, person, scope, `job:${id}`, ids)) fail('MEMORY_FORGOTTEN', 'This dialogue has already expired or been forgotten.');
      const at = now();
      const job = { id, scope, targetId: person.id, sessionId, turnId, sourceEventIds: ids, status: 'pending', attempts: 0, maxAttempts, createdAt: at, updatedAt: at, availableAt: at };
      if (selection) job.modelSelection = selection;
      state.summaryJobs[id] = job;
      return job;
    });
  }

  #recoverJobs(state, at) {
    const recovered = [];
    for (const job of Object.values(state.summaryJobs)) {
      if (job.status !== 'running' || Date.parse(job.leaseUntil) > Date.parse(at)) continue;
      job.status = 'failed';
      job.errorCode = 'LEASE_EXPIRED';
      job.updatedAt = at;
      job.availableAt = job.attempts < job.maxAttempts ? at : null;
      delete job.claimToken; delete job.workerId; delete job.leaseUntil;
      recovered.push(job.id);
    }
    return recovered;
  }

  recoverSummaryJobs() {
    return this.#transaction(state => ({ recovered: this.#recoverJobs(state, now()) }));
  }

  listSummaryJobs({ status, limit = 100 } = {}) {
    if (status !== undefined && !['pending', 'running', 'failed', 'completed', 'forgotten'].includes(status)) fail('INVALID_ARGUMENT', 'Unknown job status.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) fail('INVALID_ARGUMENT', 'Invalid job limit.');
    return copy(Object.values(this.#read().summaryJobs).filter(job => !status || job.status === status).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, limit));
  }

  claimSummaryJob({ id, workerId, leaseMs = 300_000 } = {}) {
    if (id !== undefined) validJobId(id);
    shortText(workerId, 'workerId');
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) fail('INVALID_ARGUMENT', 'leaseMs must be between 1 and 3600000.');
    return this.#transaction(state => {
      const at = now();
      this.#recoverJobs(state, at);
      const job = Object.values(state.summaryJobs).filter(item => (!id || item.id === id) && ['pending', 'failed'].includes(item.status) && item.attempts < item.maxAttempts && item.availableAt && Date.parse(item.availableAt) <= Date.parse(at)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      if (!job) return null;
      job.status = 'running';
      job.attempts += 1;
      job.workerId = workerId;
      job.claimToken = randomUUID();
      job.startedAt = at;
      job.updatedAt = at;
      job.leaseUntil = new Date(Date.parse(at) + leaseMs).toISOString();
      job.availableAt = null;
      delete job.errorCode;
      return job;
    });
  }

  #claimedJob(state, id, claimToken) {
    validJobId(id); shortText(claimToken, 'claimToken');
    const job = own(state.summaryJobs, id) ? state.summaryJobs[id] : undefined;
    if (!job) fail('NOT_FOUND', 'Summary job was not found.');
    if (job.status !== 'running' || job.claimToken !== claimToken) fail('JOB_CLAIM_MISMATCH', 'This worker does not own the current summary job claim.');
    if (Date.parse(job.leaseUntil) <= Date.now()) fail('JOB_LEASE_EXPIRED', 'The summary job lease expired; its result was not stored.');
    return job;
  }

  renewSummaryJob({ id, claimToken, leaseMs = 300_000 } = {}) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) fail('INVALID_ARGUMENT', 'leaseMs must be between 1 and 3600000.');
    return this.#transaction(state => {
      const job = this.#claimedJob(state, id, claimToken);
      job.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      job.updatedAt = now();
      return job;
    });
  }

  failSummaryJob({ id, claimToken, errorCode = 'SUMMARY_FAILED', retryAt } = {}) {
    shortText(errorCode, 'errorCode', 128);
    // Never persist provider error text: it can contain dialogue excerpts or secrets.
    if (!/^[A-Z0-9_:-]+$/i.test(errorCode)) fail('INVALID_ARGUMENT', 'errorCode must be a compact identifier, not an error message.');
    return this.#transaction(state => {
      const job = this.#claimedJob(state, id, claimToken);
      job.status = 'failed';
      job.errorCode = errorCode;
      job.updatedAt = now();
      job.availableAt = job.attempts < job.maxAttempts ? timestamp(retryAt ?? Date.now() + Math.min(300_000, 30_000 * 2 ** (job.attempts - 1))) : null;
      delete job.claimToken; delete job.workerId; delete job.leaseUntil;
      return job;
    });
  }

  completeSummaryJob({ id, claimToken, impression } = {}) {
    validJobId(id); shortText(claimToken, 'claimToken');
    return this.#transaction(state => {
      const previous = own(state.summaryJobs, id) ? state.summaryJobs[id] : undefined;
      if (previous?.status === 'forgotten') {
        if (![previous.completedClaimToken, previous.forgottenClaimToken].includes(claimToken)) fail('JOB_CLAIM_MISMATCH', 'This forgotten completion belongs to another job claim.');
        return { job: previous, impression: null, alreadyCompleted: true, forgotten: true };
      }
      if (previous?.status === 'completed') {
        if (previous.completedClaimToken !== claimToken) fail('JOB_CLAIM_MISMATCH', 'This completion belongs to another job claim.');
        const person = resolve(state, previous.targetId);
        return { job: previous, impression: person.impressions.find(item => item.id === previous.impressionId), alreadyCompleted: true };
      }
      const job = this.#claimedJob(state, id, claimToken);
      // Only summary fields come from the model. Identity, visibility and sources are fixed by the job.
      const result = this.#putImpression(state, {
        scope: job.scope, identityId: job.targetId, id: `job:${job.id}`, sourceJobId: job.id, sourceEventIds: job.sourceEventIds,
        summary: impression?.summary, otherSaid: impression?.otherSaid, selfSaid: impression?.selfSaid, conclusion: impression?.conclusion,
      });
      job.status = 'completed';
      job.impressionId = result.impression.id;
      job.completedAt = now();
      job.updatedAt = job.completedAt;
      job.completedClaimToken = claimToken;
      delete job.claimToken; delete job.workerId; delete job.leaseUntil; delete job.errorCode;
      job.availableAt = null;
      return { job, impression: result.impression, alreadyCompleted: false };
    });
  }
}

export default IdentityStore;
