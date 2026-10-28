import { extractSpokenText } from './memory-context.mjs';
import { trustedOwnerSource, trustedQQSource } from './scope.mjs';

export class TranscriptError extends Error {
  constructor(code, message) { super(message); this.name = 'TranscriptError'; this.code = code; }
}
const fail = (code, message) => { throw new TranscriptError(code, message); };
const mismatch = message => fail('SOURCE_MISMATCH', message);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[\u0000-\u001f\u007f]/.test(value);
const qqId = value => typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
const validAt = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));
const aborted = signal => { if (signal?.aborted) fail('ABORTED', '摘要来源读取已取消。'); };

function validScope(scope) {
  if (!plain(scope)) return false;
  if (scope.kind === 'local-owner') return !scope.qqId && !scope.groupId;
  if (scope.kind === 'qq-direct') return qqId(scope.qqId) && !scope.groupId;
  return scope.kind === 'qq-group' && qqId(scope.qqId) && qqId(scope.groupId);
}
const sameScope = (left, right) => validScope(left) && validScope(right)
  && left.kind === right.kind && left.qqId === right.qqId && left.groupId === right.groupId;

/** Match the verified bridge output-selection contract, without claiming successful delivery. */
export function extractReplyText(message, { kind, replyOnlyMarked } = {}) {
  const text = extractSpokenText({ ...message, role: 'assistant' });
  if (kind === 'local-owner') return text;
  if (!['qq-group', 'qq-direct'].includes(kind)) mismatch('回复来源的会话类型无效。');
  if (typeof replyOnlyMarked !== 'boolean') fail('QQ_REPLY_POLICY_MISSING', 'QQ 来源缺少可信的回复标记策略。');
  const clean = value => String(value || '').replace(/\[\s*\/?\s*QQ\s*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!replyOnlyMarked) return clean(text);
  const block = /\[QQ\]([\s\S]*?)\[\/QQ\]/.exec(text);
  if (block && String(block[1] || '').trim()) return clean(block[1]);
  const open = text.indexOf('[QQ]');
  const tail = open >= 0 ? text.slice(open + 4) : '';
  return String(tail).trim() ? clean(tail) : '';
}

/** Only resolves recorded source references. It never persists conversation bodies. */
export function createTranscriptLoader({ store, sessionQuery, cache = new Map() } = {}) {
  if (!store || typeof store.getIdentity !== 'function' || typeof store.getDialogueEvents !== 'function'
    || !(cache instanceof Map)) throw new TypeError('Transcript loader requires an identity store and a Map cache.');

  const canonical = targetId => {
    if (!id(targetId)) mismatch('摘要人物标识无效。');
    const identity = store.getIdentity({ id: targetId });
    if (!identity || !id(identity.id) || identity.id === 'self') mismatch('摘要人物已无法解析。');
    return identity;
  };
  const finalMessage = (message, targetId) => ({ id: message.id, speaker: message.speaker,
    personId: message.speaker === 'self' ? 'self' : targetId, text: message.text, at: message.at });

  return async function load(job, signal) {
    aborted(signal);
    if (!plain(job) || !id(job.id) || !id(job.sessionId) || !validScope(job.scope)
      || typeof job.turnId !== 'string' || !/^(0|[1-9]\d*)$/.test(job.turnId)
      || !Number.isSafeInteger(Number(job.turnId)) || !Array.isArray(job.sourceEventIds)
      || !job.sourceEventIds.length || job.sourceEventIds.some(value => !id(value))
      || new Set(job.sourceEventIds).size !== job.sourceEventIds.length) mismatch('摘要任务来源信息不完整。');
    const identity = canonical(job.targetId), targetId = identity.id;
    if (job.scope.kind === 'local-owner' ? targetId !== 'owner' : identity.qqId !== job.scope.qqId) {
      mismatch('摘要人物与可信会话作用域不一致。');
    }
    const expected = new Set(job.sourceEventIds);
    if (cache.has(job.id)) {
      const messages = cache.get(job.id);
      if (!Array.isArray(messages) || messages.length !== expected.size) mismatch('本轮缓存未覆盖全部摘要来源。');
      const seen = new Set();
      const result = messages.map(message => {
        if (!plain(message) || Object.keys(message).some(key => !['id', 'speaker', 'personId', 'text', 'at'].includes(key))
          || !expected.has(message.id) || seen.has(message.id) || !['person', 'self'].includes(message.speaker)
          || !message.id.startsWith(message.speaker === 'self' ? 'assistant:' : 'user:')
          || typeof message.text !== 'string' || !message.text.trim() || !validAt(message.at)) mismatch('本轮缓存不是完整的已过滤实际发言。');
        if (message.speaker === 'self' ? message.personId !== 'self' : canonical(message.personId).id !== targetId) {
          mismatch('本轮缓存含其他人物的发言。');
        }
        seen.add(message.id);
        return finalMessage(message, targetId);
      });
      if (!result.some(message => message.speaker === 'person')) mismatch('摘要缺少目标人物的实际发言。');
      aborted(signal);
      return result;
    }

    if (typeof sessionQuery?.readEvent !== 'function') fail('SOURCE_UNAVAILABLE', '会话事件读取接口不可用。');
    let records;
    try { records = store.getDialogueEvents({ scope: job.scope, sourceEventIds: job.sourceEventIds }); }
    catch { fail('SOURCE_UNAVAILABLE', '摘要来源引用已不可用。'); }
    if (!Array.isArray(records) || records.length !== expected.size) mismatch('摘要来源引用不完整或重复。');
    const seen = new Set(), sequences = new Set(), policies = new Set();
    const references = records.map(record => {
      if (!plain(record) || !expected.has(record.eventId) || seen.has(record.eventId)
        || !sameScope(record.scope, job.scope) || record.sessionId !== job.sessionId || record.turnId !== job.turnId
        || !['person', 'self'].includes(record.speaker) || !id(record.sourceMessageId) || !validAt(record.at)
        || record.eventId !== `${record.speaker === 'self' ? 'assistant' : 'user'}:${record.sourceMessageId}`) {
        mismatch('登记的摘要来源与任务不一致。');
      }
      if (record.speaker === 'self' ? record.authorId !== 'self' : canonical(record.authorId).id !== targetId) {
        mismatch('登记的摘要来源属于其他人物。');
      }
      let ref;
      try { ref = JSON.parse(record.sourceRef); } catch { mismatch('摘要来源引用不是有效 JSON。'); }
      if (!plain(ref) || !Number.isSafeInteger(ref.sessionEventSeq) || ref.sessionEventSeq < 0
        || sequences.has(ref.sessionEventSeq) || !Number.isSafeInteger(ref.turn) || ref.turn !== Number(job.turnId)) {
        mismatch('摘要来源的事件位置或轮次无效。');
      }
      if (record.speaker === 'self' && job.scope.kind !== 'local-owner') {
        if (typeof ref.replyOnlyMarked !== 'boolean') fail('QQ_REPLY_POLICY_MISSING', 'QQ 回复来源缺少可信的回复标记策略。');
        if (ref.delivery !== 'generated-not-confirmed-sent') mismatch('QQ 回复来源缺少生成与送达状态区分。');
        policies.add(ref.replyOnlyMarked);
      }
      seen.add(record.eventId); sequences.add(ref.sessionEventSeq);
      return { record, ref };
    }).sort((a, b) => a.ref.sessionEventSeq - b.ref.sessionEventSeq);

    const result = [];
    for (const { record, ref } of references) {
      aborted(signal);
      let response;
      try { response = await sessionQuery.readEvent({ sessionId: job.sessionId, seq: ref.sessionEventSeq, before: 0, after: 0 }, signal); }
      catch { aborted(signal); fail('SOURCE_UNAVAILABLE', '登记的原始会话事件无法读取。'); }
      aborted(signal);
      const event = response?.target, self = record.speaker === 'self';
      if (response?.session?.id !== job.sessionId || !event || event.seq !== ref.sessionEventSeq
        || event.type !== (self ? 'assistant/message' : 'user/message')) mismatch('会话查询返回了不同的来源事件。');
      if (self && (event.data?.turn !== ref.turn || event.data?.interrupted)) mismatch('助手来源不是本轮的完整回复。');
      const message = self ? event.data?.message : event.data;
      if (!plain(message) || message.id !== record.sourceMessageId
        || (message.role !== undefined && message.role !== (self ? 'assistant' : 'user'))) mismatch('会话消息身份或类型不一致。');
      if (!self) {
        if (job.scope.kind === 'local-owner') {
          if (!trustedOwnerSource(message.source)) mismatch('本机主人发言缺少可信的主人来源。');
        } else {
          const source = trustedQQSource(message.source);
          if (!source || source.qqId !== job.scope.qqId || (job.scope.kind === 'qq-group'
            ? source.chatType !== 'group' || source.groupId !== job.scope.groupId
            : source.chatType !== 'direct' || source.chatId !== job.scope.qqId)) mismatch('QQ 发言属于其他人物或会话。');
          if (typeof source.replyOnlyMarked !== 'boolean') fail('QQ_REPLY_POLICY_MISSING', 'QQ 来源缺少可信的回复标记策略。');
          policies.add(source.replyOnlyMarked);
        }
      }
      const text = self ? extractReplyText(message, { kind: job.scope.kind, replyOnlyMarked: ref.replyOnlyMarked })
        : extractSpokenText({ ...message, role: 'user' });
      if (!text) mismatch('已登记的来源没有可概括的实际发言。');
      result.push(finalMessage({ id: record.eventId, speaker: record.speaker, text, at: record.at }, targetId));
    }
    if (policies.size > 1) mismatch('同轮 QQ 来源的回复标记策略冲突。');
    if (!result.some(message => message.speaker === 'person')) mismatch('摘要缺少目标人物的实际发言。');
    aborted(signal);
    return result;
  };
}
