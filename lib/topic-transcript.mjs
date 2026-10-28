import { createTranscriptLoader, TranscriptError } from './transcript.mjs';

const fail = (code, message) => { throw new TranscriptError(code, message); };
const mismatch = message => fail('SOURCE_MISMATCH', message);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[\u0000-\u001f\u007f]/.test(value);
const qq = value => typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
const abort = signal => { if (signal?.aborted) fail('ABORTED', '主题来源读取已取消。'); };
const sameScope = (a, b) => a?.kind === b?.kind && a?.qqId === b?.qqId && a?.groupId === b?.groupId;
const list = (values, prefix, empty = false) => Array.isArray(values) && (empty || values.length > 0)
  && values.length <= 300 && new Set(values).size === values.length
  && values.every(id => validId(id) && id.startsWith(prefix) && id.length > prefix.length);

function validateJob(job) {
  if (!plain(job) || !validId(job.id) || !validId(job.sessionId) || !plain(job.scope)
    || typeof job.turnId !== 'string' || !/^(0|[1-9]\d*)$/.test(job.turnId) || !Number.isSafeInteger(Number(job.turnId))
    || !Array.isArray(job.participants) || !job.participants.length || job.participants.length > 8
    || !list(job.selfEventIds, 'assistant:', true)) mismatch('主题任务来源信息无效。');
  const chat = job.scope;
  if (chat.kind === 'local-owner') {
    if (chat.qqId !== undefined || chat.qqIds !== undefined || chat.groupId !== undefined || job.participants.length !== 1) mismatch('本机主题不能混入远端人物。');
  } else if (chat.kind === 'qq-direct') {
    if (!qq(chat.qqId) || chat.qqIds !== undefined || chat.groupId !== undefined || job.participants.length !== 1) mismatch('私聊主题不能混入其他会话。');
  } else if (chat.kind === 'qq-group') {
    if (!qq(chat.groupId) || chat.qqId !== undefined || !Array.isArray(chat.qqIds) || !chat.qqIds.length
      || chat.qqIds.length > 8 || chat.qqIds.some(id => !qq(id)) || new Set(chat.qqIds).size !== chat.qqIds.length) mismatch('群聊主题缺少完整可信参与者。');
  } else mismatch('主题任务来源类型无效。');
  const authors = new Set(), people = new Set(), expected = new Map();
  for (const person of job.participants) {
    if (!plain(person) || !validId(person.personId) || person.personId === 'self' || authors.has(person.personId)
      || !plain(person.scope) || person.scope.kind !== chat.kind || !list(person.sourceEventIds, 'user:')) mismatch('主题人物或证据重复、无效。');
    const scope = person.scope;
    if (chat.kind === 'local-owner' ? person.personId !== 'owner' || scope.qqId !== undefined || scope.groupId !== undefined
      : chat.kind === 'qq-direct' ? scope.qqId !== chat.qqId || scope.groupId !== undefined
        : scope.groupId !== chat.groupId || !chat.qqIds.includes(scope.qqId)) mismatch('人物证据不属于本次主题会话。');
    if (scope.qqIds !== undefined || (scope.qqId && people.has(scope.qqId))) mismatch('同一 QQ 不能分配给多个主题作者。');
    if (scope.qqId) people.add(scope.qqId);
    authors.add(person.personId);
    for (const id of person.sourceEventIds) {
      if (expected.has(id)) mismatch('一条用户消息不能有两个作者。');
      expected.set(id, { speaker: 'person', personId: person.personId });
    }
  }
  if (chat.kind === 'qq-group' && (people.size !== chat.qqIds.length || chat.qqIds.some(id => !people.has(id)))) mismatch('主题缺少已声明参与者的完整证据。');
  for (const id of job.selfEventIds) {
    if (expected.has(id)) mismatch('用户与助手证据不能重叠。');
    expected.set(id, { speaker: 'self', personId: 'self' });
  }
  if (expected.size > 300) mismatch('主题来源数量超过上限。');
  if (job.sourceEventIds !== undefined && (!Array.isArray(job.sourceEventIds) || job.sourceEventIds.length !== expected.size
    || new Set(job.sourceEventIds).size !== expected.size || job.sourceEventIds.some(id => !expected.has(id)))) mismatch('主题总证据与人物证据不一致。');
  return expected;
}

