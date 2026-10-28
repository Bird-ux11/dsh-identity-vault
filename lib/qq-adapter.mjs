import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { patchConversationBridge } from './qq-conversation-patch.mjs';

export const BRIDGE_ADAPTER_VERSION = 3;
export const BRIDGE_ADAPTER_MARKER = 'dsh-identity-vault:qq-source:v3';
const LEGACY_MARKER = 'dsh-identity-vault:qq-source:v1';
const V2_MARKER = 'dsh-identity-vault:qq-source:v2';

const ORIGINAL_CALL = "      await agent.followup({ id: 新id(), role: 'user', content, source: { kind: 'qq' } })";
const CONTENT_GUARDS = [
  'const 配置 = 读配置()',
  'const 这条 = 行 || (配置.绑定 || [])[0] || null',
  "    const 原话 = String(文字 || '').trim()",
  "    const 署名 = (这条 && 这条.类型 === '群' && 发送者 && (发送者.昵称 || 发送者.号码))\n      ? String(发送者.昵称 || '某人') + '（' + String(发送者.号码 || '?') + '）：'\n      : ''",
  "    const 基础 = (原话 ? 署名 + 原话 : (收下.length ? 署名 + '（' + 谁 + '发来了图片，没有配字）' : '')) + 说明",
  '    const 文案 = 基础 + 门槛提示 + 块提示',
  "    let content = [{ type: 'text', text: 文案 }]",
];

// A known transport contract, rather than a release-number allowlist. Keep the
// selector semantics aligned with transcript.mjs: only publicly sent words count.
const REPLY_SELECTOR = String.raw`function 抠QQ标记(文字, 只发标记内) {
  const 全 = String(文字 || '')
  const 洗 = (s) => String(s || '')
    .replace(/\[\s*\/?\s*QQ\s*\]/gi, '')
    .replace(/\n{3,}/g, String.fromCharCode(10) + String.fromCharCode(10))
    .trim()
  if (!只发标记内) return { 发: true, 文字: 洗(全) }
  const 块 = /\[QQ\]([\s\S]*?)\[\/QQ\]/.exec(全)
  if (块 && String(块[1] || '').trim()) return { 发: true, 文字: 洗(块[1]) }
  const 开 = 全.indexOf('[QQ]')
  const 尾 = 开 >= 0 ? 全.slice(开 + 4) : ''
  if (String(尾).trim()) {
    return { 发: true, 文字: 洗(尾), 原因: '只写了 [QQ] 没写 [/QQ]，按「[QQ] 之后全是要发的」处理' }
  }
  return { 发: false, 文字: '', 原因: '没写块' }
}`;
const REPLY_BODY = String.raw`function 提取正文(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}`;

// Frozen v1 body: its exact function text authenticates our already-installed v1 patch.
function legacyBuildQqIdentitySource(row, sender, firstMessageId, observedAt = Date.now()) {
  const decimal = (value) => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const result = String(value);
    return /^[1-9][0-9]{4,19}$/.test(result) ? result : null;
  };
  if (!row || !sender || !['群', '私聊'].includes(row.类型)) return null;
  const qqId = decimal(sender.号码);
  const chatId = decimal(row.号码);
  if (!qqId || !chatId || (row.类型 === '私聊' && qqId !== chatId)) return null;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) return null;
  const upstreamFirstMessageId = typeof firstMessageId === 'string'
    ? firstMessageId.slice(0, 128)
    : (Number.isSafeInteger(firstMessageId) ? String(firstMessageId) : '');
  return {
    version: 1,
    transport: 'onebot11',
    qqId,
    chatType: row.类型 === '群' ? 'group' : 'direct',
    chatId,
    ...(row.类型 === '群' ? { groupId: chatId } : {}),
    displayName: typeof sender.昵称 === 'string'
      ? sender.昵称.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256) : '',
    // The bridge merges consecutive messages from one sender and passes only
    // the FIRST upstream ID here. This is deliberately not a complete ID list.
    ...(upstreamFirstMessageId ? { upstreamFirstMessageId } : {}),
    observedAt,
  };
}

