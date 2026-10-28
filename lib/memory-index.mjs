import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class MemoryIndexError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'MemoryIndexError'; this.code = code; }
}
const fail = (code, message) => { throw new MemoryIndexError(code, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const copy = value => structuredClone(value);
const FIELDS = ['id', 'topic', 'time', 'importance', 'triggers', 'status', 'location'];
const STATUSES = ['active', 'archived', 'forgotten'];
const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const wait = milliseconds => Atomics.wait(sleepBuffer, 0, 0, milliseconds);
const sharingError = error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);

function keys(value, allowed, required = allowed) {
  return plain(value) && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key));
}
function short(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INDEX_INVALID_ARGUMENT', `${name} is not a valid bounded string.`);
  }
  return value.trim();
}
function numberId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{4,19}$/.test(value)) fail('INDEX_INVALID_SCOPE', 'QQ and group IDs must be canonical decimal strings.');
  return value;
}
function normalizeScope(scope, { identity = false } = {}) {
  if (keys(scope, ['kind']) && scope.kind === 'local-owner') return { kind: 'local-owner' };
  if (keys(scope, ['kind', 'qqId']) && scope.kind === 'qq-direct') return { kind: 'qq-direct', qqId: numberId(scope.qqId) };
  if (scope?.kind === 'qq-group' && (keys(scope, ['kind', 'groupId', 'qqIds']) || keys(scope, ['kind', 'groupId', 'qqId']))) {
    const ids = scope.qqIds ?? [scope.qqId];
    if (!Array.isArray(ids) || !ids.length || ids.length > 128) fail('INDEX_INVALID_SCOPE', 'A group scope needs 1–128 real participant QQ IDs.');
    return { kind: 'qq-group', groupId: numberId(scope.groupId), qqIds: [...new Set(ids.map(numberId))].sort() };
  }
  if (identity && scope?.kind === 'identity' && keys(scope, ['kind', 'id', 'qqId'], ['kind', 'id'])) {
    const id = ['self', 'owner'].includes(scope.id) ? scope.id : numberId(scope.id);
    if (scope.qqId !== undefined) {
      numberId(scope.qqId);
      if (id === 'self' || (id !== 'owner' && scope.qqId !== id)) fail('INDEX_INVALID_SCOPE', 'Identity QQ metadata disagrees with the identity.');
    }
    return { kind: 'identity', id, ...(scope.qqId === undefined ? {} : { qqId: scope.qqId }) };
  }
  fail('INDEX_INVALID_SCOPE', 'A structured, trusted conversation scope is required.');
}
function normalizeTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('INDEX_INVALID_ARGUMENT', 'time must be a canonical UTC ISO timestamp.');
  }
  return value;
}

