import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const diagnostic = (error, fallback) => {
  const code = /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : fallback;
  return Object.assign(new Error(code), { code });
};
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const REF = /^m\d{5,}$/;
const ALLOWED = new Set(['compress', 'decompress', 'acp_retrieve', 'acp_status', 'acp_cache', 'absorb']);
const REQUIRED_TOOLS = ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache'];

function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(exportTarget).find(Boolean);
  if (plain(value)) for (const [condition, target] of Object.entries(value)) {
    if (['node', 'import', 'default'].includes(condition)) { const found = exportTarget(target); if (found) return found; }
  }
}

function packageEntry(root, candidates, capability) {
  for (const candidate of candidates.filter(value => typeof value === 'string' && value)) {
    const entry = resolve(root, candidate), rel = relative(root, entry);
    if (isAbsolute(candidate) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) fail('BILLION_ENTRY_OUTSIDE_PACKAGE');
    if (!existsSync(entry)) continue;
    const actual = realpathSync(entry), actualRel = relative(root, actual);
    if (actualRel === '..' || actualRel.startsWith('..\\') || actualRel.startsWith('../') || isAbsolute(actualRel)) fail('BILLION_ENTRY_OUTSIDE_PACKAGE');
    if (!statSync(actual).isFile()) continue;
    return actual;
  }
  fail(`BILLION_CAPABILITY_${capability}_ENTRY_MISSING`);
}

export function verifyBillionPackage(packageRoot) {
  packageRoot = realpathSync(packageRoot);
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'billion-context' || !validId(pkg.version)) fail('BILLION_PACKAGE_INVALID');
  const nativePath = packageEntry(packageRoot, [exportTarget(pkg.exports?.['./dsh']), exportTarget(pkg.exports?.['.']),
    exportTarget(typeof pkg.exports === 'string' ? pkg.exports : undefined), 'dist/agent/dsh-native.js'], 'NATIVE');
  const proxyPath = packageEntry(packageRoot, [typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['bili-proxy'],
    pkg.bin?.bili, pkg.main, 'dist/index.js'], 'PROXY');
  // Fingerprints describe the loaded installation; they are never an allowlist.
  return { version: pkg.version, verified: true, nativePath, proxyPath,
    fingerprints: { native: digest(readFileSync(nativePath)), proxy: digest(readFileSync(proxyPath)) } };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

function configOverlay(root, sourceConfig, env) {
  const original = sourceConfig || env.BILI_CONFIG_FILE || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'billion-context', 'billion-context.json');
  let config = {};
  if (existsSync(original)) {
    const raw = readFileSync(original, 'utf8');
    if (raw.length > 2 * 1024 * 1024) fail('BILLION_CONFIG_TOO_LARGE');
    try { config = JSON.parse(raw); } catch { fail('BILLION_CONFIG_INVALID'); }
    if (!plain(config)) fail('BILLION_CONFIG_INVALID');
  }
  const destination = join(root, 'billion-context.json');
  atomicJson(destination, { ...config, autoUpdate: false, autoRestartOnUpdate: false, advisoryCheck: false,
    releaseNotesCheck: false, forkAdoption: false, resumeInheritance: false,
    native: { ...config.native, attachExternal: false, attachPolicy: 'own-lane' },
    compress: { ...config.compress, rules: false }, cacheKeepalive: { ...config.cacheKeepalive, enabled: false } });
  // Preserve the existing provider setup without emitting credential contents or putting them in memory.
  const credentials = `${original}.summary-credentials.json`;
  if (existsSync(credentials)) copyFileSync(credentials, `${destination}.summary-credentials.json`);
  return destination;
}