/** Pure source metadata builder. Spans use JavaScript UTF-16 offsets in the first text block. */
export function buildQqIdentitySource(row, sender, firstMessageId, observedAt = Date.now(), userTextSpan, replyOnlyMarked) {
  const source = legacyBuildQqIdentitySource(row, sender, firstMessageId, observedAt);
  if (!source) return null;
  source.displayName = source.displayName.slice(0, 200);
  if (userTextSpan && Number.isSafeInteger(userTextSpan.start) && userTextSpan.start >= 0
    && Number.isSafeInteger(userTextSpan.length) && userTextSpan.length >= 0
    && Number.isSafeInteger(userTextSpan.start + userTextSpan.length)) {
    source.userTextSpan = { start: userTextSpan.start, length: userTextSpan.length };
  }
  if (typeof replyOnlyMarked === 'boolean') source.replyOnlyMarked = replyOnlyMarked;
  return source;
}

const LEGACY_BUILDER = legacyBuildQqIdentitySource.toString().replace('function legacyBuildQqIdentitySource(', 'function buildQqIdentitySource(');
const BUILDER = buildQqIdentitySource.toString().replace(
  'legacyBuildQqIdentitySource(row, sender, firstMessageId, observedAt)',
  `(${LEGACY_BUILDER})(row, sender, firstMessageId, observedAt)`,
);
const LEGACY_PATCHED_CALL = [
  `      /* ${LEGACY_MARKER}:begin */`,
  `      const 身份库来源 = (${LEGACY_BUILDER})(这条, 发送者, 消息id, Date.now())`,
  "      await agent.followup({ id: 新id(), role: 'user', content, source: { kind: 'qq', ...(身份库来源 ? { identityVault: 身份库来源 } : {}) } })",
  `      /* ${LEGACY_MARKER}:end */`,
].join('\n');

const V2_PATCHED_CALL = [
  `      /* ${V2_MARKER}:begin */`,
  `      const 身份库来源 = (${BUILDER})(这条, 发送者, 消息id, Date.now(), { start: 署名.length, length: 原话.length }, Boolean(配置.只发标记内))`,
  "      await agent.followup({ id: 新id(), role: 'user', content, source: { kind: 'qq', ...(身份库来源 ? { identityVault: 身份库来源 } : {}) } })",
  `      /* ${V2_MARKER}:end */`,
].join('\n');
const PATCHED_CALL = V2_PATCHED_CALL.replaceAll(V2_MARKER, BRIDGE_ADAPTER_MARKER);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalize = (text) => text.replace(/\r\n/g, '\n');

// This deliberately recognizes one audited source interface; it is not a JS
// interpreter. Comments and literal contents cannot impersonate executable code.
// Offsets point into the original text so unrelated bytes remain untouched.
function sourceTokens(source) {
  const tokens = [];
  let i = 0;
  const quoted = quote => {
    i++;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i++] === quote) return;
    }
    throw problem('invalid-source', 'QQ 桥含未闭合字符串，无法验证能力。');
  };
  const scan = (inTemplateExpression = false) => {
    let braces = 0, previous = '';
    while (i < source.length) {
      const start = i, char = source[i];
      if (/\s/u.test(char)) { i++; continue; }
      if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) i = source.length; continue; }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        if (end < 0) throw problem('invalid-source', 'QQ 桥含未闭合注释，无法验证能力。');
        i = end + 2; continue;
      }
      if (inTemplateExpression && char === '}' && braces === 0) { i++; return; }
      if (char === '"' || char === "'") quoted(char);
      else if (char === '`') {
        i++;
        let closed = false;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '`') { i++; closed = true; break; }
          if (source.startsWith('${', i)) { i += 2; scan(true); }
          else i++;
        }
        if (!closed) throw problem('invalid-source', 'QQ 桥含未闭合模板，无法验证能力。');
      } else if (char === '/' && /^(?:|[=(:,!&|?;\[{]|return|throw|=>)$/u.test(previous)) {
        i++;
        let characterClass = false, closed = false;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '[') characterClass = true;
          if (source[i] === ']') characterClass = false;
          if (source[i++] === '/' && !characterClass) { closed = true; break; }
        }
        if (!closed) throw problem('invalid-source', 'QQ 桥含无法识别的正则表达式。');
        while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
      } else {
        const word = /^(?:[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*|[0-9]+(?:\.[0-9]+)?)/u.exec(source.slice(i));
        if (word) i += word[0].length;
        else {
          const operator = /^(?:===|!==|=>|\.\.\.|\?\.|\?\?|\|\||&&|==|!=|<=|>=|\+\+|--|\+=|-=|\*=|\/=|\*\*)/.exec(source.slice(i));
          i += operator ? operator[0].length : 1;
        }
      }
      const value = source.slice(start, i);
      if (value === '{') braces++;
      if (value === '}') braces--;
      previous = value;
      if (!inTemplateExpression && value !== ';') tokens.push({ value, start, end: i });
    }
    if (inTemplateExpression) throw problem('invalid-source', 'QQ 桥含未闭合模板表达式。');
  };
  scan();
  return tokens;
}