/** Filesystem locations are native absolute paths, never URLs or device paths. */
export function validateMemoryPath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value)
    || /^[/\\]{2}/.test(value) || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    fail('INDEX_INVALID_PATH', 'Memory locations require a local absolute filesystem path.');
  }
  const windows = process.platform === 'win32';
  if (windows && !/^[a-z]:[\\/]/i.test(value)) fail('INDEX_INVALID_PATH', 'Windows paths require an explicit drive.');
  const pieces = value.slice(path.parse(value).root.length).split(/[\\/]/);
  if (pieces.some(piece => piece === '..' || piece === '.' || !piece
    || /[<>:"|?*]/.test(piece) || (windows && (/[. ]$/.test(piece)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece))))) {
    fail('INDEX_INVALID_PATH', 'Memory paths cannot contain traversal, alternate streams, reserved names or ambiguous segments.');
  }
  const result = path.normalize(value);
  if (result === path.parse(result).root) fail('INDEX_INVALID_PATH', 'A drive or filesystem root is not a memory location.');
  if (!directory && path.basename(result) !== 'SKILL.md') fail('INDEX_INVALID_PATH', 'A skill location must point to an absolute SKILL.md file.');
  return result;
}

export function resolveMemoryIndexPath({ identityRoot, configuredPath } = {}) {
  if (configuredPath !== undefined) return validateMemoryPath(configuredPath, { directory: true });
  return path.join(validateMemoryPath(identityRoot, { directory: true }), 'memory-index');
}

function normalizeLocation(location) {
  if (!plain(location)) fail('INDEX_INVALID_LOCATION', 'A structured memory location is required.');
  const scope = normalizeScope(location.scope, { identity: location.type === 'mcp' });
  if (location.crossGroup !== undefined && typeof location.crossGroup !== 'boolean') fail('INDEX_INVALID_LOCATION', 'crossGroup must be a trusted boolean policy.');
  const crossGroup = location.crossGroup ?? false;
  if (crossGroup && scope.kind !== 'qq-group') fail('INDEX_INVALID_LOCATION', 'Only public QQ-group records can permit cross-group retrieval.');
  if (location.type === 'skill' && keys(location, ['type', 'path', 'scope', 'crossGroup'], ['type', 'path', 'scope'])) {
    return { type: 'skill', path: validateMemoryPath(location.path), scope, crossGroup };
  }
  if (location.type === 'mcp' && keys(location, ['type', 'server', 'uri', 'scope', 'crossGroup'], ['type', 'server', 'uri', 'scope'])) {
    const server = short(location.server, 'MCP server', 128);
    if (server !== 'identity-vault') fail('INDEX_INVALID_LOCATION', 'Only the local identity-vault MCP server is permitted.');
    const uri = short(location.uri, 'MCP resource URI', 2048);
    if (/^identity-vault:\/\/event\/[a-f0-9]{64}$/.test(uri) && scope.kind !== 'identity') {
      return { type: 'mcp', server, uri, scope, crossGroup };
    }
    const match = /^identity-vault:\/\/identity\/(self|owner|qq\/([1-9]\d{4,19}))$/.exec(uri);
    if (!match || scope.kind !== 'identity' || scope.id !== (match[2] || match[1]) || crossGroup) {
      fail('INDEX_INVALID_LOCATION', 'MCP locations must identify the same local self, owner or QQ identity as their structured scope.');
    }
    return { type: 'mcp', server, uri, scope, crossGroup };
  }
  fail('INDEX_INVALID_LOCATION', 'Location accepts only a skill path or a named MCP resource and scope.');
}

export function normalizeMemoryItem(item) {
  if (!keys(item, FIELDS)) fail('INDEX_INVALID_ITEM', 'Memory index entries contain exactly seven metadata fields, without bodies or profiles.');
  const id = short(item.id, 'id');
  if (['__proto__', 'constructor', 'prototype'].includes(id)) fail('INDEX_INVALID_ITEM', 'Reserved memory ID.');
  const topic = short(item.topic, 'topic', 200);
  const time = normalizeTime(item.time);
  if (typeof item.importance !== 'number' || !Number.isFinite(item.importance) || item.importance < 0 || item.importance > 1) {
    fail('INDEX_INVALID_ITEM', 'importance must be a finite number from 0 to 1.');
  }
  if (!Array.isArray(item.triggers) || item.triggers.length > 32) fail('INDEX_INVALID_ITEM', 'triggers must contain at most 32 short phrases.');
  const triggers = [...new Set(item.triggers.map(value => short(value, 'trigger', 128)))];
  if (!STATUSES.includes(item.status)) fail('INDEX_INVALID_ITEM', 'Unknown memory status.');
  const location = normalizeLocation(item.location);
  if (location.type === 'mcp' && item.status !== 'active' && !(location.scope.kind !== 'identity' && item.status === 'archived')) fail('INDEX_CORE_IMMUTABLE', 'Core identities must remain active; revoked important event projections may be archived.');
  return { id, topic, time, importance: item.importance, triggers, status: item.status, location };
}

function validateState(state) {
  if (!keys(state, ['schemaVersion', 'revision', 'items']) || state.schemaVersion !== 1
    || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.items) || state.items.length > 100000) {
    fail('INDEX_CORRUPT', 'Memory index header is invalid; its file was preserved.');
  }
  const seen = new Set();
  for (const item of state.items) {
    const normalized = normalizeMemoryItem(item);
    if (JSON.stringify(item) !== JSON.stringify(normalized) || seen.has(item.id)) fail('INDEX_CORRUPT', 'Memory index entries are invalid or duplicated.');
    seen.add(item.id);
  }
  return state;
}
function accessible(item, scope, crossGroup) {
  const origin = item.location.scope;
  if (item.status !== 'active') return false;
  if (scope.kind === 'local-owner') return true;
  const people = scope.kind === 'qq-group' ? scope.qqIds : [scope.qqId];
  if (origin.kind === 'identity') return origin.id === 'self' || people.includes(origin.qqId ?? (origin.id === 'owner' ? null : origin.id));
  if (origin.kind === 'qq-direct') return scope.kind === 'qq-direct' && origin.qqId === scope.qqId;
  if (origin.kind === 'qq-group' && scope.kind === 'qq-group') {
    return origin.groupId === scope.groupId || (crossGroup && item.location.crossGroup && origin.qqIds.some(id => people.includes(id)));
  }
  return false;
}
function readPolicy(options) {
  if (!plain(options) || typeof (options.crossGroup ?? false) !== 'boolean') fail('INDEX_INVALID_SCOPE', 'Retrieval needs a trusted scope and boolean policy.');
  return { scope: normalizeScope(options.scope), crossGroup: options.crossGroup ?? false };
}

