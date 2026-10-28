// Source metadata is supplied by a transport adapter, never parsed from message text.
export function trustedQQSource(source) {
  const v = source?.kind === 'qq' ? source.identityVault : null;
  const valid = value => typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
  if (!v || v.version !== 1 || v.transport !== 'onebot11' || !valid(v.qqId)) return null;
  if (v.chatType === 'group' && valid(v.groupId) && v.chatId === v.groupId) return { ...v };
  if (v.chatType === 'direct' && valid(v.chatId) && v.qqId === v.chatId && !v.groupId) return { ...v };
  return null;
}

export function makeScope() {
  return { turn: null, local: false, remote: false, unknown: true, claimedCount: 0, messages: new Map(), groups: new Set(), people: new Set() };
}

export function trustedOwnerSource(source) {
  // The desktop UI creates a bare UUID v4 requestId. Known IM bridges prefix
  // their RPC IDs and must not inherit desktop-owner authority.
  return source?.kind === 'user' && typeof source.rpcId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.rpcId)
    && (source.principal === undefined || source.principal?.kind === 'owner');
}

export function isHostControlSource(source) {
  // DSH ApprovalService.setPolicy injects this user-role notice into the inbox.
  // It is policy metadata, not a participant or proof of owner authority. Keep
  // this allowlist exact: unknown/synthetic/IM sources must still taint a turn.
  return source?.kind === 'user-approval' && Object.keys(source).length === 1;
}

export function addSource(scope, { message, turn }) {
  if (scope.turn !== turn) Object.assign(scope, makeScope(), { turn });
  if (!message || message.role !== 'user') return scope;
  if (isHostControlSource(message.source)) return scope;
  if (scope.claimedCount++ === 0) scope.unknown = false;
  const source = trustedQQSource(message.source);
  if (source) {
    scope.remote = true;
    scope.messages.set(message.id, { ...source, messageId: message.id });
    scope.people.add(source.qqId);
    if (source.groupId) scope.groups.add(source.groupId);
  } else if (trustedOwnerSource(message.source)) {
    scope.local = true;
  } else {
    // Mixed, synthetic, unsupported and legacy sources cannot gain local authority.
    scope.remote = true;
    scope.unknown = true;
  }
  return scope;
}

export function getAccess(scope, ownerQQ = null) {
  const localOwner = scope.local && !scope.remote && !scope.unknown;
  const qqOwner = !scope.local && !scope.unknown && scope.people.size === 1 && scope.people.has(ownerQQ);
  const groupId = scope.groups.size === 1 ? [...scope.groups][0] : null;
  const chats = new Set([...scope.messages.values()].map(v => `${v.chatType}:${v.chatId}`));
  return { localOwner, qqOwner, owner: localOwner || qqOwner, groupId,
    ambiguous: scope.unknown || scope.groups.size > 1 || chats.size > 1 || (scope.local && scope.remote) };
}