function capability(code, message) {
  return problem(`missing-capability:${code}`, `QQ 桥缺少或改变了所需能力「${code}」：${message}。未修改源码。`);
}

function matches(tokens, text) {
  const expected = sourceTokens(text).map(token => token.value), found = [];
  for (let i = 0; i <= tokens.length - expected.length; i++) {
    if (expected.every((value, j) => tokens[i + j].value === value)) found.push({ index: i, length: expected.length });
  }
  return found;
}

function requireOne(tokens, text, code) {
  const found = matches(tokens, text);
  if (found.length !== 1) throw capability(code, '执行代码中的接口不存在或存在歧义');
  return found[0];
}

function blockEnd(tokens, start, code) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].value === '{') depth++;
    if (tokens[i].value === '}' && --depth === 0) return i;
  }
  throw capability(code, '无法确认函数边界');
}

function functionTokens(tokens, header, code) {
  const match = requireOne(tokens, header, code), opening = match.index + match.length - 1;
  return tokens.slice(match.index, blockEnd(tokens, opening, code) + 1);
}

function scopeAt(tokens, index) {
  const scope = [];
  for (let i = 0; i < index; i++) {
    if (tokens[i].value === '{') scope.push(i);
    if (tokens[i].value === '}') scope.pop();
  }
  return scope;
}

function inspectReplyDispatch(tokens) {
  const code = 'public-reply-dispatch';
  const body = functionTokens(tokens, 'function 提取正文(message) {', code);
  if (matches(body, REPLY_BODY).length !== 1) throw capability(code, '助手正文提取规则改变');
  const events = functionTokens(tokens, 'function 收到事件(session, event) {', code);
  let preceding = -1;
  for (const statement of [
    'const 键 = 会话键(session && session.id)',
    'const 是这条 = (配置.绑定 || []).find((b) => 会话键(b.会话) === 键) || null',
    'if (!是这条) return',
    'const 方向 = 键',
    'const 上一轮 = 上一轮们.get(键) || 空轮()',
    'const 记上一轮 = (v) => 上一轮们.set(键, v)',
  ]) {
    const found = requireOne(events, statement, code);
    if (found.index <= preceding || scopeAt(events, found.index).length !== 1) throw capability(code, '回复缓存与会话绑定作用域改变');
    preceding = found.index;
  }
  const assistant = functionTokens(events, "if (event && event.type === 'assistant/message') {", code);
  preceding = -1;
  for (const statement of [
    'const d = event.data || {}',
    'if (d.interrupted) { 记上一轮(空轮()) return }',
    "const 文 = String(提取正文(d.message) || '').trim()",
    'const 图们 = 提取图块(d.message)',
    'if (文) 记上一轮({ 轮号: d.turn, 文本: 文, 图们 })',
    "else if (图们.length) 记上一轮({ 轮号: d.turn, 文本: 上一轮.轮号 === d.turn ? 上一轮.文本 : '', 图们: (上一轮.轮号 === d.turn ? 上一轮.图们 : []).concat(图们).slice(0, 10) })",
  ]) {
    const found = requireOne(assistant, statement, code);
    if (found.index <= preceding || scopeAt(assistant, found.index).length !== 1) throw capability(code, '最后助手正文的替换规则改变');
    preceding = found.index;
  }
  if (assistant.at(-2)?.value !== 'return') throw capability(code, '助手消息处理未结束');
  const ended = functionTokens(events, "if (event && event.type === 'turn/end') {", code);
  preceding = -1;
  for (const statement of [
    'const d = event.data || {}',
    "const 完成 = !!(d.reason && d.reason.kind === 'completed')",
    'const 有东西 = 上一轮.文本 || (上一轮.图们 && 上一轮.图们.length)',
    "const 轮标 = 键 + ':' + String(d.turn)",
  ]) {
    const found = requireOne(ended, statement, code);
    if (found.index <= preceding || scopeAt(ended, found.index).length !== 1) throw capability(code, '完成状态与同会话轮次校验改变');
    preceding = found.index;
  }
  const completed = functionTokens(ended, 'if (完成 && 上一轮.轮号 === d.turn && 有东西 && !已发轮.has(轮标)) {', code);
  requireOne(completed, '已发轮.add(轮标)', code);
  const dispatch = 'void 落地一发(配置, 上一轮.文本, 上一轮.图们, 方向, 是QQ唤醒)';
  requireOne(completed, dispatch, code);
  requireOne(tokens, dispatch, code);
  // The declaration plus this guarded call must be the only entry points.
  if (matches(tokens, '落地一发(').length !== 2) throw capability(code, '发现额外且无法验证的回复分发入口');
  const reset = requireOne(ended, '记上一轮(空轮())', code);
  if (scopeAt(ended, reset.index).length !== 1 || reset.index <= preceding
    || ended[reset.index + reset.length]?.value !== '}') throw capability(code, '完成后没有清空对应会话的回复缓存');
}

