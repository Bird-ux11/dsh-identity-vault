import { createHash, randomUUID } from 'node:crypto';
import { getAccess } from './scope.mjs';
import { isExpiredEvent } from './event-retention.mjs';
import { eventRevisionHash } from './memory-revisions.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string = description => ({ type: 'string', description });
function parse(value, name, limit = 100000) {
  if (typeof value !== 'string' || value.length > limit) fail('INVALID_ARGUMENT', `${name}不是有效的有界JSON文本。`);
  try { const result = JSON.parse(value); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; }
  catch { fail('INVALID_ARGUMENT', `${name}须为JSON对象。`); }
}
const common = { revisionId: string('本次修订的唯一ID；重试同一请求时复用。省略则自动生成。'), reason: string('简短纠错原因；审计仅保存其哈希。') };

/** Correction authority comes only from trusted host identity. The user supplies
 * which record is wrong; old memory and summaries cannot grant mutation rights. */
export function registerRevisionTools(agentCtx, { expectedAgent, store, topicStore, revisions,
  currentScope, isSubagent = () => false, onChange = () => {}, now = Date.now } = {}) {
  const disposers = [];
  function access() {
    const current = currentScope();
    const owner = store.getIdentity({ id: 'owner', includePrivate: true })?.qqId;
    const result = getAccess(current, owner);
    if (isSubagent() || result.ambiguous || !result.owner) fail('OWNER_REQUIRED', '记忆修订需要可信主人身份；可在本机主人对话中操作。');
    return { ...result, current };
  }
  function target(id, a) {
    if (typeof id !== 'string') fail('INVALID_ARGUMENT', '人物ID须为self、owner或QQ号。');
    const selector = ['self', 'owner'].includes(id) ? { id } : { qqId: id };
    const identity = store.getIdentity({ ...selector, includePrivate: a.localOwner, groupId: a.groupId || undefined });
    if (!identity || (!a.localOwner && identity.id !== 'self' && !a.current.people.has(identity.qqId))) fail('OUT_OF_SCOPE', '当前对话不能修订该人物；请在本机主人对话操作。');
    return identity;
  }
  function scope(a) { return a.localOwner ? { kind: 'local-owner' } : a.groupId ? { kind: 'qq-group', groupId: a.groupId } : { kind: 'qq-direct', qqId: [...a.current.people][0] }; }
  function personView(identity, a) {
    const options = { id: identity.id, scope: scope(a), crossGroup: Boolean(a.groupId), includePrivate: a.localOwner };
    const currentState = store.getMemoryState(options);
    return { identity, currentState, profileHash: digest({ profile: identity.profile, currentState }),
      longTermImpressions: store.getLongTermImpressions(options), importantEvents: store.getCoreEvents(options) };
  }
  function eventFor(eventId, a) {
    if (typeof eventId !== 'string' || !/^[a-f0-9]{64}$/.test(eventId)) fail('INVALID_ARGUMENT', '需要读取到的真实事件ID。');
    const event = topicStore.getEvent(eventId);
    if (!event) fail('EVENT_NOT_FOUND', '未找到事件。');
    const source = event.scope ? event : store.listCoreEvents({ includeRevoked: true }).find(item => item.id === event.id);
    if (!a.localOwner && !(a.groupId && source?.scope?.kind === 'qq-group'
      && source.participants?.some(person => a.current.people.has(person.scope?.qqId ?? person.qqId)))
      && !(source?.scope?.kind === 'qq-direct' && a.current.people.has(source.scope.qqId))) fail('OUT_OF_SCOPE', '当前对话不能查看或修订这条记忆；请在本机主人对话操作。');
    return event;
  }
  function visibleImpressionScope(value, a) {
    if (a.localOwner) return;
    if (a.groupId ? value.kind === 'qq-group' : value.kind === 'qq-direct' && a.current.people.has(value.qqId)) return;
    fail('OUT_OF_SCOPE', '当前对话不能撤回这条私密印象；请在本机主人对话操作。');
  }
  function add(name, description, properties, required, execute, readOnly = false) {
    disposers.push(agentCtx.tools.register({ name, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => readOnly,
      async execute(args, exec = {}) {
        try {
          exec.signal?.throwIfAborted();
          if (exec.agent !== expectedAgent) fail('AGENT_SCOPE_MISMATCH', '修订工具不属于当前会话。');
          if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(properties, key))
            || required.some(key => !Object.hasOwn(args, key))) fail('INVALID_ARGUMENT', '修订参数不完整或含额外字段。');
          for (const [key, value] of Object.entries(args)) {
            const schema = properties[key];
            if ((schema.type === 'string' && typeof value !== 'string')
              || (schema.type === 'integer' && !Number.isInteger(value))
              || (schema.enum && !schema.enum.includes(value))) fail('INVALID_ARGUMENT', '修订参数类型或选项无效。');
          }
          const a = access();
          const result = execute(args, a);
          return JSON.stringify(result);
        } catch (error) { return JSON.stringify({ ok: false, code: error.code || 'REVISION_FAILED', message: error.message }); }
      },
    }));
  }
  add('memory_inspect_record', '主人纠错前读取准确记录与版本。identity返回已确认资料、当前状态、长期推测印象和profileHash；event返回原时间、内容哈希及尚未淡忘的结构化摘要。不要凭标题编造修订内容。',
    { kind: { type: 'string', enum: ['identity', 'event'] }, id: string('self、owner、人物QQ号或完整事件ID。') }, ['kind', 'id'], (args, a) => {
      if (args.kind === 'identity') return { ok: true, ...personView(target(args.id, a), a) };
      if (args.kind !== 'event') fail('INVALID_ARGUMENT', '未知记录类型。');
      const event = eventFor(args.id, a);
      const body = event.status === 'active' && !isExpiredEvent(event, now()) && !revisions.pendingEvent(event.id)
        ? topicStore.readEvent(event.id).body : undefined;
      return { ok: true, event, expectedContentHash: eventRevisionHash(store, event), ...(body ? { body } : {}),
        pending: revisions.pendingEvent(event.id), importantEvents: store.getCoreEvents({ eventId: event.id,
          scope: scope(a), includePrivate: a.localOwner, crossGroup: Boolean(a.groupId) }) };
    }, true);
  add('memory_correct_event', '仅在主人明确指出错误或要求撤回时调用。先memory_inspect_record读取事件与expectedContentHash。retract撤回事件及其长期投影；replace提交完整修正摘要bodyJson，保留原作者、来源与时间。修订不延长十天寿命。相关推测印象会撤下，修正摘要不自动再升为长期事实。过期Skill不能重建；过期事件的MCP错误投影仍可retract。',
    { eventId: string('完整事件ID'), expectedContentHash: string('刚读取的事件内容哈希'), action: { type: 'string', enum: ['replace', 'retract'] },
      bodyJson: string('replace时为完整原结构摘要JSON；只更正实际内容，不伪造来源。retract不填写。'), revisionId: common.revisionId },
    ['eventId', 'expectedContentHash', 'action'], (args, a) => {
      eventFor(args.eventId, a);
      if (args.action === 'retract' && args.bodyJson !== undefined) fail('INVALID_ARGUMENT', '撤回不接受替换正文。');
      const result = revisions.correctEvent({ eventId: args.eventId, expectedContentHash: args.expectedContentHash, action: args.action,
        revisionId: args.revisionId, ...(args.action === 'replace' ? { body: parse(args.bodyJson, 'bodyJson') } : {}) });
      onChange(); return result;
    });
  add('memory_correct_profile', '主人明确纠正身份资料或长期状态时调用。先inspect identity取得profileHash，patchJson合并明确值，null清除错误字段；self/owner保持同一身份。此操作不会把推测印象提升为事实，也不自动修改历史事件；若历史事件本身有误应另行撤回该事件。',
    { id: string('self、owner或人物QQ号'), expectedProfileHash: string('刚读取的profileHash'),
      patchJson: string('已确认资料补丁JSON。支持原identity_update_profile字段，null清除。'), ...common },
    ['id', 'expectedProfileHash', 'patchJson'], (args, a) => {
      const identity = target(args.id, a), before = personView(identity, a), revisionId = args.revisionId ?? randomUUID();
      const receipt = store.getRevisionRecord(revisionId);
      if (!receipt && before.profileHash !== args.expectedProfileHash) fail('REVISION_CONFLICT', '人物资料已变化，请重新读取再修订。');
      store.updateProfile({ id: identity.id, patch: parse(args.patchJson, 'patchJson', 16000), actor: 'owner',
        groupId: a.groupId || undefined, revisionId, reason: args.reason });
      // Store receipts validate the full target/patch/reason even on retry.
      // Re-read through the current transport view: owner authority on QQ does
      // not authorize returning all local/private history in a tool response.
      onChange(); return { ok: true, revisionId, alreadyApplied: Boolean(receipt), identity: target(args.id, a) };
    });
  add('memory_retract_impression', '主人明确否定某条推测印象时撤回。先inspect identity取得key、dimension和scope。保留内容无关的修订记录，并阻止旧证据再次生成该印象；新的独立证据仍需满足3事件跨2日。不会改写已确认人格。',
    { id: string('self、owner或人物QQ号'), key: string('印象key'), dimension: { type: 'string', enum: ['speakingStyle', 'interactionStyle'] },
      scopeJson: string('inspect返回的该条印象scope JSON'), ...common }, ['id', 'key', 'dimension', 'scopeJson'], (args, a) => {
      const identity = target(args.id, a), requestedScope = parse(args.scopeJson, 'scopeJson', 1000);
      visibleImpressionScope(requestedScope, a);
      const revisionId = args.revisionId ?? randomUUID(), receipt = store.getRevisionRecord(revisionId);
      const available = personView(identity, a).longTermImpressions;
      const chosen = available.find(item => item.key === args.key && item.dimension === args.dimension && digest(item.scope) === digest(requestedScope));
      if (!chosen && !receipt) fail('IMPRESSION_NOT_FOUND', '当前可见的印象已变化或不存在，请重新读取。');
      const result = store.retractLongTermImpression({ personId: identity.id, scope: chosen?.scope ?? requestedScope, key: args.key, dimension: args.dimension,
        revisionId, actor: 'owner', reason: args.reason });
      onChange(); return { ok: true, ...result };
    });
  add('memory_revision_history', '本机主人查看修订审计及待重试状态。审计只有目标、动作、时间和哈希等信息，不保存旧聊天正文；不自动回滚已撤销的错误。',
    { limit: { type: 'integer', minimum: 1, maximum: 100 } }, [], (args, a) => {
      if (!a.localOwner) fail('OWNER_RPC_REQUIRED', '完整修订审计仅在本机主人对话提供。');
      const limit = args.limit ?? 30;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_ARGUMENT', 'limit需要1至100。');
      return { ok: true, history: store.getRevisionAudit({ limit }), recovery: revisions.stats() };
    }, true);
  return () => { for (const dispose of disposers) dispose?.(); };
}
