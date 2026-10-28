import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryIndex, resolveMemoryIndexPath } from './memory-index.mjs';

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function retry(operation) {
  const deadline = Date.now() + 500;
  while (true) {
    try { return operation(); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
      Atomics.wait(sleepBuffer, 0, 0, Math.max(1, Math.min(10, deadline - Date.now())));
    }
  }
}
function save(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    retry(() => fs.renameSync(temp, file));
  } finally { try { retry(() => fs.unlinkSync(temp)); } catch { /* Retain the original commit error. */ } }
}

/** Paths live in the plugin's own settings, never in model-produced summaries. */
export class MemorySettings {
  constructor({ root }) {
    this.root = resolveMemoryIndexPath({ configuredPath: root });
    fs.mkdirSync(this.root, { recursive: true });
    this.file = join(this.root, 'memory-settings.json');
    this.instances = new Map();
  }
  get() {
    let config;
    if (fs.existsSync(this.file)) {
      try { config = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
      catch { fail('MEMORY_CONFIG_CORRUPT', '记忆索引目录配置损坏，未重置。'); }
      if (!config || Array.isArray(config) || Object.keys(config).some(key => !['version', 'indexDirectory', 'updatedAt'].includes(key))
        || config.version !== 1 || typeof config.indexDirectory !== 'string'
        || (config.updatedAt !== undefined && (typeof config.updatedAt !== 'string' || !Number.isFinite(Date.parse(config.updatedAt))))) {
        fail('MEMORY_CONFIG_CORRUPT', '记忆目录配置格式不受支持。');
      }
    }
    return { version: 1, indexDirectory: resolveMemoryIndexPath({ identityRoot: this.root, configuredPath: config?.indexDirectory }) };
  }
  index() {
    const { indexDirectory } = this.get();
    if (!this.instances.has(indexDirectory)) this.instances.set(indexDirectory, new MemoryIndex({ root: indexDirectory }));
    return this.instances.get(indexDirectory);
  }
  setDirectory(path) {
    const directory = resolveMemoryIndexPath({ identityRoot: this.root, configuredPath: path });
    const previous = this.get().indexDirectory;
    if (directory === previous) { this.index(); return { indexDirectory: directory, changed: false, copied: 0 }; }
    const source = this.index(), destination = new MemoryIndex({ root: directory });
    const items = source.listMetadata();
    // Synchronous with host writes. Old indexes are kept; authoritative event
    // manifests let startup reconcile an interrupted copy without losing bodies.
    let imported;
    try { imported = destination.importMetadata(items); }
    catch (error) {
      if (error.code === 'INDEX_IMPORT_CONFLICT') fail('MEMORY_DIRECTORY_CONFLICT', '目标目录含不同版本的同名索引，未切换目录。');
      throw error;
    }
    if (fs.existsSync(this.file)) retry(() => fs.copyFileSync(this.file, this.file + '.previous'));
    save(this.file, { version: 1, indexDirectory: directory, updatedAt: new Date().toISOString() });
    this.instances.set(directory, destination);
    return { indexDirectory: directory, previousDirectory: previous, changed: true, copied: imported.copied, previousRetained: true };
  }
}