/** Metadata-only durable index. Body resolution and authorization stay with the host. */
export class MemoryIndex {
  constructor({ root, lockTimeoutMs = 5000, ioRetryMs = 500 } = {}) {
    this.root = validateMemoryPath(root, { directory: true });
    for (const value of [lockTimeoutMs, ioRetryMs]) if (!Number.isSafeInteger(value) || value < 0 || value > 30000) fail('INDEX_INVALID_ARGUMENT', 'Retry timeouts must be integers from 0 to 30000 ms.');
    this.lockTimeoutMs = lockTimeoutMs; this.ioRetryMs = ioRetryMs;
    this.file = path.join(this.root, 'memory-index.json');
    this.lockFile = path.join(this.root, 'memory-index.lock');
    fs.mkdirSync(this.root, { recursive: true });
    if (fs.lstatSync(this.root).isSymbolicLink()) fail('INDEX_INVALID_PATH', 'The index directory cannot be a symbolic link.');
    if (!fs.existsSync(this.file)) this.#transaction(() => null, true);
    else this.#read();
  }

  #retry(operation) {
    const deadline = Date.now() + this.ioRetryMs;
    while (true) {
      try { return operation(); }
      catch (error) {
        if (!sharingError(error) || Date.now() >= deadline) throw error;
        wait(Math.max(1, Math.min(10, deadline - Date.now())));
      }
    }
  }
  #read(allowNew = false) {
    let text;
    try {
      const stat = this.#retry(() => fs.lstatSync(this.file));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INDEX_BYTES) fail('INDEX_CORRUPT', 'The index is not a bounded regular file.');
      text = this.#retry(() => fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (allowNew && error.code === 'ENOENT') return { schemaVersion: 1, revision: 0, items: [] };
      if (error instanceof MemoryIndexError) throw error;
      throw new MemoryIndexError(error.code === 'ENOENT' ? 'INDEX_MISSING' : 'INDEX_READ_FAILED', 'Memory index could not be read; no replacement was created.', { cause: error });
    }
    try { return validateState(JSON.parse(text)); }
    catch (error) { throw new MemoryIndexError('INDEX_CORRUPT', 'Memory index is invalid; its original file was preserved.', { cause: error }); }
  }
  #lock() {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      let fd;
      try { fd = fs.openSync(this.lockFile, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST' && !sharingError(error)) throw new MemoryIndexError('INDEX_LOCK_FAILED', 'Could not create the index lock.', { cause: error });
        if (Date.now() >= deadline) fail('INDEX_LOCKED', 'Memory index is locked; an existing or crashed writer lock is never stolen.');
        wait(Math.max(1, Math.min(10, deadline - Date.now()))); continue;
      }
      const token = randomUUID();
      try {
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }));
        fs.fsyncSync(fd);
        return { fd, token };
      } catch (error) {
        try { fs.closeSync(fd); } catch {}
        try { this.#retry(() => fs.unlinkSync(this.lockFile)); } catch {}
        throw new MemoryIndexError('INDEX_LOCK_FAILED', 'Could not initialize the acquired index lock.', { cause: error });
      }
    }
  }
  #unlock({ fd, token }) {
    try { fs.closeSync(fd); } catch {}
    try {
      const current = JSON.parse(this.#retry(() => fs.readFileSync(this.lockFile, 'utf8')));
      if (current.token === token) this.#retry(() => fs.unlinkSync(this.lockFile));
    } catch { /* Never delete a replaced, unreadable, or foreign lock. */ }
  }
  #persist(state) {
    validateState(state);
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(contents, 'utf8') > MAX_INDEX_BYTES) fail('INDEX_TOO_LARGE', 'Memory index exceeds the 128 MiB storage limit; its prior file was preserved.');
    const temp = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, contents, 'utf8'); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      this.#retry(() => fs.renameSync(temp, this.file));
    } catch (error) {
      throw new MemoryIndexError('INDEX_WRITE_FAILED', 'Memory index was not committed; its previous file was preserved.', { cause: error });
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { this.#retry(() => fs.unlinkSync(temp)); } catch {}
    }
  }
  #transaction(change, initialize = false) {
    const lock = this.#lock();
    try {
      const exists = fs.existsSync(this.file), state = this.#read(initialize);
      if (initialize && exists) return null;
      const before = JSON.stringify(state), result = change(state);
      if (!exists || JSON.stringify(state) !== before) {
        if (exists) state.revision++;
        this.#persist(state);
      }
      return copy(result);
    } finally { this.#unlock(lock); }
  }

  upsert(item) {
    const normalized = normalizeMemoryItem(item);
    return this.#transaction(state => {
      const position = state.items.findIndex(value => value.id === normalized.id);
      const existing = state.items[position];
      if (existing && existing.status !== 'active' && normalized.status === 'active') fail('INDEX_REACTIVATION_REQUIRED', 'Ordinary upserts cannot reactivate archived or forgotten memory.');
      if (existing?.status === 'forgotten' && normalized.status !== 'forgotten') fail('INDEX_FORGOTTEN', 'Forgotten memory cannot be restored by an upsert.');
      const changed = !existing || JSON.stringify(existing) !== JSON.stringify(normalized);
      if (changed) {
        if (existing) state.items[position] = normalized; else state.items.push(normalized);
      }
      return { item: changed ? normalized : existing, created: !existing, changed };
    });
  }
  /** Import a complete snapshot in one transaction, preserving every status. */
  importMetadata(items) {
    if (!Array.isArray(items) || items.length > 100000) fail('INDEX_INVALID_ARGUMENT', 'Metadata imports accept at most 100000 entries.');
    const incoming = items.map(normalizeMemoryItem), seen = new Set();
    for (const item of incoming) {
      if (seen.has(item.id)) fail('INDEX_IMPORT_CONFLICT', 'The imported snapshot contains duplicate IDs.');
      seen.add(item.id);
    }
    return this.#transaction(state => {
      const existing = new Map(state.items.map(item => [item.id, item])), additions = [];
      for (const item of incoming) {
        const other = existing.get(item.id);
        if (other && JSON.stringify(other) !== JSON.stringify(item)) fail('INDEX_IMPORT_CONFLICT', 'The destination contains different metadata for an imported ID.');
        if (!other) additions.push(item);
      }
      if (state.items.length + additions.length > 100000) fail('INDEX_TOO_LARGE', 'The merged index would exceed 100000 entries.');
      for (const item of additions) state.items.push(item);
      return { copied: additions.length, existing: incoming.length - additions.length, count: state.items.length, changed: additions.length > 0 };
    });
  }
  get(id, options) {
    id = short(id, 'id'); const { scope, crossGroup } = readPolicy(options);
    const item = this.#read().items.find(value => value.id === id);
    return item && accessible(item, scope, crossGroup) ? copy(item) : null;
  }
  select(options = {}) {
    const { scope, crossGroup } = readPolicy(options);
    const { topics, query = '', triggers = [], now = new Date().toISOString(), limit = 8, retainedIds = [], agingTimes = new Map(), type } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof query !== 'string' || query.length > 10000
      || !Array.isArray(triggers) || triggers.length > 64 || (topics !== undefined && (!Array.isArray(topics) || topics.length > 64))) {
      fail('INDEX_INVALID_ARGUMENT', 'Memory selection criteria exceed supported limits.');
    }
    if (type !== undefined && !['skill', 'mcp'].includes(type)) fail('INDEX_INVALID_ARGUMENT', 'Memory selection type must be skill or mcp.');
    if (!(retainedIds instanceof Set) && !Array.isArray(retainedIds)) fail('INDEX_INVALID_ARGUMENT', 'Retained IDs must be a trusted array or Set.');
    const retained = new Set(retainedIds);
    if (retained.size > 100000) fail('INDEX_INVALID_ARGUMENT', 'Too many retained IDs.');
    for (const id of retained) short(id, 'retained memory ID');
    if (!(agingTimes instanceof Map) || agingTimes.size > 100000) fail('INDEX_INVALID_ARGUMENT', 'Aging times must be a bounded trusted Map.');
    const aging = new Map();
    for (const [id, time] of agingTimes) { short(id, 'aging memory ID'); aging.set(id, normalizeTime(time)); }
    const normalize = value => value.toLocaleLowerCase().trim();
    const topicSet = topics === undefined ? null : new Set(topics.map(value => normalize(short(value, 'topic', 200))));
    const triggerSet = new Set(triggers.map(value => normalize(short(value, 'trigger', 128))));
    const queryText = normalize(query), nowMs = Date.parse(normalizeTime(now));
    const scored = this.#read().items.filter(item => accessible(item, scope, crossGroup) && (type === undefined || item.location.type === type)
      && (!topicSet || topicSet.has(normalize(item.topic)))).map(item => {
      const topic = normalize(item.topic);
      const topicMatch = queryText && (queryText.includes(topic) || topic.includes(queryText)) ? 8 : 0;
      const triggerMatches = item.triggers.reduce((score, value) => {
        const trigger = normalize(value);
        return score + Number(trigger !== '*' && (triggerSet.has(trigger) || Boolean(queryText && queryText.includes(trigger))));
      }, 0);
      // Compatibility arguments are validated above, but neither a former
      // retained flag nor replacement time can renew an episodic Skill.
      const agingStart = Date.parse(item.time);
      const ageDays = Math.max(0, nowMs - agingStart) / 86400000;
      // Only MCP records persist. Importance affects ranking, never lifetime.
      const strength = item.location.type === 'mcp' ? 1 : Math.max(0, 1 - ageDays / 10);
      return { item, matched: Boolean(topicMatch || triggerMatches || topicSet?.has(topic)
        || (item.location.type === 'mcp' && item.triggers.includes('*'))),
      score: (topicMatch + Math.min(triggerMatches, 4) * 3 + item.importance * 2 + 1) * strength };
    }).filter(value => value.matched);
    scored.sort((a, b) => b.score - a.score || b.item.time.localeCompare(a.item.time) || a.item.id.localeCompare(b.item.id));
    return scored.slice(0, limit).map(value => copy(value.item));
  }
  setStatus(id, status) {
    id = short(id, 'id');
    if (!STATUSES.includes(status)) fail('INDEX_INVALID_ARGUMENT', 'Unknown memory status.');
    return this.#transaction(state => {
      const item = state.items.find(value => value.id === id);
      if (!item) fail('INDEX_NOT_FOUND', 'Memory metadata was not found.');
      if (item.location.type === 'mcp' && status !== 'active' && !(item.location.scope.kind !== 'identity' && status === 'archived')) fail('INDEX_CORE_IMMUTABLE', 'Core identities cannot be archived or forgotten.');
      if (item.status === 'forgotten' && status !== 'forgotten') fail('INDEX_FORGOTTEN', 'Forgotten memory is a terminal tombstone.');
      const changed = item.status !== status; item.status = status;
      return { item, changed };
    });
  }
  /** Privileged host administration only; never expose unfiltered metadata to model tools. */
  listMetadata({ status, limit = 100000 } = {}) {
    if ((status !== undefined && !STATUSES.includes(status)) || !Number.isInteger(limit) || limit < 1 || limit > 100000) fail('INDEX_INVALID_ARGUMENT', 'Invalid metadata listing criteria.');
    return copy(this.#read().items.filter(item => status === undefined || item.status === status).slice(0, limit));
  }
  status() {
    const state = this.#read();
    return { revision: state.revision, count: state.items.length,
      ...Object.fromEntries(STATUSES.map(status => [status, state.items.filter(item => item.status === status).length])) };
  }
}
