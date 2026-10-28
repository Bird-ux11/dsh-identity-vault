/** Self-contained: the checked QQ adapter embeds this function into its bridge patch. */
export function createQqConversationRuntime(ctx, hooks) {
  const fail = (code, message = code) => { const error = new Error(message); error.code = code; throw error; };
  const clone = value => structuredClone(value);
  const qq = value => typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value);
  const key = (groupId, messageId) => JSON.stringify([groupId, messageId]);
  const now = hooks.now || Date.now;
  let subscriber = null, disposed = false;
  const statuses = new Set(), active = new Map(), preparing = new Set(), contextFibers = new Map(), sending = new Map();
  const saved = hooks.loadState();
  if (!saved || saved.version !== 1 || !Array.isArray(saved.events) || !Array.isArray(saved.receipts)) fail('BRIDGE_STATE_INVALID');
  const records = new Map(saved.events.map(record => [key(record.groupId, record.messageId), record]));
  const receipts = new Map(saved.receipts.map(record => [record.key, record]));
  for (const record of records.values()) {
    if (!qq(record.groupId) || !qq(record.authorId) || !id(record.messageId) || !id(record.sessionId)
      || !Number.isSafeInteger(record.time) || typeof record.text !== 'string' || !Array.isArray(record.images)) fail('BRIDGE_STATE_INVALID');
  }
  for (const receipt of receipts.values()) if (!id(receipt.taskId) || !qq(receipt.groupId) || typeof receipt.key !== 'string'
    || !['pending', 'sent', 'failed', 'uncertain'].includes(receipt.state)) fail('BRIDGE_STATE_INVALID');
  const persist = admissionKey => {
    // Scheduler queues can outlive the bridge's active Agent task. Preserve their
    // exact transport records as well; copied scheduler text is never identity evidence.
    const pinned = new Set([...active.values()].flatMap(task => task.messageIds.map(messageId => key(task.groupId, messageId))));
    if (admissionKey) pinned.add(admissionKey);
    if (subscriber?.retainMessageIds) {
      let retained;
      try { retained = subscriber.retainMessageIds(); } catch { fail('RETAIN_MESSAGE_IDS_UNAVAILABLE'); }
      if (!Array.isArray(retained) || retained.length > 8000
        || retained.some(item => !item || !qq(item.groupId) || !id(item.messageId))) fail('INVALID_RETAIN_MESSAGE_IDS');
      const selectedGroups = new Set(allBindings().map(row => row.groupId)
        .filter(groupId => subscriber.groupIds === null || subscriber.groupIds.has(groupId)));
      for (const item of retained) if (selectedGroups.has(item.groupId)) pinned.add(key(item.groupId, item.messageId));
    }
    const droppedRecords = [], droppedReceipts = [];
    let recordSize = records.size, receiptSize = receipts.size;
    if (recordSize > 8000) for (const recordKey of records.keys()) {
      if (!pinned.has(recordKey)) { droppedRecords.push(recordKey); recordSize--; }
      if (recordSize <= 8000) break;
    }
    if (recordSize > 8000) fail('BRIDGE_EVENT_CAPACITY');
    if (receiptSize > 4000) for (const [receiptKey, receipt] of receipts) {
      if (receipt.state !== 'pending' && ![...active.values()].some(task => task.taskId === receipt.taskId)) { droppedReceipts.push(receiptKey); receiptSize--; }
      if (receiptSize <= 4000) break;
    }
    const omitRecords = new Set(droppedRecords), omitReceipts = new Set(droppedReceipts);
    hooks.saveState({ version: 1, events: [...records].filter(([recordKey]) => !omitRecords.has(recordKey)).map(([, record]) => record),
      receipts: [...receipts].filter(([receiptKey]) => !omitReceipts.has(receiptKey)).map(([, receipt]) => receipt) });
    for (const recordKey of droppedRecords) records.delete(recordKey);
    for (const receiptKey of droppedReceipts) receipts.delete(receiptKey);
  };
  const allBindings = () => {
    const config = hooks.readConfig();
    return (config.绑定 || []).filter(row => row.类型 === '群' && qq(String(row.号码)) && id(hooks.sessionKey(row.会话)))
      .map(row => ({ groupId: String(row.号码), sessionId: hooks.sessionKey(row.会话) }));
  };
  const binding = groupId => {
    if (!qq(groupId)) fail('INVALID_GROUP');
    const config = hooks.readConfig();
    const matches = (config.绑定 || []).filter(row => row.类型 === '群' && String(row.号码) === groupId);
    if (matches.length !== 1) fail('GROUP_BINDING_AMBIGUOUS');
    const row = matches[0], sessionId = hooks.sessionKey(row.会话);
    if (!id(sessionId) || (config.绑定 || []).filter(other => hooks.sessionKey(other.会话) === sessionId).length !== 1) fail('SESSION_BINDING_AMBIGUOUS');
    return row;
  };
  const selected = groupId => Boolean(!disposed && subscriber && (subscriber.groupIds === null || subscriber.groupIds.has(groupId))
    && allBindings().some(row => row.groupId === groupId));
  const ownsGroup = groupId => selected(groupId) && subscriber.exclusive;
  const ownsSession = sessionId => [...active.values()].some(task => task.sessionId === hooks.sessionKey(sessionId))
    || allBindings().some(row => row.sessionId === hooks.sessionKey(sessionId) && ownsGroup(row.groupId));
  const pending = agent => Boolean(agent?.inbox?.hasPending || agent?.inbox?.nextTurn?.length || agent?.inbox?.nextStep?.length);
  const available = agent => Boolean(agent && agent.status === 'idle' && !pending(agent));
  const notify = event => { for (const listener of statuses) try { listener(clone(event)); } catch {} };
  const summary = task => ({ taskId: task.taskId, groupId: task.groupId, sessionId: task.sessionId,
    agentId: String(task.agent.id || task.sessionId), messageIds: [...task.messageIds] });
  const taskFor = (input, requireAgent = false) => {
    const task = active.get(input.groupId);
    if (!task || task.taskId !== input.taskId || !ownsGroup(input.groupId)) fail('NO_ACTIVE_TASK');
    const row = binding(input.groupId);
    if (hooks.sessionKey(row.会话) !== task.sessionId || hooks.findAgent(row.会话) !== task.agent) fail('TASK_BINDING_CHANGED');
    if (requireAgent && input.agent !== task.agent) fail('AGENT_SCOPE_MISMATCH');
    return task;
  };
  const ensureContext = async agent => {
    if (contextFibers.has(agent)) return contextFibers.get(agent).ready;
    if (typeof agent.ctx?.inject !== 'function') fail('AGENT_CONTEXT_UNAVAILABLE');
    let registered = false;
    const entry = { fiber: null, ready: null };
    entry.fiber = agent.ctx.inject(['systemPrompt'], ready => {
      if (typeof ready.systemPrompt?.context !== 'function') fail('SYSTEM_PROMPT_UNAVAILABLE');
      ready.systemPrompt.context({ name: 'qq-conversation:task', order: 887, required: true, interpolate: false,
        text: () => [...active.values()].find(task => task.agent === agent)?.prompt || '' });
      registered = true;
    });
    entry.ready = Promise.resolve(entry.fiber).then(() => { if (!registered) fail('SYSTEM_PROMPT_UNAVAILABLE'); });
    contextFibers.set(agent, entry);
    try { await entry.ready; } catch (error) { contextFibers.delete(agent); await entry.fiber?.dispose?.(); throw error; }
  };

  const service = {
    version: 1,
    bindings: allBindings,
    subscribe(handler, options = {}) {
      if (disposed || subscriber) fail('BRIDGE_ALREADY_SUBSCRIBED');
      if (typeof handler !== 'function') fail('INVALID_HANDLER');
      if (options.groupIds !== undefined && (!Array.isArray(options.groupIds) || options.groupIds.some(value => !qq(value)))) fail('INVALID_GROUPS');
      if (options.retainMessageIds !== undefined && typeof options.retainMessageIds !== 'function') fail('INVALID_RETAIN_MESSAGE_IDS');
      const entry = { handler, groupIds: options.groupIds === undefined ? null : new Set(options.groupIds), exclusive: options.exclusive !== false,
        retainMessageIds: options.retainMessageIds };
      for (const groupId of entry.groupIds || new Set(allBindings().map(row => row.groupId))) binding(groupId);
      subscriber = entry;
      return () => { if (subscriber === entry) subscriber = null; };
    },
    subscribeStatus(listener) { if (typeof listener !== 'function') fail('INVALID_HANDLER'); statuses.add(listener); return () => statuses.delete(listener); },
    agentFor(groupId) { try { return hooks.findAgent(binding(groupId).会话) || null; } catch { return null; } },
    isIdle(groupId) { return ownsGroup(groupId) && !active.has(groupId) && !preparing.has(groupId) && available(service.agentFor(groupId)); },
    async resolveImages({ groupId, messageId, signal }) {
      if (!selected(groupId)) fail('GROUP_NOT_SELECTED');
      const row = binding(groupId), record = records.get(key(groupId, messageId));
      if (!record || record.sessionId !== hooks.sessionKey(row.会话)) fail('UNKNOWN_MESSAGE');
      const deadline = AbortSignal.timeout(4500);
      const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      boundedSignal.throwIfAborted();
      return hooks.prepareImages(row, clone(record), boundedSignal);
    },
    async deliverBatch(input) {
      if (!input || !id(input.taskId) || !qq(input.groupId) || typeof input.prompt !== 'string' || input.prompt.length > 24000
        || !Array.isArray(input.messageIds) || input.messageIds.length < 1 || input.messageIds.length > 64
        || input.messageIds.some(value => !id(value)) || new Set(input.messageIds).size !== input.messageIds.length) fail('INVALID_BATCH');
      if (!service.isIdle(input.groupId)) fail('AGENT_BUSY_OR_UNAVAILABLE');
      const row = binding(input.groupId), agent = hooks.findAgent(row.会话), sessionId = hooks.sessionKey(row.会话);
      const batch = input.messageIds.map(messageId => records.get(key(input.groupId, messageId)));
      if (batch.some(record => !record || record.sessionId !== sessionId || record.self)) fail('UNKNOWN_OR_SELF_MESSAGE');
      if (new Set(batch.map(record => record.authorId)).size > 8) fail('PARTICIPANT_LIMIT');
      if (batch.reduce((total, record) => total + record.text.length, 0) > 64000) fail('BATCH_TOO_LARGE');
      if (input.replyToMessageId != null && !input.messageIds.includes(input.replyToMessageId)) fail('INVALID_REPLY_TARGET');
      let nativeImages;
      if (input.nativeImages !== undefined) {
        if (!Array.isArray(input.nativeImages) || input.nativeImages.length > 2
          || new Set(input.nativeImages.map(image => image?.messageId)).size !== input.nativeImages.length
          || input.nativeImages.some(image => !batch.some(record => record.messageId === image?.messageId && record.images.length)
            || !(image.data instanceof Uint8Array) || !image.data.length || image.data.length > 8 * 1024 * 1024
            || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType))) fail('INVALID_NATIVE_IMAGES');
        nativeImages = input.nativeImages.map(image => ({ messageId: image.messageId, mediaType: image.mediaType, data: new Uint8Array(image.data) }));
      }
      if ([...receipts.values()].some(receipt => receipt.taskId === input.taskId)) fail('TASK_ALREADY_HAS_RECEIPT');
      preparing.add(input.groupId);
      const messages = [];
      let task;
      try {
        await ensureContext(agent);
        for (const record of batch) {
          const prefix = record.displayName + '（' + record.authorId + '）：';
          const content = await hooks.prepareContent(row, clone(record), prefix + record.text,
            nativeImages === undefined ? undefined : nativeImages.filter(image => image.messageId === record.messageId));
          const source = hooks.buildSource(row, { 号码: record.authorId, 昵称: record.displayName }, record.messageId,
            record.time, { start: prefix.length, length: record.text.length }, true);
          if (!source) fail('INVALID_SOURCE');
          // A task receipt, not a final assistant draft, determines what was public.
          source.conversationTaskId = input.taskId;
          messages.push({ id: hooks.uuid(), role: 'user', content, source: { kind: 'qq', identityVault: source } });
        }
        if (!ownsGroup(input.groupId) || hooks.findAgent(binding(input.groupId).会话) !== agent || !available(agent)) fail('AGENT_BUSY_OR_UNAVAILABLE');
        task = { taskId: input.taskId, groupId: input.groupId, sessionId, agent, messageIds: [...input.messageIds], prompt: input.prompt };
        active.set(input.groupId, task);
        // No awaits, I/O or control messages inside this batch commit. Followup wakes once.
        for (const message of messages.slice(0, -1)) agent.inject(message);
        agent.followup(messages.at(-1));
        const completion = agent.whenIdle();
        Promise.resolve(completion).then(() => {
          if (active.get(input.groupId) !== task) return;
          active.delete(input.groupId);
          notify({ ...summary(task), status: 'idle' });
        }, error => {
          if (active.get(input.groupId) !== task) return;
          active.delete(input.groupId);
          notify({ ...summary(task), status: 'error', error: String(error?.code || 'AGENT_FAILED') });
        });
        return summary(task);
      } catch (error) {
        // Roll back only still-pending messages owned by this failed admission.
        if (agent.status === 'idle') for (const message of messages) agent.inbox?.remove?.(message.id);
        if (active.get(input.groupId) === task) active.delete(input.groupId);
        throw error;
      } finally { preparing.delete(input.groupId); }
    },
    async sendReply(input) {
      if (!input || typeof input.text !== 'string' || input.text.length > 12000 || !Array.isArray(input.images || [])
        || (input.images || []).length > 4 || (!input.text.trim() && !(input.images || []).length)
        || (input.beforeSend !== undefined && typeof input.beforeSend !== 'function')) fail('INVALID_REPLY');
      const replyImages = (input.images || []).map(image => {
        if (typeof image === 'string' && image.length <= 4096) return image;
        if (!image || !(image.data instanceof Uint8Array) || !image.data.length || image.data.length > 8 * 1024 * 1024
          || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)) fail('INVALID_REPLY_IMAGE');
        return { data: new Uint8Array(image.data), mediaType: image.mediaType };
      });
      const task = taskFor(input, true), replyToMessageId = input.replyToMessageId ?? null;
      if (replyToMessageId !== null && !task.messageIds.includes(replyToMessageId)) fail('INVALID_REPLY_TARGET');
      const receiptKey = JSON.stringify([task.groupId, task.taskId, replyToMessageId]);
      const requestSignature = JSON.stringify({ text: input.text, images: replyImages.map(image => typeof image === 'string' ? image
        : { mediaType: image.mediaType, hash: hooks.hashBytes(image.data) }) });
      if (sending.has(receiptKey)) {
        if (sending.get(receiptKey).requestSignature !== requestSignature) fail('REPLY_ALREADY_ATTEMPTED');
        return sending.get(receiptKey).promise;
      }
      const previous = receipts.get(receiptKey);
      if (previous) {
        if (previous.requestSignature !== requestSignature) fail('REPLY_ALREADY_ATTEMPTED');
        return clone({ ...previous.result, ...(previous.state === 'pending' ? { ok: false, error: 'SEND_UNCERTAIN', uncertain: true } : {}) });
      }
      const send = async () => {
        const row = binding(task.groupId), config = hooks.readConfig();
        if (!config.总开关 || !config.转群 || config.试运行) fail(config.试运行 ? 'DRY_RUN' : 'SENDING_DISABLED');
        if (hooks.isArchived?.(task.sessionId)) fail('SESSION_ARCHIVED');
        const segments = await hooks.makeSegments(input.text, replyImages);
        taskFor(input, true);
        if (replyToMessageId !== null) segments.unshift({ type: 'reply', data: { id: replyToMessageId } });
        const base = { ok: false, taskId: task.taskId, groupId: task.groupId, replyToMessageId, messageId: null, time: now() };
        const receipt = { key: receiptKey, taskId: task.taskId, groupId: task.groupId, state: 'pending', requestSignature, result: base };
        receipts.set(receiptKey, receipt); persist();
        let result;
        let permitted = input.beforeSend === undefined;
        try { if (input.beforeSend) permitted = input.beforeSend() === true; } catch { permitted = false; }
        if (!permitted) result = { ok: false, error: 'group-no-longer-silent', confirmedNotSent: true, uncertain: false };
        else {
          // The installed send hook invokes fetch synchronously before its first await.
          // Keep this final activity guard and the network invocation in one JS stack.
          try { result = await hooks.send(row, segments); }
          catch { result = { ok: false, uncertain: true }; }
        }
        const messageId = result?.messageId == null ? null : String(result.messageId);
        receipt.state = result?.ok && id(messageId) ? 'sent' : result?.uncertain !== false ? 'uncertain' : 'failed';
        receipt.result = { ...base, ok: receipt.state === 'sent', messageId: receipt.state === 'sent' ? messageId : null,
          time: now(), ...(receipt.state !== 'sent' ? { error: result?.confirmedNotSent === true ? 'group-no-longer-silent'
            : receipt.state === 'uncertain' ? 'SEND_UNCERTAIN' : 'SEND_REJECTED', uncertain: receipt.state === 'uncertain',
            ...(result?.confirmedNotSent === true ? { confirmedNotSent: true } : {}) } : {}) };
        // Successful text is durable evidence, available to the vault through the task service.
        if (receipt.state === 'sent') { receipt.text = input.text; receipt.sourceMessageIds = [...task.messageIds]; }
        persist();
        return clone(receipt.result);
      };
      const promise = send().finally(() => sending.delete(receiptKey));
      sending.set(receiptKey, { promise, requestSignature });
      return promise;
    },
    receiptsFor(taskId, groupId) { return [...receipts.values()].filter(receipt => receipt.taskId === taskId && receipt.groupId === groupId)
      .map(receipt => clone({ state: receipt.state, ...receipt.result, text: receipt.text || '', sourceMessageIds: receipt.sourceMessageIds || [] })); },
  };

  const accept = async (row, raw, parsed, botId) => {
    const groupId = String(row.号码);
    if (!selected(groupId)) return { selected: false, exclusive: false, accepted: false };
    const owner = subscriber, exclusive = owner.exclusive;
    binding(groupId);
    const messageId = raw.message_id == null ? '' : String(raw.message_id), authorId = String(raw.user_id || '');
    if (!id(messageId) || !qq(authorId) || !qq(String(botId)) || !Number.isSafeInteger(raw.time) || raw.time <= 0) fail('INVALID_UPSTREAM_MESSAGE');
    const recordKey = key(groupId, messageId);
    let record = records.get(recordKey);
    if (!record) {
      const segments = Array.isArray(raw.message) ? raw.message : [];
      const replyId = segments.find(segment => segment?.type === 'reply')?.data?.id;
      let replyTo = null;
      if (replyId != null && id(String(replyId))) {
        const referenced = records.get(key(groupId, String(replyId)));
        const sent = [...receipts.values()].find(receipt => receipt.groupId === groupId && receipt.state === 'sent' && receipt.result.messageId === String(replyId));
        let original = referenced ? { authorId: referenced.authorId, text: referenced.text } : null;
        if (!original && !sent && hooks.resolveReference) original = await hooks.resolveReference(groupId, String(replyId));
        replyTo = { id: String(replyId), authorId: original?.authorId || (sent ? String(botId) : null),
          self: Boolean(sent || original?.authorId === String(botId) || hooks.isOwnMessage?.(String(replyId))), text: original?.text || sent?.text || null };
      }
      record = { version: 1, groupId, sessionId: hooks.sessionKey(row.会话), messageId, authorId,
        displayName: String(raw.sender?.card || raw.sender?.nickname || raw.nickname || 'QQ ' + authorId).replace(/[\u0000-\u001f]/g, '').slice(0, 200),
        botId: String(botId), self: authorId === String(botId), time: raw.time * 1000, receivedAt: now(),
        text: String(parsed.文字 || '').slice(0, 24000), mentions: segments.filter(segment => segment?.type === 'at').map(segment => String(segment.data?.qq || '')).filter(qq),
        replyTo, images: clone((parsed.图们 || []).slice(0, 4)), accepted: false };
      records.set(recordKey, record);
      try { persist(recordKey); } catch (error) { records.delete(recordKey); throw error; }
    }
    if (record.accepted) return { selected: true, exclusive, accepted: true };
    const event = clone(record); delete event.accepted;
    const result = await owner.handler(event);
    if (subscriber !== owner || result?.accepted !== true) return { selected: true, exclusive, accepted: false };
    record.accepted = true;
    try { persist(recordKey); } catch (error) { record.accepted = false; throw error; }
    return { selected: true, exclusive, accepted: true };
  };
  const dispose = () => {
    disposed = true; subscriber = null;
    for (const entry of contextFibers.values()) void entry.fiber?.dispose?.();
    contextFibers.clear(); statuses.clear();
  };
  return { service: Object.freeze(service), accept, selected, ownsGroup, ownsSession, dispose };
}