/** Merge a topic's verified participant transcripts; never infer authors from text. */
export function createTopicTranscriptLoader({ store, sessionQuery, cache = new Map() } = {}) {
  if (!store || typeof store.getIdentity !== 'function' || typeof store.getDialogueEvents !== 'function' || !(cache instanceof Map)) {
    throw new TypeError('Topic transcript loader requires an identity store and a Map cache.');
  }
  const loadSingle = async function (job, { signal, referenceSink } = {}) {
    abort(signal);
    const expected = validateJob(job), cached = cache.has(job.id) ? cache.get(job.id) : null;
    const cachedById = new Map();
    if (cache.has(job.id)) {
      if (!Array.isArray(cached) || cached.length !== expected.size) mismatch('主题缓存没有覆盖完整证据。');
      for (const message of cached) {
        const source = expected.get(message?.id);
        if (!source || cachedById.has(message.id) || !plain(message) || message.speaker !== source.speaker
          || Object.keys(message).some(key => !['id', 'speaker', 'personId', 'text', 'at'].includes(key))) mismatch('主题缓存含重复、错误作者或未过滤字段。');
        cachedById.set(message.id, message);
      }
    }
    const canonical = id => store.getIdentity({ id })?.id;
    const sequences = new Map(), references = new Map(), parts = [];
    for (const person of job.participants) {
      abort(signal);
      const ids = [...person.sourceEventIds, ...job.selfEventIds], idSet = new Set(ids);
      let records;
      try { records = store.getDialogueEvents({ scope: person.scope, sourceEventIds: ids }); }
      catch { fail('SOURCE_UNAVAILABLE', '主题来源引用已不可用。'); }
      if (!Array.isArray(records) || records.length !== ids.length) mismatch('主题人物来源引用缺失或重复。');
      const seen = new Set();
      for (const record of records) {
        const source = expected.get(record?.eventId);
        if (!plain(record) || !idSet.has(record.eventId) || seen.has(record.eventId) || !source
          || record.speaker !== source.speaker || !sameScope(record.scope, person.scope)
          || record.sessionId !== job.sessionId || record.turnId !== job.turnId || !validId(record.sourceMessageId)
          || record.eventId !== `${source.speaker === 'self' ? 'assistant' : 'user'}:${record.sourceMessageId}`) mismatch('主题来源元数据不匹配。');
        if (source.speaker === 'self' ? record.authorId !== 'self' : !canonical(person.personId)
          || canonical(record.authorId) !== canonical(person.personId)) mismatch('主题来源作者不匹配。');
        let ref;
        try { ref = JSON.parse(record.sourceRef); } catch { mismatch('主题来源引用无效。'); }
        if (!plain(ref) || !Number.isSafeInteger(ref.sessionEventSeq) || ref.sessionEventSeq < 0
          || ref.turn !== Number(job.turnId)) mismatch('主题来源缺少可信事件位置或轮次。');
        if (source.speaker === 'self' && person.scope.kind !== 'local-owner') {
          if (typeof ref.replyOnlyMarked !== 'boolean') fail('QQ_REPLY_POLICY_MISSING', '共享 QQ 回复缺少可信标记策略。');
          if (ref.delivery !== 'generated-not-confirmed-sent') mismatch('共享 QQ 回复缺少生成与送达状态区分。');
        }
        const collision = sequences.get(ref.sessionEventSeq);
        if (collision && collision !== record.eventId) mismatch('不同发言不能占用同一事件序号。');
        const prior = references.get(record.eventId);
        if (prior && (source.speaker !== 'self' || prior.seq !== ref.sessionEventSeq
          || prior.replyOnlyMarked !== ref.replyOnlyMarked || prior.delivery !== ref.delivery)) mismatch('共享助手来源的位置或回复策略冲突。');
        if (!prior) references.set(record.eventId, { seq: ref.sessionEventSeq, replyOnlyMarked: ref.replyOnlyMarked, delivery: ref.delivery });
        sequences.set(ref.sessionEventSeq, record.eventId); seen.add(record.eventId);
      }
      parts.push({ person, ids, records });
    }

    const responseCache = new Map(), merged = new Map();
    const query = typeof sessionQuery?.readEvent === 'function' ? { readEvent(request, requestSignal) {
      abort(requestSignal);
      const key = `${request.sessionId}:${request.seq}`;
      if (!responseCache.has(key)) responseCache.set(key, Promise.resolve().then(() => sessionQuery.readEvent(request, requestSignal)));
      return responseCache.get(key);
    } } : undefined;
    for (const { person, ids, records } of parts) {
      abort(signal);
      const syntheticId = `${job.id}:${person.personId}`, subcache = new Map();
      if (cached !== null) subcache.set(syntheticId, ids.map(id => cachedById.get(id)));
      const substore = { getIdentity: args => store.getIdentity(args), getDialogueEvents: () => records };
      const legacy = createTranscriptLoader({ store: substore, sessionQuery: query, cache: subcache });
      const messages = await legacy({ id: syntheticId, targetId: person.personId, scope: person.scope,
        sessionId: job.sessionId, turnId: job.turnId, sourceEventIds: ids }, signal);
      for (const message of messages) {
        const source = expected.get(message.id);
        if (!source || !references.has(message.id) || source.speaker !== message.speaker
          || (source.speaker === 'person' && source.personId !== person.personId)) mismatch('已恢复发言不属于声明的主题作者。');
        // Topic evidence keeps its historical identity aliases. Current canonical
        // ownership was already verified by the legacy participant loader.
        const normalized = { ...message, personId: source.personId }, prior = merged.get(message.id);
        if (prior && (source.speaker !== 'self' || prior.text !== normalized.text || prior.personId !== 'self')) mismatch('共享助手发言在不同人物来源下不一致。');
        if (!prior) merged.set(message.id, normalized);
      }
    }
    if (merged.size !== expected.size || [...expected.keys()].some(id => !merged.has(id))) mismatch('主题恢复未覆盖完整证据，拒绝部分摘要。');
    abort(signal);
    if (referenceSink) for (const [id, reference] of references) referenceSink.set(id, reference);
    return [...merged.values()].sort((a, b) => references.get(a.id).seq - references.get(b.id).seq);
  };
  return async function load(job, { signal } = {}) {
    abort(signal);
    if (!Object.hasOwn(job ?? {}, 'turns')) return loadSingle(job, { signal });
    const expected = validateJob(job);
    if (!Array.isArray(job.turns) || !job.turns.length || job.turns.length > 300) mismatch('连续对话缺少完整轮次。');
    const canonical = id => store.getIdentity({ id })?.id;
    const canonicalAuthors = new Map();
    for (const person of job.participants) {
      const id = canonical(person.personId);
      if (!id || id === 'self' || canonicalAuthors.has(id)) mismatch('连续对话的聚合人物无法唯一解析。');
      canonicalAuthors.set(id, person);
    }
    const seen = new Set(), tasks = []; let lastTurn = -1;
    for (const turn of job.turns) {
      if (!plain(turn) || Object.keys(turn).length !== 4
        || Object.keys(turn).some(key => !['turnId', 'participants', 'selfEventIds', 'at'].includes(key))
        || typeof turn.turnId !== 'string' || !/^(0|[1-9]\d*)$/.test(turn.turnId)
        || !Number.isSafeInteger(Number(turn.turnId)) || Number(turn.turnId) <= lastTurn
        || typeof turn.at !== 'string' || turn.at.length > 40 || !Number.isFinite(Date.parse(turn.at))
        || !Array.isArray(turn.participants)) mismatch('连续对话轮次信息无效或顺序错误。');
      lastTurn = Number(turn.turnId);
      const scope = job.scope.kind === 'qq-group' ? { kind: 'qq-group', groupId: job.scope.groupId,
        qqIds: turn.participants.map(person => person?.scope?.qqId) } : { ...job.scope };
      const single = { id: `${job.id}:turn:${turn.turnId}`, sessionId: job.sessionId, turnId: turn.turnId,
        scope, participants: turn.participants, selfEventIds: turn.selfEventIds };
      const perTurn = validateJob(single);
      for (const person of turn.participants) {
        const aggregate = canonicalAuthors.get(canonical(person.personId));
        if (!aggregate || !sameScope(aggregate.scope, person.scope)) mismatch('历史轮次人物不属于本次聚合对话。');
        for (const id of person.sourceEventIds) if (expected.get(id)?.personId !== aggregate.personId) mismatch('轮次证据不能转移到其他聚合人物。');
      }
      for (const [id, source] of perTurn) {
        if (seen.has(id) || !expected.has(id) || expected.get(id).speaker !== source.speaker) mismatch('不同轮次证据重复或超出聚合范围。');
        seen.add(id);
      }
      tasks.push(single);
    }
    if (String(lastTurn) !== job.turnId || seen.size !== expected.size || [...expected.keys()].some(id => !seen.has(id))) mismatch('连续对话轮次未覆盖全部聚合证据。');
    const merged = new Map(), sequences = new Map(), references = new Map();
    for (const single of tasks) {
      const partReferences = new Map();
      // Each turn has only its actual participants and public replies. In
      // particular, a later participant never needs earlier self references.
      const messages = await loadSingle(single, { signal, referenceSink: partReferences });
      for (const message of messages) {
        const source = expected.get(message.id), reference = partReferences.get(message.id);
        if (!source || !reference || merged.has(message.id) || source.speaker !== message.speaker
          || (source.speaker === 'person' && canonical(source.personId) !== canonical(message.personId))) mismatch('恢复的连续对话人物与聚合证据不一致。');
        if (sequences.has(reference.seq)) mismatch('不同轮次的发言不能共享同一事件序号。');
        sequences.set(reference.seq, message.id); references.set(message.id, reference);
        merged.set(message.id, { ...message, personId: source.personId });
      }
    }
    if (merged.size !== expected.size) mismatch('连续对话恢复不完整。');
    abort(signal);
    return [...merged.values()].sort((a, b) => references.get(a.id).seq - references.get(b.id).seq);
  };
}
