#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { IdentityStore } from '../lib/store.mjs';
import { MemorySettings } from '../lib/memory-config.mjs';
import { TopicStore } from '../lib/topic-store.mjs';
import { isExpiredEvent, nextShanghaiMidnight, validEventMaintenance } from '../lib/event-retention.mjs';
import { prepareBridgeAdapter, installBridgeAdapter, verifyBridgeAdapter, uninstallBridgeAdapter } from '../lib/qq-adapter.mjs';

const [command = 'help', target, identityRoot] = process.argv.slice(2);
const defaultRoot = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'identity-vault');
const directoryNote = '使用CLI修改目录前请先退出DSH。运行中可在本机主人对话明确要求更改目录，由memory_set_directory在线切换。';
try {
  let result;
  if (command === 'init' || command === 'status') {
    const store = new IdentityStore({ root: target || defaultRoot() });
    const settings = new MemorySettings({ root: store.root });
    const topics = new TopicStore({ root: join(store.root, 'topics') });
    const jobs = topics.listJobs({ limit: 10000 });
    const events = topics.listEvents({ limit: 100000 });
    const activeEvents = events.filter(event => event.status === 'active' && !isExpiredEvent(event));
    const states = store.listMemoryState();
    const maintained = event => validEventMaintenance(event.maintenance) ? event.maintenance : {};
    result = { ok: true, ...store.status(), memory: { config: settings.get(), index: settings.index().status() },
      topicJobs: Object.fromEntries(['pending', 'running', 'failed', 'completed', 'expired'].map(status => [status, jobs.filter(job => job.status === status).length])),
      topicJobCountMayBeLimited: jobs.length === 10000,
      maintenance: {
        retainedEvents: activeEvents.filter(event => maintained(event).retained === true).length,
        ordinaryEvents: activeEvents.filter(event => maintained(event).retained !== true).length,
        supersededEvents: activeEvents.filter(event => Boolean(maintained(event).supersededAt)).length,
        duplicateEvents: activeEvents.filter(event => Boolean(maintained(event).duplicateOf)).length,
        duplicateGroups: activeEvents.filter(event => maintained(event).duplicateIds?.length > 0).length,
        currentStateRecords: states.length,
        currentSetStates: states.filter(state => state.operation === 'set').length,
        currentClearedStates: states.filter(state => state.operation === 'clear').length,
      },
      eventRetention: { days: 10, elapsedHours: 240, timezone: 'Asia/Shanghai', dailyAt: '00:00',
        nextDailyAt: new Date(nextShanghaiMidnight()).toISOString(),
        active: events.filter(event => event.status === 'active' && !isExpiredEvent(event)).length,
        expiredAwaitingSweep: events.filter(event => event.status === 'active' && isExpiredEvent(event)).length,
        forgotten: events.filter(event => event.status === 'forgotten').length,
        cleanupPending: events.filter(event => event.status === 'forgotten' && event.cleanup !== 'complete').length,
        countMayBeLimited: events.length === 100000, coreIdentitiesExpire: false } };
  } else if (command === 'memory-directory') {
    const settings = new MemorySettings({ root: resolve(identityRoot || defaultRoot()) });
    result = target ? { ok: true, ...settings.setDirectory(target), note: directoryNote }
      : { ok: true, ...settings.get(), note: directoryNote };
  } else if (command.startsWith('adapter-')) {
    const actions = { 'adapter-prepare': prepareBridgeAdapter, 'adapter-install': installBridgeAdapter,
      'adapter-check': verifyBridgeAdapter, 'adapter-remove': uninstallBridgeAdapter };
    if (!actions[command] || !target) throw new Error('需要明确指定 QQ 桥 lib/host.js 路径。');
    result = await actions[command](target);
  } else {
    result = { commands: ['init [dataDir]', 'status [dataDir]', 'memory-directory [absolutePath] [identityRoot]', 'adapter-prepare <bridge lib/host.js>',
      'adapter-install <bridge lib/host.js>', 'adapter-check <bridge lib/host.js>', 'adapter-remove <bridge lib/host.js>'],
      note: '主人QQ请在DSH主人权限对话中明确要求绑定。适配安装/恢复后需重载DSH宿主。' + directoryNote };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.ok === false) process.exitCode = 1;
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message }) + '\n');
  process.exitCode = 1;
}
