import { fork } from 'node:child_process';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FISH_COMPATIBILITY = Object.freeze({ name: 'dsh-fish-memory', protocol: 1,
  capabilities: Object.freeze(['prompt-builder', 'entry-parser', 'isolated-ipc']),
  failureCodes: Object.freeze(['FISH_CAPABILITY_MISSING', 'FISH_CAPABILITY_INVALID', 'FISH_MODULE_UNAVAILABLE',
    'FISH_PROMPT_BUILDER_MISSING', 'FISH_ENTRY_PARSER_MISSING', 'FISH_PROMPT_FORMAT_INVALID', 'FISH_ENTRY_FORMAT_INVALID']) });
const WORKER = fileURLToPath(new URL('./workers/fish-worker.mjs', import.meta.url));
const CATEGORIES = Object.freeze({ 一: 'self_identity', 二: 'speaking_style', 三: 'person_profile', 四: 'relationship',
  五: 'agreement', 六: 'important_event', 七: 'interaction_preference', 八: 'technical_fact' });
const MAX_PAYLOAD = 200000, MAX_OUTPUT = 32000, MAX_CANDIDATES = 64;
const error = code => Object.assign(new Error(`鱼的记忆托管处理失败：${code}`), { code });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
const abort = signal => { if (signal?.aborted) throw error('ABORTED'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Discover declared modules; byte hashes bind this startup to the files inspected, not a release. */
export function inspectFishPackage(packageRoot, expected = FISH_COMPATIBILITY) {
  if (!isAbsolute(String(packageRoot || '')) || !plain(expected)
    || expected.name !== FISH_COMPATIBILITY.name) throw error('FISH_PACKAGE_INVALID');
  try {
    const root = realpathSync(packageRoot);
    const contained = path => { const actual = realpathSync(path), rel = relative(root, actual);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw error('FISH_PACKAGE_INVALID'); return actual; };
    const manifestBytes = readFileSync(contained(join(root, 'package.json'))), manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.name !== FISH_COMPATIBILITY.name) throw error('FISH_PACKAGE_MISMATCH');
    if (typeof manifest.version !== 'string' || !manifest.version.trim() || manifest.version.length > 100
      || /[\u0000-\u001f\u007f]/.test(manifest.version)) throw error('FISH_PACKAGE_INVALID');
    const paths = new Set(), known = join(root, 'lib', '生成档案.js');
    if (existsSync(known)) paths.add(contained(known));
    const visit = (value, depth = 0) => {
      if (depth > 8) throw error('FISH_PACKAGE_INVALID');
      if (typeof value === 'string') {
        if (!/\.(?:mjs|cjs|js)$/.test(value) || value.includes('*')) return;
        if (!value.startsWith('./')) throw error('FISH_PACKAGE_INVALID');
        paths.add(contained(join(root, value)));
        if (paths.size > 32) throw error('FISH_PACKAGE_INVALID');
      } else if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); }
      else if (plain(value)) { for (const item of Object.values(value)) visit(item, depth + 1); }
    };
    // Avoid mounting the root plugin or its client. Relocated pure helpers must be declared subpath exports.
    if (plain(manifest.exports)) for (const [name, value] of Object.entries(manifest.exports)) {
      if (name.startsWith('./') && !/^\.\/client(?:\/|$)/.test(name)) visit(value);
    }
    if (!paths.size) throw error('FISH_CAPABILITY_MISSING');
    const modules = [...paths].map(modulePath => ({ modulePath, moduleSha256: digest(readFileSync(modulePath)) }));
    return { root, version: manifest.version, manifestSha256: digest(manifestBytes), modules, ...modules[0] };
  } catch (cause) { if (cause.code?.startsWith('FISH_')) throw cause; throw error('FISH_PACKAGE_INVALID'); }
}

