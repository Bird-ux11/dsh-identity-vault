import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TRUST_MAX, TRUST_MIN } from './trust.mjs';

const EVENT_ID = /^[a-f0-9]{64}$/;
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const clean = value => (typeof value === 'string' ? value.slice(0, 200) : undefined);

/**
 * Owner ratings for memory trust. Kept in one small JSON file outside the
 * identity store so the store schema, its validation and the event bodies stay
 * untouched: a rating annotates a record, it never rewrites history.
 */
export function createTrustOverrides({ file } = {}) {
  if (typeof file !== 'string' || !file) fail('INVALID_ARGUMENT', '可信度覆盖表路径无效。');
  let cache = { stamp: null, data: Object.create(null) };
  const read = () => {
    let stamp;
    try { const info = statSync(file); stamp = `${info.mtimeMs}:${info.size}`; } catch { cache = { stamp: null, data: Object.create(null) }; return cache.data; }
    if (cache.stamp === stamp) return cache.data;
    let raw;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { raw = {}; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    const data = Object.create(null);
    for (const [eventId, value] of Object.entries(raw)) {
      if (!EVENT_ID.test(eventId) || !value || !Number.isInteger(value.beta)
        || value.beta < TRUST_MIN || value.beta > TRUST_MAX) continue;
      const reason = clean(value.reason), by = clean(value.by);
      data[eventId] = { beta: value.beta, ...(reason ? { reason } : {}), ...(by ? { by } : {}),
        ...(typeof value.at === 'string' ? { at: value.at } : {}) };
    }
    cache = { stamp, data };
    return data;
  };
  const write = data => {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2));
    renameSync(temp, file);
    cache = { stamp: null, data };
  };
  return {
    file,
    get(eventId) { return typeof eventId === 'string' && EVENT_ID.test(eventId) ? read()[eventId] : undefined; },
    list() { return Object.entries(read()).map(([eventId, value]) => ({ eventId, ...value })); },
    set({ eventId, beta, reason, by = 'owner', at = new Date().toISOString() } = {}) {
      if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) fail('INVALID_ARGUMENT', '事件 ID 必须是 64 位十六进制。');
      if (!Number.isInteger(beta) || beta < TRUST_MIN || beta > TRUST_MAX) {
        fail('INVALID_TRUST', `β 必须是 ${TRUST_MIN} 到 ${TRUST_MAX} 之间的整数。`);
      }
      const data = { ...read() };
      data[eventId] = { beta, ...(clean(reason) ? { reason: clean(reason) } : {}), by: clean(by) || 'owner', at };
      write(data);
      return { eventId, ...data[eventId] };
    },
    clear(eventId) {
      if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) fail('INVALID_ARGUMENT', '事件 ID 必须是 64 位十六进制。');
      const data = { ...read() };
      if (!Object.hasOwn(data, eventId)) return { eventId, cleared: false };
      delete data[eventId];
      write(data);
      return { eventId, cleared: true };
    },
    status() { return { file, overrides: Object.keys(read()).length }; },
  };
}