function inspectCapabilities(source) {
  const tokens = sourceTokens(source);
  const inbound = functionTokens(tokens, 'async function 转入一条(文字, 图们, 消息id, 行, 发送者, 点名) {', 'trusted-dispatch');
  const dispatch = requireOne(tokens, ORIGINAL_CALL, 'trusted-dispatch');
  const localDispatch = requireOne(inbound, ORIGINAL_CALL, 'trusted-dispatch');
  let preceding = -1;
  for (const guard of CONTENT_GUARDS) {
    const found = requireOne(inbound, guard, 'public-user-text');
    if (scopeAt(inbound, found.index).length !== 1 || found.index <= preceding || found.index >= localDispatch.index) {
      throw capability('public-user-text', '正文构造的作用域或发送顺序改变');
    }
    preceding = found.index;
  }
  const polling = functionTokens(tokens, 'async function 轮询收消息() {', 'sender-isolation');
  const bindings = functionTokens(polling, 'for (const 行 of 配置.绑定) {', 'chat-isolation');
  requireOne(bindings, 'let 攒 = null', 'chat-isolation');
  requireOne(bindings, 'const 列表 = await 拉(动作, 体)', 'trusted-sender');
  const sender = requireOne(polling, 'const 发送者 = {', 'trusted-sender');
  const senderEnd = blockEnd(polling, sender.index + sender.length - 1, 'trusted-sender');
  requireOne(polling.slice(sender.index, senderEnd + 1), '号码: Number(条.user_id) || 0,', 'trusted-sender');
  const isolation = requireOne(polling, 'if (攒 && 攒.发送者.号码 !== 发送者.号码) { const 好 = await 落袋() if (!好) break }', 'sender-isolation');
  const queue = requireOne(polling, '攒 = { 文字们: [], 图们: [], ids: [], 点名: false, 发送者,', 'sender-isolation');
  if (sender.index >= isolation.index || isolation.index >= queue.index
    || JSON.stringify(scopeAt(polling, sender.index)) !== JSON.stringify(scopeAt(polling, isolation.index))) {
    throw capability('sender-isolation', '发送者切换的作用域或批次创建顺序改变');
  }
  requireOne(bindings, 'const 发送者 = {', 'chat-isolation');
  const batch = functionTokens(polling, 'const 落袋 = async () => {', 'trusted-dispatch');
  const take = requireOne(batch, 'const 一批 = 攒 攒 = null', 'trusted-dispatch');
  const call = requireOne(batch, 'const 结果 = await 转入一条(文字, 一批.图们, 一批.ids[0], 行, 一批.发送者, 一批.点名)', 'trusted-dispatch');
  if (take.index >= call.index) throw capability('trusted-dispatch', '批次来源与发送顺序改变');

  const selector = functionTokens(tokens, 'function 抠QQ标记(文字, 只发标记内) {', 'public-reply-selection');
  if (matches(selector, REPLY_SELECTOR).length !== 1) throw capability('public-reply-selection', '公开回复的标记选择语义无法验证');
  const outbound = functionTokens(tokens, "async function 落地一发(配置, 文字, 图们, 方向 = '', 是QQ唤醒 = false) {", 'public-reply-selection');
  const selected = requireOne(outbound, 'const 标记 = 抠QQ标记(文字, 配置.只发标记内)', 'public-reply-selection');
  const gated = requireOne(outbound, 'if (!标记.发) {', 'public-reply-selection');
  const gateEnd = blockEnd(outbound, gated.index + gated.length - 1, 'public-reply-selection');
  const gateBody = outbound.slice(gated.index + gated.length, gateEnd);
  if (gateBody.at(-1)?.value !== 'return') throw capability('public-reply-selection', '未发送的回复没有停止出站');
  const output = requireOne(outbound, 'let 待发文字 = 标记.文字', 'public-reply-selection');
  if (!(selected.index < gated.index && gateEnd < output.index)) throw capability('public-reply-selection', '出站选择顺序改变');
  inspectReplyDispatch(tokens);
  return {
    start: tokens[dispatch.index].start,
    end: tokens[dispatch.index + dispatch.length - 1].end,
    capabilities: ['trusted-dispatch', 'trusted-sender', 'sender-isolation', 'chat-isolation', 'public-user-text', 'public-reply-selection', 'public-reply-dispatch'],
  };
}