function batchesOf(messages) {
  if (!Array.isArray(messages) || messages.length > 300) throw error('FISH_INPUT_INVALID');
  const seen = new Set(), subjects = new Set(), groups = new Map(); let chars = 0;
  for (const message of messages) {
    if (!plain(message) || Object.keys(message).some(key => !['id', 'speaker', 'personId', 'text', 'at'].includes(key))
      || !id(message.id) || seen.has(message.id) || !id(message.personId) || !['person', 'self'].includes(message.speaker)
      || (message.speaker === 'self') !== (message.personId === 'self') || typeof message.text !== 'string'
      || !message.text.trim() || message.text.includes('\0') || !Number.isFinite(timestamp(message.at))
      || timestamp(message.at) < 0 || timestamp(message.at) > 8640000000000000) throw error('FISH_INPUT_INVALID');
    seen.add(message.id); subjects.add(message.personId); chars += message.text.length;
    if (chars > 80000 || subjects.size > 9) throw error('FISH_INPUT_TOO_LARGE');
    const at = timestamp(message.at), day = new Date(at).toISOString().slice(0, 10), key = JSON.stringify([message.personId, day]);
    if (!groups.has(key)) groups.set(key, { subjectId: message.personId, day, messages: [] });
    // Long individual messages are partitioned without inventing extra evidence IDs.
    for (let offset = 0; offset < message.text.length; offset += 8000) groups.get(key).messages.push({ ...message, at, text: message.text.slice(offset, offset + 8000) });
  }
  const batches = [];
  for (const group of groups.values()) {
    let current = [], length = 0;
    for (const message of group.messages.sort((a, b) => a.at - b.at)) {
      if (current.length && length + message.text.length > 8000) { batches.push({ ...group, messages: current }); current = []; length = 0; }
      current.push(message); length += message.text.length;
    }
    if (current.length) batches.push({ ...group, messages: current });
  }
  if (batches.length > 64) throw error('FISH_INPUT_TOO_LARGE');
  return batches;
}

function boundedModelCall(call, request, timeoutMs, controllers) {
  const controller = new AbortController(); controllers.add(controller);
  const external = request.signal;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (failure, value) => { if (done) return; done = true; clearTimeout(timer);
      external?.removeEventListener('abort', cancelled); controllers.delete(controller); failure ? reject(failure) : resolve(value); };
    const cancelled = () => { controller.abort(); finish(error('ABORTED')); };
    const timer = setTimeout(() => { finish(error('FISH_MODEL_TIMEOUT')); controller.abort(); }, timeoutMs);
    controller.signal.addEventListener('abort', () => finish(error('ABORTED')), { once: true });
    external?.addEventListener('abort', cancelled, { once: true });
    if (external?.aborted) return cancelled();
    Promise.resolve().then(() => { abort(controller.signal); return call({ ...request, signal: controller.signal }); })
      .then(value => finish(null, value), () => finish(error('FISH_MODEL_FAILED')));
  });
}

