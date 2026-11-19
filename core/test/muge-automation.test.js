const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createActivityAutomation } = require('../src/services/activity-automation');
const context = require('../src/modern/services/ranch/context');
const proto = require('../src/modern/utils/proto');
const { getServerTimeSec } = require('../src/utils/utils');
function load(relative, mocks) {
  const file = path.resolve(__dirname, relative); const local = createRequire(file); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, process, Buffer,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : local(name),
  }, { filename: file });
  return module.exports;
}
let ready;
test.before(async () => { ready = proto.loadProto(); await ready; });
const ids = { celebration: '2026111702', friends: '2026111703', handbook: '2026111704', personality: '2026111705' };
function harness(options = {}) {
  const now = getServerTimeSec();
  const group = { head: { id: '2026111700', status: 1, start_time: now - 100, end_time: now + 86400 }, children: [
    { head: { id: ids.celebration }, global_count: { total: 10, tiers: [{ tier_id: 1, status: 2 }] } },
    { head: { id: ids.friends }, invite_friend: { tiers: [{ tier_id: 1, status: 2 }] } },
    { head: { id: ids.handbook }, task: { tasks: [{ task_id: 1, status: 2 }, { task_id: 2, status: 4 }], tiers: [{ tier_id: 1, status: 1 }] } },
    { head: { id: ids.personality }, survey: { personality_id: options.personality === false ? 0 : 1 } },
  ] };
  const calls = []; const writes = [];
  let failRead = false;
  const service = load('../src/modern/services/muge-activity.js', {
    '../utils/network': { sendMsgAsync: async (_service, method, body, hooks) => {
      if (method === 'Operate') options.beforeWrite?.();
      const blocked = hooks.beforeSend?.(); if (blocked) throw blocked;
      calls.push(method);
      if (method === 'List') {
        if (failRead) throw new Error('read failed');
        options.onRead?.(calls.length);
        return { body: proto.types.MugeListReply.encode({ groups: options.missing ? [] : [group] }).finish() };
      }
      hooks.onSent?.();
      const request = proto.types.MugeOperateRequest.decode(body);
      writes.push(Number(request.cmd));
      if (options.timeout) throw new Error('sent but no receipt');
      const entry = group.children.find(row => String(row.head.id) === String(request.id));
      const field = Object.keys(request).find(key => key !== 'id' && key !== 'cmd');
      if (entry.global_count) entry.global_count.tiers[0].status = 3;
      if (entry.invite_friend) entry.invite_friend.tiers[0].status = 3;
      if (field === 'task_claim') { entry.task.tasks[0].status = 3; entry.task.tiers[0].status = 2; }
      if (field === 'task_tier_claim') entry.task.tiers[0].status = 3;
      if (entry.survey) entry.survey.share_reward_claimed = true;
      if (options.afterWrite) { options.afterWrite(); failRead = true; }
      return { body: proto.types.MugeOperateReply.encode({
        id: request.id, cmd: request.cmd, activity: entry,
        [field]: field === 'survey_claim_share_reward' ? { awards: [] } : { claimed_ids: [1], awards: [] },
      }).finish() };
    } },
  });
  return { service, calls, writes, group };
}
test('Muge claims eligible rewards in background, including tiers unlocked by task claims, without touching answers', async () => {
  const h = harness();
  const result = await h.service.runMugeAutomation(() => true);
  assert.deepEqual(h.writes, [85, 84, 82, 83, 89]);
  assert.equal(result.completed.length, 5);
  assert.equal(result.status, 'idle');
  await h.service.runMugeAutomation(() => true);
  assert.equal(h.writes.length, 5, 'claimed rewards are not submitted again');
});
test('Muge leaves unanswered surveys to the user and independent workers never share claim progress', async () => {
  const a = harness({ personality: false }); const b = harness();
  await a.service.runMugeAutomation(() => true);
  assert.deepEqual(a.writes, [85, 84, 82, 83]);
  assert.equal(b.writes.length, 0);
  await b.service.runMugeAutomation(() => true);
  assert.deepEqual(b.writes, [85, 84, 82, 83, 89]);
});
test('Muge stopped or queued on an old connection sends no operation', async () => {
  let allowed = true;
  const h = harness({ beforeWrite: () => { allowed = false; } });
  const result = await h.service.runMugeAutomation(() => allowed);
  assert.equal(result.status, 'paused');
  assert.deepEqual(h.writes, []);
  const offline = harness();
  await offline.service.runMugeAutomation(() => false);
  assert.equal(offline.calls.length, 0);
});
test('expired or absent Muge is inactive and sends no writes', async () => {
  for (const missing of [false, true]) {
    const h = harness({ missing });
    if (!missing) h.group.head.end_time = getServerTimeSec() - 1;
    const result = await h.service.runMugeAutomation(() => true);
    assert.equal(result.status, 'inactive');
    assert.deepEqual(h.writes, []);
  }
});
test('unknown Muge write stops this cycle; confirmed rewards survive a failed refresh', async () => {
  const uncertain = harness({ timeout: true });
  await assert.rejects(uncertain.service.runMugeAutomation(() => true), /no receipt/);
  assert.deepEqual(uncertain.writes, [85]);
  const confirmed = harness({ afterWrite: () => {} });
  const result = await confirmed.service.runMugeAutomation(() => true);
  assert.equal(result.status, 'idle');
  assert.equal(result.completed.length, 1);
  assert.deepEqual(confirmed.writes, [85]);
});
test('Muge manual claims and automation serialize and revalidate the server state', async () => {
  const h = harness();
  await Promise.all([h.service.operateMugeActivity('claimCelebration'), h.service.runMugeAutomation(() => true)]);
  assert.equal(h.writes.filter(cmd => cmd === 85).length, 1);
  assert.equal(h.writes.length, 5);
});
test('Muge honors ambient cancellation before sending a read', async () => {
  const h = harness();
  await assert.rejects(context.runWithSendContext({ check: () => new Error('cancelled') },
    () => h.service.runMugeAutomation(() => true)), /cancelled/);
  assert.equal(h.calls.length, 0);
});
test('activity timer is independent of browser, pauses, resumes, and drops stale completion after reconnect', async () => {
  let time = 1000; let online = true; let syncing = false; let release;
  const tasks = new Map(); const errors = [];
  let runs = 0;
  const scheduler = { clear: key => tasks.delete(key), setTimeoutTask: (key, delay, fn) => tasks.set(key, { delay, fn }) };
  const service = createActivityAutomation({ scheduler, now: () => time, onError: error => errors.push(error), execute: async allowed => {
    runs++; assert.equal(allowed(), true);
    return new Promise(resolve => release = resolve);
  } });
  const tick = async () => { const t = tasks.get('check'); tasks.delete('check'); time += t.delay; return t.fn(); };
  service.start({ ready: () => online, paused: () => syncing });
  assert.equal(tasks.get('check').delay, 15000);
  syncing = true; await tick(); assert.equal(runs, 0);
  syncing = false; online = false; await tick(); assert.equal(runs, 0);
  online = true;
  const old = tick(); service.stop(); service.start(); await tick(); assert.equal(runs, 1);
  release({ status: 'error', message: 'stale', completed: [] }); await old;
  assert.notEqual(service.snapshot().message, 'stale');
  assert.equal(errors.length, 0);
  const current = tick(); release({ status: 'inactive', message: '活动已结束', completed: [] }); await current;
  assert.equal(tasks.get('check').delay, 1800000);
  service.stop(); assert.equal(tasks.size, 0);
});