function problem(reasonCode, message) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  return error;
}

async function optionalRead(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function locations(bridgeFile) {
  if (typeof bridgeFile !== 'string' || !bridgeFile) throw problem('invalid-path', '需要 QQ 桥 lib/host.js 的路径。');
  const file = resolve(bridgeFile);
  if (basename(file) !== 'host.js' || basename(dirname(file)) !== 'lib') {
    throw problem('invalid-path', '适配仅支持 QQ 桥包内的 lib/host.js。');
  }
  return {
    bridgeFile: file,
    backupFile: `${file}.identity-vault.original`,
    manifestFile: `${file}.identity-vault.adapter.json`,
    packageFile: join(dirname(dirname(file)), 'package.json'),
  };
}

function patchOriginal(original, adapterVersion = BRIDGE_ADAPTER_VERSION, legacyNameLimit = 256) {
  const source = original.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(original)) throw problem('invalid-encoding', 'QQ 桥源文件不是完整 UTF-8 文本。');
  const normalized = normalize(source);
  if (normalized.includes('dsh-identity-vault:qq-source:')) throw problem('unknown-patch', '发现未知或不完整的身份适配标记。');
  const contract = inspectCapabilities(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  // Both exact v1 builds shipped locally; this is a two-template whitelist, never a source heuristic.
  const patch = adapterVersion === 1 ? LEGACY_PATCHED_CALL.replace('.slice(0, 256)', `.slice(0, ${legacyNameLimit})`)
    : adapterVersion === 2 ? V2_PATCHED_CALL : PATCHED_CALL;
  const patched = source.slice(0, contract.start) + normalize(patch).trimStart().replace(/\n/g, newline) + source.slice(contract.end);
  return Buffer.from(adapterVersion >= 3 ? patchConversationBridge(patched, BUILDER) : patched, 'utf8');
}

async function inspect(bridgeFile) {
  const paths = locations(bridgeFile);
  const stat = await lstat(paths.bridgeFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw problem('unsupported-file', 'QQ 桥目标必须是普通文件。');
  const pkg = JSON.parse(await readFile(paths.packageFile, 'utf8'));
  if (pkg.name !== 'dsh-qq-bridge') throw problem('unsupported-package', '目标包不是 dsh-qq-bridge。');
  const current = await readFile(paths.bridgeFile);
  const backup = await optionalRead(paths.backupFile);
  const manifestBytes = await optionalRead(paths.manifestFile);
  if (Boolean(backup) !== Boolean(manifestBytes)) throw problem('incomplete-backup', '身份适配备份或清单不完整，拒绝覆盖。');
  let original = current;
  let manifest;
  if (manifestBytes) {
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
    catch { throw problem('invalid-manifest', '身份适配清单损坏。'); }
    if (![1, 2, BRIDGE_ADAPTER_VERSION].includes(manifest.adapterVersion)
      || typeof manifest.bridgeVersion !== 'string'
      || manifest.marker !== (manifest.adapterVersion === 1 ? LEGACY_MARKER : manifest.adapterVersion === 2 ? V2_MARKER : BRIDGE_ADAPTER_MARKER)
      || manifest.originalHash !== sha256(backup)) {
      throw problem('backup-mismatch', '身份适配备份或清单校验失败。');
    }
    original = backup;
  }
  const patched = patchOriginal(original);
  const originalHash = sha256(original);
  const patchedHash = sha256(patched);
  const priorCandidates = manifest?.adapterVersion === 1
    ? [patchOriginal(original, 1, 256), patchOriginal(original, 1, 200)] : manifest?.adapterVersion === 2 ? [patchOriginal(original, 2)] : [patched];
  const priorPatched = manifest ? priorCandidates.find(candidate => manifest.patchedHash === sha256(candidate)) : patched;
  if (!priorPatched) throw problem('patch-mismatch', '身份适配清单与当前适配代码不一致。');
  const isInstalled = current.equals(patched);
  const isLegacyInstalled = [1, 2].includes(manifest?.adapterVersion) && current.equals(priorPatched);
  if (!current.equals(priorPatched) && !current.equals(original)) throw problem('bridge-changed', 'QQ 桥已被更新或修改，拒绝覆盖当前文件。');
  if (isInstalled && !manifest) throw problem('missing-backup', '已修改的 QQ 桥缺少可验证原件备份。');
  return { ...paths, current, original, patched, manifest, manifestBytes, isInstalled, isLegacyInstalled, originalHash, patchedHash, version: pkg.version };
}

function result(state, status, changed = false) {
  return {
    ok: true, status, reasonCode: null,
    message: status === 'installed' ? 'QQ 身份来源适配已安装；需重载宿主。'
      : status === 'upgraded' ? 'QQ 身份来源适配已升级到 v3；需重载宿主。'
        : status === 'upgrade-required' ? '检测到完整旧版适配；需显式升级到 v3 才能使用群对话调度接口。'
      : status === 'restored' ? 'QQ 身份来源适配已恢复原件；需重载宿主。'
        : status === 'already-installed' ? 'QQ 身份来源适配完整且已安装。'
          : status === 'already-restored' ? 'QQ 桥已是校验通过的原件。'
            : 'QQ 桥所需能力与源码结构校验通过，可以安装身份来源适配。',
    bridgeFile: state.bridgeFile, backupFile: state.backupFile, manifestFile: state.manifestFile,
    version: state.version, originalHash: state.originalHash, patchedHash: state.patchedHash,
    adapterVersion: BRIDGE_ADAPTER_VERSION,
    compatibility: { mode: 'source-contract', versionPolicy: 'capabilities',
      capabilities: ['trusted-dispatch', 'trusted-sender', 'sender-isolation', 'chat-isolation', 'public-user-text', 'public-reply-selection', 'public-reply-dispatch', 'qq-conversation-bridge-v1'] },
    changed, requiresReload: changed,
  };
}

function failure(error, bridgeFile) {
  // Do not expose filesystem error messages: they can contain unrelated paths.
  return {
    ok: false, status: 'unavailable', reasonCode: error.reasonCode || error.code || 'adapter-error',
    message: error.reasonCode ? error.message : '无法读取或写入 QQ 桥适配文件，请检查路径与权限。',
    bridgeFile: typeof bridgeFile === 'string' ? resolve(bridgeFile) : null,
    changed: false, requiresReload: false,
  };
}

/** Read-only compatibility check. No bridge code is imported or executed. */
export async function prepareBridgeAdapter(bridgeFile) {
  try {
    const state = await inspect(bridgeFile);
    return result(state, state.isInstalled ? 'already-installed' : state.isLegacyInstalled ? 'upgrade-required' : 'ready');
  } catch (error) { return failure(error, bridgeFile); }
}

/** Startup verification only: never installs or repairs an adapter implicitly. */
export async function verifyBridgeAdapter(bridgeFile) {
  const checked = await prepareBridgeAdapter(bridgeFile);
  if (!checked.ok || checked.status === 'already-installed') return checked;
  if (checked.status === 'upgrade-required') return { ...checked, ok: false, reasonCode: 'upgrade-required' };
  return { ...checked, ok: false, status: 'unavailable', reasonCode: 'not-installed', message: 'QQ 身份来源适配尚未安装；不会从消息正文识别人。' };
}

async function replaceChecked(path, expected, replacement) {
  const temporary = `${path}.identity-vault.${randomUUID()}.tmp`;
  let created = false;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw problem('unsupported-file', 'QQ 桥目标不再是普通文件。');
    await writeFile(temporary, replacement, { flag: 'wx', mode: stat.mode });
    created = true;
    if (!(await readFile(path)).equals(expected)) throw problem('concurrent-change', 'QQ 桥在操作期间发生变化，已停止修改。');
    await rename(temporary, path);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}

/** Explicit install operation. Backups are immutable and retained for audit. */
export async function installBridgeAdapter(bridgeFile) {
  try {
    const state = await inspect(bridgeFile);
    if (state.isInstalled) return result(state, 'already-installed');
    const nextManifest = Buffer.from(`${JSON.stringify({
      adapterVersion: BRIDGE_ADAPTER_VERSION,
      bridgeVersion: state.version || 'unknown',
      marker: BRIDGE_ADAPTER_MARKER,
      originalHash: state.originalHash,
      patchedHash: state.patchedHash,
      createdAt: state.manifest?.createdAt || new Date().toISOString(),
      ...([1, 2].includes(state.manifest?.adapterVersion) ? { upgradedAt: new Date().toISOString(), previousAdapterVersion: state.manifest.adapterVersion } : {}),
    }, null, 2)}\n`);
    if (!state.manifest) {
      await writeFile(state.backupFile, state.original, { flag: 'wx', mode: 0o600 });
      try { await writeFile(state.manifestFile, nextManifest, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        // The bridge has not changed; remove only the backup created by this attempt.
        if ((await optionalRead(state.backupFile))?.equals(state.original)) await unlink(state.backupFile);
        throw error;
      }
    }
    await replaceChecked(state.bridgeFile, state.current, state.patched);
    if ([1, 2].includes(state.manifest?.adapterVersion)) {
      try { await replaceChecked(state.manifestFile, state.manifestBytes, nextManifest); }
      catch (error) {
        // Two files cannot be renamed atomically together. Restore our exact prior bridge
        // bytes if committing the new manifest fails; never roll over a concurrent edit.
        try { await replaceChecked(state.bridgeFile, state.patched, state.current); }
        catch { throw problem('upgrade-rollback-failed', '适配升级清单提交失败且源码已变化；保留备份，需人工核对。'); }
        throw error;
      }
    }
    return result(state, state.isLegacyInstalled ? 'upgraded' : 'installed', true);
  } catch (error) { return failure(error, bridgeFile); }
}

/** Restore only our exact patched bytes; never overwrite an upstream update. */
export async function uninstallBridgeAdapter(bridgeFile) {
  try {
    const state = await inspect(bridgeFile);
    if (!state.isInstalled && !state.isLegacyInstalled) return result(state, 'already-restored');
    await replaceChecked(state.bridgeFile, state.current, state.original);
    return result(state, 'restored', true);
  } catch (error) { return failure(error, bridgeFile); }
}