/** Native code stays in the host; only the original compression proxy runs in this owned child. */
export function createBillionProcess({ packageRoot, root, nodePath = process.execPath, fetchImpl = globalThis.fetch,
  spawnImpl = spawn, env = process.env, portProvider = freePort, now = Date.now, delay = sleep,
  startupMs = 30000, retryMs = 1000, healthMs = 5000, onError = () => {}, sourceConfig,
  verifyPackage = verifyBillionPackage } = {}) {
  root = resolve(root); packageRoot = resolve(packageRoot);
  let child, origin, port, stopped = false, pending, monitor, retry, starts = 0, lastError = null;
  let ready = false, verifiedPid = null, configFile, packageInfo;
  const report = error => { const safe = diagnostic(error, 'BILLION_PROCESS_ERROR'); lastError = safe.code; try { onError(safe); } catch {} };
  const json = async (path, init = {}) => {
    const response = await fetchImpl(`${origin}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) fail('BILLION_HEALTH_UNAVAILABLE');
    return response.json();
  };
  const ownedHealth = async () => {
    const data = await json('/__bili/health');
    if (data?.ok !== true || data.pid !== child?.pid || !Number.isSafeInteger(data.pid)
      || data.watchdog?.parentPid !== process.pid || data.watchdog?.armed !== true) fail('BILLION_PROCESS_IDENTITY_MISMATCH');
    if (data.version !== packageInfo.version) fail('BILLION_RUNNING_PACKAGE_MISMATCH');
    verifiedPid = data.pid; return data;
  };
  const armRetry = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; void ensure().catch(report); }, retryMs); retry.unref?.();
  };
  const ensure = () => {
    if (stopped) return Promise.resolve(undefined);
    if (ready && child && child.exitCode == null && !child.killed) return Promise.resolve(origin);
    if (pending) return pending;
    pending = (async () => {
      packageInfo = verifyPackage(packageRoot);
      if (!validId(packageInfo?.version) || !validId(packageInfo?.proxyPath)) fail('BILLION_PACKAGE_INVALID');
      mkdirSync(root, { recursive: true });
      configFile ||= configOverlay(root, sourceConfig, env);
      port ||= await portProvider();
      if (stopped) return undefined;
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail('BILLION_PORT_INVALID');
      origin = `http://127.0.0.1:${port}`;
      const childEnv = { ...env, BILI_CONFIG_FILE: configFile, BILI_SESSIONS_DIR: join(root, 'sessions'),
        XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
        BILI_PARENT_PID: String(process.pid), BILI_LAUNCHER_LANE: 'dsh-identity-vault', BILI_STRICT_PORT: '1',
        BILI_LAUNCH_TOKEN: randomUUID(), ACP_AUTO_UPDATE: '0', ACP_AUTO_RESTART_ON_UPDATE: '0',
        BILI_ADVISORY_CHECK: '0', BILI_RELEASE_NOTES_CHECK: '0', BILI_FORK_ADOPTION: '0', BILI_RESUME_INHERITANCE: '0',
        BILI_CACHE_KEEPALIVE: '0', BILI_NATIVE_ATTACH_POLICY: 'own-lane', BILI_NATIVE_ATTACH_EXTERNAL: '0' };
      for (const key of ['BILLION_CONTEXT_PROXY', 'BILLION_CONTEXT_ATTACH', 'BILI_MCP_PROXY', 'BILI_PROVIDER_REWRITES']) delete childEnv[key];
      if (process.versions.electron && nodePath === process.execPath) childEnv.ELECTRON_RUN_AS_NODE = '1';
      const started = spawnImpl(nodePath, [packageInfo.proxyPath, 'start', '--host', '127.0.0.1', '--port', String(port)],
        { cwd: packageRoot, windowsHide: true, detached: false, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      child = started; starts++;
      // Child diagnostics may contain chat/provider material; consume streams without recording it.
      started.stdout?.resume?.(); started.stderr?.resume?.();
      started.on?.('error', error => { if (child !== started) return; ready = false; report(error); armRetry(); });
      started.on?.('exit', () => { if (child !== started) return; ready = false; verifiedPid = null; child = null; armRetry(); });
      const deadline = now() + startupMs;
      while (!stopped && child === started && now() < deadline) {
        try { await ownedHealth(); ready = true; lastError = null; break; }
        catch (error) { if (['BILLION_PROCESS_IDENTITY_MISMATCH', 'BILLION_RUNNING_PACKAGE_MISMATCH'].includes(error.code)) throw error; }
        await delay(150);
      }
      if (stopped) return undefined;
      if (!ready) fail('BILLION_START_TIMEOUT');
      if (!monitor) {
        monitor = setInterval(() => {
          if (stopped || !ready) return;
          void ownedHealth().then(() => json('/__bili/watcher', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pid: process.pid, hb: true }) })).catch(report);
        }, healthMs); monitor.unref?.();
      }
      return origin;
    })().catch(error => { ready = false; child?.kill?.(); report(error); armRetry(); throw error; })
      .finally(() => { pending = null; });
    return pending;
  };
  return { ensure,
    status: () => ({ kind: 'owned-node-child', version: packageInfo?.version || null, pid: child?.pid || null, verifiedPid,
      port: port || null, origin: origin || null, ready, starts, lastError, stopped }),
    async dispose() {
      stopped = true; ready = false; clearTimeout(retry); clearInterval(monitor);
      const owned = child;
      if (owned && verifiedPid === owned.pid) {
        try { await ownedHealth(); await json('/__bili/shutdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch {}
      }
      if (owned && owned.exitCode == null) owned.kill?.();
      await pending?.catch(() => {}); child = null; verifiedPid = null;
    },
  };
}

function normalizeAccess(access, agent) {
  const sid = agent?.session?.id;
  if (!validId(sid) || !plain(access) || access.sessionId !== sid || !plain(access.scope) || !Array.isArray(access.messages)) fail('BILLION_UNTRUSTED_SESSION');
  if (access.allowWorkingContext !== undefined && typeof access.allowWorkingContext !== 'boolean') fail('BILLION_UNTRUSTED_SESSION');
  const ids = new Set();
  for (const message of access.messages) {
    if (!plain(message) || !validId(message.id) || !validId(message.personId) || !['user', 'assistant'].includes(message.speaker)
      || message.sourceEventId !== `${message.speaker}:${message.id}` || ids.has(message.sourceEventId)
      || typeof message.text !== 'string' || !message.text.trim() || !Number.isFinite(timestamp(message.at))) fail('BILLION_SOURCE_INVALID');
    ids.add(message.sourceEventId);
  }
  return access;
}

/** Exact text matching is intentionally conservative: QQ wrappers and ambiguous repeated messages stay quarantined. */
export function mapBillionBlock(block, details, snapshot, access) {
  if (!plain(block) || !validId(block.blockId) || typeof block.summary !== 'string' || !block.summary.trim()
    || block.summary.length > 100000 || !Array.isArray(snapshot?.messages)) fail('BILLION_BLOCK_INVALID');
  // The inbox accepts complete candidates of at most 4000 characters. Keep
  // oversized blocks in working context, but never truncate them into memory
  // or let one rejected block starve all later blocks in this collection.
  if (block.summary.length > 4000) fail('BILLION_CANDIDATE_TOO_LARGE');
  const byBlock = new Map(details.map(item => [item.blockId, item])), refs = new Set(), seen = new Set();
  function walk(item) {
    if (seen.has(item.blockId)) fail('BILLION_BLOCK_CYCLE');
    seen.add(item.blockId);
    if (!Array.isArray(item.directMessageRefs) || !Array.isArray(item.directBlockIds)) fail('BILLION_SOURCE_UNMAPPED');
    for (const ref of item.directMessageRefs) { if (!REF.test(ref)) fail('BILLION_SOURCE_UNMAPPED'); refs.add(ref); }
    for (const id of item.directBlockIds) { const nested = byBlock.get(id); if (!nested) fail('BILLION_SOURCE_UNMAPPED'); walk(nested); }
    seen.delete(item.blockId);
  }
  walk(block);
  if (!refs.size) fail('BILLION_SOURCE_UNMAPPED');
  const wireByRef = new Map(), hostByText = new Map(), wireByText = new Map();
  for (const message of snapshot.messages) {
    if (REF.test(message?.ref)) wireByRef.set(message.ref, message);
    const key = JSON.stringify([message?.role, message?.text]);
    wireByText.set(key, (wireByText.get(key) || 0) + 1);
  }
  for (const message of access.messages) {
    const key = JSON.stringify([message.speaker, message.text]);
    const list = hostByText.get(key) || []; list.push(message); hostByText.set(key, list);
  }
  const selected = [];
  for (const ref of refs) {
    const wire = wireByRef.get(ref);
    if (!wire || !['user', 'assistant'].includes(wire.role) || wire.toolName || wire.toolCallId
      || wire.contentType !== 'text' || typeof wire.text !== 'string') fail('BILLION_NON_DIALOGUE_SOURCE');
    const key = JSON.stringify([wire.role, wire.text]), matches = hostByText.get(key);
    if (matches?.length !== 1 || wireByText.get(key) !== 1) fail('BILLION_SOURCE_UNMAPPED');
    selected.push(matches[0]);
  }
  return { backend: 'billion', sourceKey: `${access.sessionId}:${block.blockId}:${digest(block.summary)}`,
    sessionId: access.sessionId, scope: structuredClone(access.scope), category: 'compression', text: block.summary,
    sourceMessageIds: selected.map(message => message.sourceEventId),
    at: new Date(Math.max(...selected.map(message => timestamp(message.at)))).toISOString() };
}

function manifestContract(manifest, packageInfo) {
  if (manifest.ok !== true || manifest.proxy !== 'billion-context') fail('BILLION_CAPABILITY_MANIFEST_UNSUPPORTED');
  if (manifest.version !== packageInfo.version) fail('BILLION_RUNNING_PACKAGE_MISMATCH');
  const definitions = [
    ...(Array.isArray(manifest.tools?.anthropic) ? manifest.tools.anthropic.map(tool => ({ name: tool.name, schema: tool.input_schema })) : []),
    ...(Array.isArray(manifest.tools?.openai) ? manifest.tools.openai.map(tool => ({ name: tool.function?.name, schema: tool.function?.parameters })) : []),
    ...(Array.isArray(manifest.tools?.responses) ? manifest.tools.responses.map(tool => ({ name: tool.name, schema: tool.parameters })) : []),
  ];
  const toolNames = new Set(Array.isArray(manifest.toolNames) ? manifest.toolNames : definitions.map(tool => tool.name));
  for (const name of REQUIRED_TOOLS) {
    if (!toolNames.has(name) || !definitions.some(tool => tool.name === name && plain(tool.schema) && tool.schema.type === 'object')) {
      fail(`BILLION_CAPABILITY_TOOL_${name.toUpperCase()}_MISSING`);
    }
  }
  if (toolNames.has('acp_rule')) fail('BILLION_CAPABILITY_RULES_DISABLE_UNSUPPORTED');
  const endpoint = (value, capability) => {
    if (typeof value !== 'string' || !/^\/__bili\/[a-zA-Z0-9/_-]+$/.test(value) || value.includes('..')) fail(`BILLION_CAPABILITY_${capability}_MISSING`);
    return value;
  };
  return { toolNames, toolEndpoint: endpoint(manifest.toolEndpoint, 'TOOL_ENDPOINT'),
    statusEndpoint: endpoint(manifest.statusEndpoint, 'STATUS_ENDPOINT'),
    snapshotEndpoint: endpoint(manifest.snapshotEndpoint || manifest.capabilities?.fork?.snapshotEndpoint, 'SNAPSHOT_ENDPOINT') };
}

/** Capability-checked adapter. Native context and stream interception remain in the parent DSH process. */
export function createManagedBillion({ ctx, packageRoot, root, nodePath, resolveSessionAccess, onCandidate, recall,
  onError = () => {}, fetchImpl = globalThis.fetch, loadNative,
  processController, verifyPackage = verifyBillionPackage, env = process.env, ...processOptions } = {}) {
  if (!ctx || typeof resolveSessionAccess !== 'function' || typeof onCandidate !== 'function' || typeof recall !== 'function') throw new TypeError('Managed billion requires host services.');
  root = resolve(root); mkdirSync(root, { recursive: true });
  const receiptsPath = join(root, 'billion-receipts.json');
  let receipts = {};
  if (existsSync(receiptsPath)) {
    receipts = JSON.parse(readFileSync(receiptsPath, 'utf8'));
    if (!plain(receipts) || Object.entries(receipts).some(([key, value]) => !/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(value))) fail('BILLION_RECEIPTS_INVALID');
  }
  const quarantined = new Map(), collections = new Map();
  const internalSummary = new AsyncLocalStorage();
  let restoreFetchGuard;
  let native, fiber, origin, starting, packageInfo, contract, setProxySpawner, spawnControl = null;
  let stopped = false, bridgeMounted = false, bridgeToolsReady = false, collected = 0, lastError = null, toolTimeoutMs = 120000;
  const registeredTools = new Set();
  const report = error => { const safe = diagnostic(error, 'BILLION_ADAPTER_ERROR'); lastError = safe.code; try { onError(safe); } catch {} };
  const proc = processController || createBillionProcess({ packageRoot, root: join(root, 'billion-proxy'), nodePath, fetchImpl,
    env, verifyPackage, onError: report, ...processOptions });
  const request = async (path, { signal, timeoutMs = 10000, allowUnknownConversation = false, ...init } = {}) => {
    if (stopped || !origin) fail('BILLION_NOT_READY');
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(`${origin}${path}`, { ...init, redirect: 'error', signal: combined });
    if (!response.ok && !(allowUnknownConversation && response.status === 404)) fail(`BILLION_HTTP_${response.status}`);
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) fail('BILLION_RESPONSE_TOO_LARGE');
    let data; try { data = JSON.parse(text); } catch { fail('BILLION_RESPONSE_INVALID'); }
    if (!plain(data)) fail('BILLION_RESPONSE_INVALID');
    if (!response.ok && !(data.ok === false && data.error === 'unknown plugin conversation')) fail(`BILLION_HTTP_${response.status}`);
    return data;
  };
  const sessionStatus = async (access, signal, allowMissing = false) => {
    const data = await request(`${contract.statusEndpoint}?conversationId=${encodeURIComponent(access.sessionId)}`, { signal, allowUnknownConversation: allowMissing });
    if (allowMissing && data.ok === false && data.error === 'unknown plugin conversation') return null;
    if (allowMissing && data.ok === true && !data.fallback && data.conversationId === access.sessionId
      && data.phase === 'pre-first-request' && data.sessionId === null) return null;
    if (data.ok !== true || data.fallback || data.conversationId !== access.sessionId || !validId(data.sessionId)) fail('BILLION_SESSION_MISMATCH');
    return data;
  };
  const accessOf = async (agent, purpose = 'tool') => normalizeAccess(await resolveSessionAccess(agent, { purpose }), agent);
  const collect = agent => {
    const sid = agent?.session?.id;
    if (collections.has(sid)) return collections.get(sid);
    const run = (async () => {
      if (stopped || !bridgeMounted) return { collected: 0, quarantined: 0 };
      const access = await accessOf(agent, 'collect'), status = await sessionStatus(access, undefined, true);
      if (!status) return { collected: 0, quarantined: 0 };
      const detail = await request(`/__bili/sessions/${encodeURIComponent(status.sessionId)}/detail`);
      if (!Array.isArray(detail.blockDetails) || detail.blockDetails.length > 10000) fail('BILLION_DETAILS_INVALID');
      const blocks = detail.blockDetails.filter(block => block.active !== false && typeof block.summary === 'string');
      if (!blocks.length) return { collected: 0, quarantined: 0 };
      const snapshot = await request(`${contract.snapshotEndpoint}?conversationId=${encodeURIComponent(access.sessionId)}`);
      if (snapshot.ok !== true || snapshot.conversationId !== access.sessionId || snapshot.sessionId !== status.sessionId) fail('BILLION_SESSION_MISMATCH');
      if (status.sessionRevision && snapshot.parentRevision !== status.sessionRevision) fail('BILLION_REVISION_CHANGED');
      let accepted = 0, rejected = 0;
      for (const block of blocks) {
        const key = digest(`${access.sessionId}:${block.blockId}:${digest(block.summary)}`);
        if (receipts[key]) continue;
        let candidate;
        try { candidate = mapBillionBlock(block, detail.blockDetails, snapshot, access); }
        catch (error) { quarantined.set(key, error.code || 'BILLION_SOURCE_UNMAPPED'); rejected++; continue; }
        const ack = await onCandidate(candidate);
        if (ack === false || ack?.accepted === false) { quarantined.set(key, 'BILLION_CLASSIFIER_REJECTED'); rejected++; continue; }
        const rows = Object.entries({ ...receipts, [key]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 20000);
        const nextReceipts = Object.fromEntries(rows); atomicJson(receiptsPath, nextReceipts); receipts = nextReceipts;
        quarantined.delete(key); collected++; accepted++;
      }
      while (quarantined.size > 20000) quarantined.delete(quarantined.keys().next().value);
      return { collected: accepted, quarantined: rejected };
    })().catch(error => { report(error); throw error; }).finally(() => collections.delete(sid));
    collections.set(sid, run); return run;
  };
  async function execute(tool, args, exec = {}) {
    const agent = exec.agent, access = await accessOf(agent);
    if (!plain(args)) fail('BILLION_ARGUMENT_INVALID');
    for (const key of ['conversation_id', 'conversationId', 'sessionId', 'session_id']) {
      if (args[key] !== undefined && args[key] !== 'current' && args[key] !== access.sessionId) fail('BILLION_CROSS_SESSION_DENIED');
    }
    if (tool.name === 'search_context') return recall(agent, { query: typeof args.query === 'string' ? args.query : '', signal: exec.signal });
    if (access.allowWorkingContext === false) fail('BILLION_MIXED_CHAT_SESSION');
    if (tool.name === 'acp_rule') fail('BILLION_RULES_MANAGED_BY_VAULT');
    if (!ALLOWED.has(tool.name)) fail('BILLION_UNSUPPORTED_TOOL');
    const status = await sessionStatus(access, exec.signal);
    if (tool.name === 'decompress') {
      if (args.imageRef !== undefined || !validId(args.blockId) || !status.blocks?.some(block => block.id === args.blockId)) fail('BILLION_BLOCK_NOT_IN_CURRENT_SESSION');
    }
    const cleaned = { ...args };
    for (const key of ['conversation_id', 'conversationId', 'sessionId', 'session_id']) delete cleaned[key];
    if (tool.name === 'absorb' && (Object.keys(cleaned).some(key => !['ref', 'summary'].includes(key))
      || typeof cleaned.summary !== 'string' || !cleaned.summary.trim())) fail('BILLION_ARGUMENT_INVALID');
    if (tool.name === 'acp_cache' && (Object.keys(cleaned).some(key => key !== 'detail')
      || (cleaned.detail !== undefined && !['summary', 'full'].includes(cleaned.detail)))) fail('BILLION_ARGUMENT_INVALID');
    if (tool.name === 'acp_retrieve' || tool.name === 'absorb') {
      if (!REF.test(args.ref)) fail('BILLION_REF_NOT_IN_CURRENT_SESSION');
      const found = await request(`/__bili/sessions/${encodeURIComponent(status.sessionId)}/message?ref=${encodeURIComponent(args.ref)}`, { signal: exec.signal });
      if (found.ok !== true || found.ref !== args.ref) fail('BILLION_REF_NOT_IN_CURRENT_SESSION');
    }
    // nativeCaller:true activates upstream persona/ancestor rerouting. Use an exact session + CAS instead.
    const result = await request(contract.toolEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: exec.signal, timeoutMs: toolTimeoutMs,
      body: JSON.stringify({ conversationId: status.sessionId, tool: tool.name, args: cleaned, nativeCaller: false,
        ...(status.sessionRevision ? { expectedRevision: status.sessionRevision } : {}) }) });
    if (result.ok !== true || result.conversationId !== status.sessionId || ['failure', 'refused'].includes(result.outcome)) fail('BILLION_TOOL_FAILED');
    if (tool.name === 'compress' || tool.name === 'absorb') void collect(agent).catch(() => {});
    return typeof result.result === 'string' ? result.result : '';
  }
  const contexts = new WeakMap();
  function summaryIterable(iterable) {
    return { [Symbol.asyncIterator]() {
      const iterator = internalSummary.run(true, () => iterable[Symbol.asyncIterator]());
      return { next: value => internalSummary.run(true, () => iterator.next(value)),
        return: value => internalSummary.run(true, () => iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value })),
        throw: cause => internalSummary.run(true, () => iterator.throw ? iterator.throw(cause) : Promise.reject(cause)) };
    } };
  }
  // The upstream global fetch hook consults its own private async session scope,
  // even when currentInitiator is hidden. Keep maintenance calls outside that
  // hook entirely, while preserving the original native accessor for user turns.
  function guardInternalFetch(directFetch) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    if (!descriptor?.configurable || typeof directFetch !== 'function') fail('BILLION_FETCH_GUARD_UNAVAILABLE');
    let current = descriptor.value;
    const wrappers = new WeakMap();
    const get = () => {
      const downstream = descriptor.get ? descriptor.get.call(globalThis) : current;
      if (typeof downstream !== 'function') return downstream;
      if (!wrappers.has(downstream)) wrappers.set(downstream, function (...args) {
        return Reflect.apply(internalSummary.getStore() ? directFetch : downstream, globalThis, args);
      });
      return wrappers.get(downstream);
    };
    const set = value => { if (descriptor.set) descriptor.set.call(globalThis, value); else current = value; };
    Object.defineProperty(globalThis, 'fetch', { configurable: true, enumerable: descriptor.enumerable, get, set });
    return () => {
      if (Object.getOwnPropertyDescriptor(globalThis, 'fetch')?.get !== get) return;
      Object.defineProperty(globalThis, 'fetch', descriptor.get || descriptor.set ? descriptor : { ...descriptor, value: current });
    };
  }
  function wrapContext(target) {
    if (contexts.has(target)) return contexts.get(target);
    const proxy = new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key, object);
      if (key === 'tools') return new Proxy(value, { get(service, name) {
        if (name === 'register') return spec => {
          if (!plain(spec) || !validId(spec.name) || !plain(spec.parameters) || spec.parameters.type !== 'object') fail('BILLION_CAPABILITY_NATIVE_TOOL_SCHEMA_UNSUPPORTED');
          const registration = service.register({ ...spec,
            ...(spec.name === 'search_context' ? { description: '通过统一 memory 索引检索当前身份有权读取的记忆。' } : {}),
            execute: (args, exec) => execute(spec, args, exec) });
          registeredTools.add(spec.name);
          return registration;
        };
        const found = Reflect.get(service, name, service); return typeof found === 'function' ? found.bind(service) : found;
      } });
      if (key === 'agents') return new Proxy(value, { get(service, name) {
        if (name === 'currentInitiator') return () => {
          if (internalSummary.getStore()) return undefined;
          const agent = service.currentInitiator(); if (!agent?.session) return agent;
          // Compression must never adopt a parent session implicitly; host identities are unaffected.
          return new Proxy(agent, { get(a, prop) { return prop === 'session' ? { ...a.session, header: { ...a.session.header, isSeeded: false, parentSession: undefined } } : Reflect.get(a, prop, a); } });
        };
        const found = Reflect.get(service, name, service); return typeof found === 'function' ? found.bind(service) : found;
      } });
      if (key === 'on') return (event, listener, ...args) => object.on(event, event !== 'llm/stream' ? listener : (options, next) => {
        if (options?.purpose !== 'identity-summary') return listener(options, next);
        // No native callback means no maintenance attribution or session writes.
        return summaryIterable(internalSummary.run(true, () => next()));
      }, ...args);
      if (key === 'inject') return (names, callback) => object.inject(names, (sub, config) => callback(wrapContext(sub), config));
      if (key === 'commands') return new Proxy(value, { get(service, name) {
        if (name === 'register') return spec => service.register({ ...spec, handler: async invocation => {
          const access = await accessOf(invocation?.agent);
          if (access.allowWorkingContext === false) fail('BILLION_MIXED_CHAT_SESSION');
          return spec.handler(invocation);
        } });
        const found = Reflect.get(service, name, service); return typeof found === 'function' ? found.bind(service) : found;
      } });
      return typeof value === 'function' ? value.bind(object) : value;
    } }); contexts.set(target, proxy); return proxy;
  }
  async function probeReadCapabilities() {
    // A fresh nonexistent identifier tests the read APIs without touching any chat.
    const probeId = `identity-vault-capability-${randomUUID()}`;
    const probes = [
      [contract.statusEndpoint + `?conversationId=${probeId}`, 'STATUS_READ', (data, status) =>
        status === 404 && data.ok === false && data.error === 'unknown plugin conversation'
        || status === 200 && data.ok === true && data.conversationId === probeId && data.sessionId === null && !data.fallback && data.phase === 'pre-first-request'],
      [contract.snapshotEndpoint + `?conversationId=${probeId}`, 'SNAPSHOT_READ', (data, status) =>
        status === 404 && data.ok === false && data.error === 'unknown plugin conversation'],
      [`/__bili/sessions/${probeId}/detail`, 'BLOCK_DETAIL_READ', (data, status) =>
        status === 404 && data.error === `unknown session: ${probeId}`],
      [`/__bili/sessions/${probeId}/message?ref=m00001`, 'MESSAGE_REF_READ', (data, status) =>
        status === 404 && data.session === probeId && data.ref === 'm00001' && typeof data.reason === 'string'],
      [contract.toolEndpoint, 'TOOL_REVISION_GUARD', (data, status) =>
        status === 400 && data.ok === false && data.code === 'INVALID_REQUEST' && /expectedRevision/.test(data.error || ''),
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          conversationId: probeId, tool: 'acp_status', args: {}, nativeCaller: false, expectedRevision: 'invalid-probe-revision' }) }],
    ];
    for (const [path, capability, accepts, init = {}] of probes) {
      let response, data;
      try {
        response = await fetchImpl(`${origin}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
        const body = await response.text();
        if (body.length > 65536) fail(`BILLION_CAPABILITY_${capability}_UNSUPPORTED`);
        data = JSON.parse(body);
      } catch { fail(`BILLION_CAPABILITY_${capability}_UNSUPPORTED`); }
      if (!plain(data) || !accepts(data, response.status)) fail(`BILLION_CAPABILITY_${capability}_UNSUPPORTED`);
    }
  }
  const start = () => starting ||= (async () => {
    if (stopped) fail('BILLION_DISPOSED');
    packageInfo = verifyPackage(packageRoot);
    if (!validId(packageInfo?.version) || !validId(packageInfo?.nativePath)) fail('BILLION_PACKAGE_INVALID');
    origin = await proc.ensure();
    if (stopped) fail('BILLION_DISPOSED');
    if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) fail('BILLION_ORIGIN_INVALID');
    const manifest = await request('/__bili/plugin/manifest');
    contract = manifestContract(manifest, packageInfo);
    await probeReadCapabilities();
    const advertisedTimeout = manifest.capabilities?.externalSummary?.maxToolDurationMs;
    if (Number.isFinite(advertisedTimeout) && advertisedTimeout > 0) toolTimeoutMs = Math.min(2147483647, Math.max(120000, Math.ceil(advertisedTimeout + 15000)));
    native = await (loadNative ? loadNative(packageInfo.nativePath) : import(pathToFileURL(packageInfo.nativePath).href));
    if (stopped) fail('BILLION_DISPOSED');
    if (typeof native.apply !== 'function') fail('BILLION_CAPABILITY_NATIVE_APPLY_MISSING');
    // Prefer a public spawner contract; older upstream releases expose the same
    // recovery control under this legacy export. Neither may launch its own child.
    spawnControl = typeof native.setProxySpawner === 'function' ? 'setProxySpawner'
      : typeof native._setSpawnForTest === 'function' ? '_setSpawnForTest' : null;
    if (!spawnControl) fail('BILLION_CAPABILITY_MANAGED_SPAWNER_MISSING');
    setProxySpawner = native[spawnControl].bind(native);
    setProxySpawner(() => stopped ? Promise.resolve(undefined) : proc.ensure());
    const plugin = { name: 'identity-vault-billion-native', inject: native.inject || ['tools', 'commands', 'agents'], apply(childCtx) {
      const previous = env.BILLION_CONTEXT_ATTACH;
      const directFetch = globalThis.fetch;
      env.BILLION_CONTEXT_ATTACH = origin;
      try { native.apply(wrapContext(childCtx)); restoreFetchGuard = guardInternalFetch(directFetch); bridgeMounted = true; }
      finally { if (previous === undefined) delete env.BILLION_CONTEXT_ATTACH; else env.BILLION_CONTEXT_ATTACH = previous; }
    } };
    if (typeof ctx.plugin !== 'function') fail('BILLION_CORDIS_PLUGIN_UNAVAILABLE');
    fiber = ctx.plugin(plugin); await fiber;
    if (stopped) { await fiber?.dispose?.(); fail('BILLION_DISPOSED'); }
    if (!bridgeMounted) fail('BILLION_BRIDGE_NOT_MOUNTED');
    const deadline = Date.now() + 20000;
    while (!stopped && REQUIRED_TOOLS.some(name => !registeredTools.has(name)) && Date.now() < deadline) {
      await sleep(25);
    }
    if (stopped) fail('BILLION_DISPOSED');
    const missing = REQUIRED_TOOLS.find(name => !registeredTools.has(name));
    if (missing) fail(`BILLION_CAPABILITY_NATIVE_TOOL_${missing.toUpperCase()}_MISSING`);
    bridgeToolsReady = true;
    return status();
  })().catch(async error => {
    bridgeMounted = false; bridgeToolsReady = false;
    restoreFetchGuard?.(); restoreFetchGuard = null;
    await fiber?.dispose?.(); fiber = null; registeredTools.clear();
    report(error); starting = null; throw error;
  });
  const status = () => ({ version: packageInfo?.version || null, bridgeMounted, bridgeToolsReady,
    capabilities: { checked: bridgeToolsReady, spawnControl, tools: [...registeredTools].filter(name => name === 'search_context' || ALLOWED.has(name)),
      fingerprints: packageInfo?.fingerprints || null }, collected, quarantined: quarantined.size,
    receipts: Object.keys(receipts).length, lastError, process: proc.status() });
  return { start, collect, status,
    async dispose() {
      stopped = true; bridgeMounted = false; bridgeToolsReady = false;
      // Keep fallback disabled even if an already-pending upstream retry wakes during disposal.
      setProxySpawner?.(() => Promise.resolve(undefined));
      restoreFetchGuard?.(); restoreFetchGuard = null;
      await fiber?.dispose?.(); registeredTools.clear(); await proc.dispose(); await Promise.allSettled([...collections.values()]);
      if (globalThis.__BILI_DSH_COMPACTION_VERDICT__ === 'active') globalThis.__BILI_DSH_COMPACTION_VERDICT__ = 'inactive';
    },
  };
}
