const VERDICT = '__BILI_DSH_COMPACTION_VERDICT__';
const TELEMETRY = '__BILI_DSH_COMPACTION_GATE_TELEMETRY__';
const POLICY = 'biliBasicCompactionPolicy';
const STOCK_COMPACTION = new Set(['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact']);
export const name = 'identity-vault-compaction-gate';
export const inject = [];

/** One startup decision. A late successful bridge cannot switch presets that
 * already started with stock compaction to a second compaction implementation. */
export function createCompactionCoordinator({ timeoutMs = 60000 } = {}) {
  let outcome = null, timer, resolve;
  const promise = new Promise(done => { resolve = done; });
  const settle = (ready, reason = ready ? 'managed-ready' : 'managed-failed') => {
    if (outcome) return outcome.active === (ready === true);
    outcome = Object.freeze({ active: ready === true, reason });
    clearTimeout(timer); resolve(outcome); return true;
  };
  return {
    settle,
    wait() {
      if (!outcome && !timer) timer = setTimeout(() => settle(false, 'startup-timeout'), timeoutMs);
      return promise;
    },
    status: () => outcome ?? { active: null, reason: 'pending' },
  };
}

const startup = createCompactionCoordinator();
/** Host must dispose a late successful backend when this returns false. */
export function settleManagedCompaction(ready) { return startup.settle(ready); }
export function managedCompactionStatus() { return startup.status(); }

function disableStock(rows) {
  let covered = 0;
  const plugins = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    if (STOCK_COMPACTION.has(row.name)) { covered++; return { ...row, disabled: true }; }
    if (row.group && Array.isArray(row.config)) {
      const nested = disableStock(row.config); covered += nested.covered;
      return nested.covered ? { ...row, config: nested.plugins } : row;
    }
    return row;
  });
  return { plugins, covered };
}

// This is our host policy, independent of an upstream gate's file layout or version.
export function createManagedCompactionGate({ coordinator = startup } = {}) {
  return function applyGate(ctx) {
    if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function' || typeof ctx.reflect?.provide !== 'function') {
      coordinator.settle(false, 'host-policy-unavailable');
      throw Object.assign(new Error('DSH must provide configuration hooks and dependency services.'), { code: 'DSH_COMPACTION_CAPABILITY_MISSING' });
    }
    let disposed = false;
    ctx.effect(() => () => { disposed = true; coordinator.settle(false, 'disposed'); }, 'identity-vault.compaction-gate-lifecycle');
    // Keep the plugin fiber active while the dependency service remains absent.
    // Awaiting startup in apply() would prevent Cordis from running disposal
    // effects until that startup wait had already completed.
    ctx.effect(async () => {
      const decision = await coordinator.wait();
      if (disposed) return;
      globalThis[VERDICT] = decision.active ? 'active' : 'inactive';
      ctx.on('internal/config', function (_raw, next) {
        const config = next();
        if (!decision.active || !Array.isArray(config?.plugins)) return config;
        const result = disableStock(config.plugins);
        if (!result.covered) return config;
        const entry = String(this?.entry?.options?.name ?? 'unnamed-entry').slice(0, 120);
        const prior = globalThis[TELEMETRY];
        const covered = Array.isArray(prior?.covered) ? prior.covered.filter(item => item && typeof item.entry === 'string' && Number.isFinite(item.rows)) : [];
        const previous = covered.find(item => item.entry === entry);
        globalThis[TELEMETRY] = { covered: [...covered.filter(item => item.entry !== entry), { entry, rows: Math.max(previous?.rows ?? 0, result.covered) }],
          sawFactoryPreset: prior?.sawFactoryPreset === true || entry === '@deepseek-ai/dsh-agent-preset' };
        return { ...config, plugins: result.plugins };
      }, { global: true });
      ctx.reflect.provide(POLICY, Object.freeze({ owner: 'dsh-identity-vault', fallback: !decision.active }));
    }, 'identity-vault.compaction-gate-startup');
  };
}

export const apply = createManagedCompactionGate();