/** Owns a real, hidden Node child; it never mounts the upstream plugin or its stores. */
export function createManagedFish({ packageRoot, nodeExecutable = process.execPath, callModel, spawn = fork, onError = () => {},
  timeoutMs = 30000, modelTimeoutMs = 90000, maxRetries = 1, expected = FISH_COMPATIBILITY } = {}) {
  for (const [value, maximum] of [[timeoutMs, 120000], [modelTimeoutMs, 300000], [maxRetries, 2]]) {
    if (!Number.isSafeInteger(value) || value < (maximum === 2 ? 0 : 1) || value > maximum) throw error('FISH_CONFIG_INVALID');
  }
  if (!isAbsolute(String(nodeExecutable)) || typeof spawn !== 'function' || typeof onError !== 'function') throw error('FISH_CONFIG_INVALID');
  const compatibility = { ...expected }; let child = null, ready = null, disposed = false, nextId = 0, extracting = 0;
  const pending = new Map(), children = new Set(), controllers = new Set();
  const stats = { backend: 'fish', version: null, capabilities: [], managed: true,
    mode: 'topic-candidates', trigger: 'conversation-closed', workspaceScan: false,
    processId: null, starts: 0, restarts: 0, requests: 0, extractions: 0, candidates: 0, modelCalls: 0,
    failures: 0, lastErrorCode: null, lastStartedAt: null, lastCompletedAt: null };
  const status = () => ({ ...stats, capabilities: [...stats.capabilities], running: Boolean(child?.connected), disposed,
    activity: disposed ? 'disposed' : extracting ? 'extracting' : stats.lastErrorCode ? 'retry-needed'
      : child?.connected ? 'awaiting-topic' : 'stopped', activeExtractions: extracting });
  const report = failure => { stats.failures++; stats.lastErrorCode = failure.code || 'FISH_WORKER_FAILED'; try { onError(error(stats.lastErrorCode)); } catch {} };
  const stop = (process, failure) => {
    if (child === process) { child = null; ready = null; stats.processId = null; }
    for (const [key, item] of pending) if (item.process === process) { pending.delete(key); item.finish(failure); }
    try { if (process.connected) process.disconnect(); } catch {}
    try { process.kill(); } catch {}
  };
  const ensure = () => {
    if (disposed) return Promise.reject(error('FISH_DISPOSED'));
    if (child && ready) return ready;
    let verified;
    try { verified = inspectFishPackage(packageRoot, compatibility); } catch (cause) { return Promise.reject(cause); }
    stats.version = verified.version; stats.capabilities = [];
    // Never copy arbitrary host environment variables (provider keys, NODE_OPTIONS, etc.).
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TZ', 'LANG']) if (typeof process.env[name] === 'string') env[name] = process.env[name];
    let processChild;
    try { processChild = spawn(WORKER, [verified.root, JSON.stringify(verified)], {
      execPath: nodeExecutable, execArgv: [], env, windowsHide: true, silent: true, serialization: 'json' }); }
    catch { return Promise.reject(error('FISH_WORKER_START_FAILED')); }
    child = processChild; children.add(processChild); stats.starts++; stats.restarts = Math.max(0, stats.starts - 1); stats.processId = processChild.pid || null;
    // Child diagnostics are intentionally not persisted; they may contain source material.
    processChild.stdout?.resume(); processChild.stderr?.resume();
    const startup = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(error('FISH_WORKER_TIMEOUT')); stop(processChild, error('FISH_WORKER_TIMEOUT')); }, timeoutMs);
      let settled = false;
      const settle = failure => { if (settled) return; settled = true; clearTimeout(timer); failure ? reject(failure) : resolve(processChild); };
      processChild.on('message', message => {
        if (!plain(message) || JSON.stringify(message).length > MAX_PAYLOAD) { settle(error('FISH_PROTOCOL_INVALID')); stop(processChild, error('FISH_PROTOCOL_INVALID')); return; }
        if (message.kind === 'incompatible') {
          const code = ['FISH_PACKAGE_MISMATCH', ...FISH_COMPATIBILITY.failureCodes].includes(message.code)
            ? message.code : 'FISH_PROTOCOL_INVALID';
          settle(error(code)); stop(processChild, error(code)); return;
        }
        if (message.kind === 'ready') {
          if (message.version !== verified.version || message.manifestSha256 !== verified.manifestSha256
            || !verified.modules.some(item => item.modulePath === message.modulePath && item.moduleSha256 === message.moduleSha256)) {
            settle(error('FISH_PACKAGE_MISMATCH')); stop(processChild, error('FISH_PACKAGE_MISMATCH'));
          } else if (message.protocol !== FISH_COMPATIBILITY.protocol || !Array.isArray(message.capabilities)
            || message.capabilities.length !== FISH_COMPATIBILITY.capabilities.length
            || !FISH_COMPATIBILITY.capabilities.every(value => message.capabilities.includes(value))) {
            settle(error('FISH_PROTOCOL_INVALID')); stop(processChild, error('FISH_PROTOCOL_INVALID'));
          } else { stats.capabilities = [...message.capabilities]; settle(); } return;
        }
        const item = pending.get(message.requestId);
        if (!item || item.process !== processChild) return;
        pending.delete(message.requestId);
        if (message.kind === 'result') item.finish(null, message.value);
        else item.finish(error('FISH_WORKER_REJECTED'));
      });
      processChild.once('error', () => { settle(error('FISH_WORKER_FAILED')); stop(processChild, error('FISH_WORKER_FAILED')); });
      processChild.once('exit', () => { children.delete(processChild); settle(error('FISH_WORKER_EXITED')); stop(processChild, error('FISH_WORKER_EXITED')); });
    });
    ready = startup; return startup;
  };
  const rpc = async (operation, value, signal) => {
    for (let attempt = 0; ; attempt++) {
      abort(signal); if (disposed) throw error('FISH_DISPOSED');
      try {
        const processChild = await new Promise((resolve, reject) => {
          const cancelled = () => { reject(error('ABORTED')); if (child) stop(child, error('FISH_WORKER_CANCELLED')); };
          signal?.addEventListener('abort', cancelled, { once: true });
          ensure().then(value => { signal?.removeEventListener('abort', cancelled); resolve(value); }, cause => {
            signal?.removeEventListener('abort', cancelled); reject(cause);
          });
          if (signal?.aborted) cancelled();
        }); abort(signal);
        if (disposed) throw error('FISH_DISPOSED');
        if (JSON.stringify(value).length > MAX_PAYLOAD) throw error('FISH_INPUT_TOO_LARGE');
        return await new Promise((resolve, reject) => {
          const requestId = String(++nextId); let finished = false;
          const finish = (failure, result) => { if (finished) return; finished = true; clearTimeout(timer);
            signal?.removeEventListener('abort', cancel); pending.delete(requestId); failure ? reject(failure) : resolve(result); };
          const cancel = () => { finish(error('ABORTED')); stop(processChild, error('FISH_WORKER_CANCELLED')); };
          const timer = setTimeout(() => { finish(error('FISH_WORKER_TIMEOUT')); stop(processChild, error('FISH_WORKER_TIMEOUT')); }, timeoutMs);
          pending.set(requestId, { process: processChild, finish }); signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) return cancel();
          stats.requests++;
          try { processChild.send({ requestId, operation, value }, failure => { if (failure) { finish(error('FISH_WORKER_FAILED')); stop(processChild, error('FISH_WORKER_FAILED')); } }); }
          catch { finish(error('FISH_WORKER_FAILED')); stop(processChild, error('FISH_WORKER_FAILED')); }
        });
      } catch (cause) {
        abort(signal);
        if (disposed) throw error('FISH_DISPOSED');
        if (attempt >= maxRetries || !['FISH_WORKER_START_FAILED', 'FISH_WORKER_FAILED', 'FISH_WORKER_EXITED', 'FISH_WORKER_CANCELLED', 'FISH_WORKER_TIMEOUT'].includes(cause.code)) throw cause;
      }
    }
  };
  return {
    async start() { try { await ensure(); return status(); }
      catch (cause) { if (cause.code !== 'FISH_DISPOSED') report(cause); throw cause; } },
    async extract({ messages, signal, callModel: overrideModelCall } = {}) {
      abort(signal); if (disposed) throw error('FISH_DISPOSED');
      const batches = batchesOf(messages), modelCall = overrideModelCall || callModel;
      if (!batches.length) return [];
      if (typeof modelCall !== 'function') throw error('FISH_MODEL_UNAVAILABLE');
      const candidates = [];
      extracting++; stats.lastStartedAt = new Date().toISOString();
      try {
        for (const batch of batches) {
          abort(signal);
          const prompt = await rpc('prepare', { day: batch.day, self: batch.subjectId === 'self', messages: batch.messages.map(message => ({ text: message.text, at: message.at })) }, signal);
          if (!plain(prompt) || Object.keys(prompt).length !== 2 || typeof prompt.system !== 'string' || typeof prompt.user !== 'string'
            || prompt.system.length > 32000 || prompt.user.length > 16000) throw error('FISH_PROTOCOL_INVALID');
          stats.modelCalls++;
          const output = await boundedModelCall(modelCall, { ...prompt, signal, maxTokens: 3000 }, modelTimeoutMs, controllers);
          abort(signal); if (disposed) throw error('FISH_DISPOSED');
          if (typeof output !== 'string' || output.length > MAX_OUTPUT || !output.trim()) throw error('FISH_OUTPUT_INVALID');
          const rows = await rpc('parse', { text: output }, signal);
          if (!Array.isArray(rows) || rows.length > 32) throw error('FISH_OUTPUT_INVALID');
          // Metadata always comes from this trusted batch, never from model/worker output.
          for (const row of rows) {
            if (!plain(row) || Object.keys(row).some(key => !['章', '日期', '话'].includes(key)) || !Object.hasOwn(CATEGORIES, row.章)
              || typeof row.话 !== 'string' || !row.话.trim() || row.话.length > 1200 || row.话.includes('\0')) throw error('FISH_OUTPUT_INVALID');
            candidates.push({ backend: 'fish', subjectId: batch.subjectId, text: row.话.trim(), category: CATEGORIES[row.章],
              sourceMessageIds: [...new Set(batch.messages.map(message => message.id))], at: new Date(Math.max(...batch.messages.map(message => message.at))).toISOString() });
            if (candidates.length > MAX_CANDIDATES) throw error('FISH_OUTPUT_TOO_LARGE');
          }
        }
        stats.extractions++; stats.candidates += candidates.length; stats.lastErrorCode = null;
        stats.lastCompletedAt = new Date().toISOString(); return candidates;
      } catch (cause) { if (!['ABORTED', 'FISH_DISPOSED'].includes(cause.code)) report(cause); throw cause; }
      finally { extracting--; }
    },
    status,
    async dispose() {
      if (disposed) return; disposed = true;
      for (const controller of controllers) controller.abort();
      await Promise.all([...children].map(processChild => new Promise(resolve => {
        if (processChild.exitCode !== null || processChild.signalCode !== null) { stop(processChild, error('FISH_DISPOSED')); resolve(); return; }
        const timer = setTimeout(resolve, 2000); processChild.once('exit', () => { clearTimeout(timer); resolve(); }); stop(processChild, error('FISH_DISPOSED'));
      })));
    },
  };
}
