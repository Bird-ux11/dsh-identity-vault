/**
 * Memory trust (β), adapted from the dsh-rofm β design.
 *
 * β is not a probability. It grades how strong the evidence chain behind one
 * record is: who said it, whether the subject said it themselves, whether the
 * owner corrected it, and whether it is still current. The bands decide how the
 * record may be used, which is the whole point of carrying the number:
 *
 *   β >= 7   reliable: may be relied on as a confirmed memory
 *   0..6     verify: must be checked against this turn's dialogue or the MCP
 *            record before it is stated as fact
 *   β < 0    lead only: a hint, never a basis for an assertion
 *
 * Scores are derived at read time from durable provenance, never invented by a
 * model. An owner rating (memory_rate) is persisted separately and wins.
 */
export const TRUST_MIN = -10;
export const TRUST_MAX = 10;
export const TRUST_RELIABLE = 7;

export const TRUST_MEANING = 'β 是证据链强度分级，不是概率：β≥7 可直接依据；0≤β<7 使用前须核实；β<0 只能当线索。';

const error = (code, message) => { const value = new Error(message); value.code = code; return value; };

export function checkBeta(value) {
  if (!Number.isInteger(value) || value < TRUST_MIN || value > TRUST_MAX) {
    throw error('INVALID_TRUST', `β 必须是 ${TRUST_MIN} 到 ${TRUST_MAX} 之间的整数。`);
  }
  return value;
}

export function trustBand(beta) {
  checkBeta(beta);
  if (beta >= TRUST_RELIABLE) return 'reliable';
  if (beta >= 0) return 'verify';
  return 'lead';
}

export function trustOf(beta, why) {
  const value = checkBeta(beta);
  return { beta: value, band: trustBand(value), why };
}

export const signed = beta => (beta > 0 ? `+${beta}` : String(beta));

/** One line prepended to a topic Skill so the number travels with the body. */
export function trustHeader(value) {
  const beta = signed(value.beta);
  if (value.band === 'reliable') return `> 记忆可信度 β=${beta}（可靠）：可直接当作已确认记忆引用。`;
  if (value.band === 'verify') return `> 记忆可信度 β=${beta}（需核实）：引用前先用本轮对话、MCP 记录或 memory_inspect_record 核实，不得当作已确认事实。`;
  return `> 记忆可信度 β=${beta}（仅线索）：只能提示方向，不能据此断言或写入长期状态。`;
}

const ASSISTANT = 'assistant:';

/** Every attribution list a topic body carries, flattened. */
function attribution(body) {
  if (!body || typeof body !== 'object') return [];
  const parts = [body.selfSaid, body.conclusion,
    ...(Array.isArray(body.participants) ? body.participants : []),
    ...(Array.isArray(body.eventDetails?.facts) ? body.eventDetails.facts : []),
    ...(Array.isArray(body.eventDetails?.evaluations) ? body.eventDetails.evaluations : [])];
  return parts.flatMap(item => (Array.isArray(item?.sourceMessageIds) ? item.sourceMessageIds : []));
}

/**
 * Topic summary trust. A summary is not a transcript: the strongest ordinary
 * case is a direct quote attributed to a participant in this very chat, and the
 * weakest is a record whose only sources are the assistant's own words.
 */
export function eventTrust(event, body, override) {
  if (!event) return trustOf(0, 'unknown');
  if (override) return trustOf(override.beta, 'owner-rated');
  if (event.status === 'retracted') return trustOf(-10, 'retracted');
  if (event.revision?.action === 'replace') return trustOf(8, 'owner-corrected');
  const ids = attribution(body);
  const users = ids.filter(id => typeof id === 'string' && !id.startsWith(ASSISTANT));
  if (users.length) return trustOf(event.scope?.kind === 'local-owner' ? 5 : 4,
    event.scope?.kind === 'local-owner' ? 'owner-dialogue' : 'direct-quote');
  if (ids.length) return trustOf(1, 'self-claim');
  return trustOf(2, 'summary-only');
}

/** Persistent MCP event. Only the person's explicit statement promotes here. */
export function coreEventTrust(event, override) {
  if (!event) return trustOf(0, 'unknown');
  if (override) return trustOf(override.beta, 'owner-rated');
  if (event.status === 'revoked') return trustOf(-10, 'revoked');
  if (event.status === 'cleared') return trustOf(6, 'explicit-clear');
  if (event.status === 'superseded') return trustOf(3, 'superseded');
  return trustOf(8, 'current-state');
}

/** currentState record: an explicit statement already validated by the host. */
export function stateTrust(record, override) {
  if (!record) return trustOf(0, 'unknown');
  if (override) return trustOf(override.beta, 'owner-rated');
  if (record.operation === 'clear') return trustOf(6, 'explicit-clear');
  const author = String(record.sourceAuthorId ?? '');
  if (author === 'owner') return trustOf(['owner', 'self'].includes(record.personId) ? 9 : 4, 'owner-stated');
  if (author === 'self') return trustOf(record.personId === 'self' ? 5 : 2, 'self-stated');
  return trustOf(5, 'person-stated');
}

/** Cross-event inference. Never asserted, so it never reaches the verify band. */
export function impressionTrust(item, override) {
  if (!item) return trustOf(0, 'unknown');
  if (override) return trustOf(override.beta, 'owner-rated');
  return trustOf(item.status === 'confirmed' ? 6 : -2, item.status === 'confirmed' ? 'confirmed' : 'inference');
}

/** Portrait evidence: verbatim statement > extracted fact > subjective view. */
export function portraitTrust(kind, item, override) {
  if (override) return trustOf(override.beta, 'owner-rated');
  if (kind === 'observation') return trustOf(5, 'verbatim');
  if (kind === 'fact') return trustOf(4, 'extracted-fact');
  return trustOf(2, 'subjective');
}

export function annotatePortrait(portrait, override) {
  if (!portrait || typeof portrait !== 'object') return portrait;
  const annotate = (list, kind) => (Array.isArray(list)
    ? list.map(item => (item && typeof item === 'object'
      ? { ...item, trust: portraitTrust(kind, item, override(item.eventId)) } : item))
    : list);
  return { ...portrait, observations: annotate(portrait.observations, 'observation'),
    facts: annotate(portrait.facts, 'fact'), evaluations: annotate(portrait.evaluations, 'evaluation') };
}
