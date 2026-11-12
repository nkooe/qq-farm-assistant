const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const proto = require('../src/utils/proto');
const db = require('../src/services/json-db');

async function harness(t) {
  await proto.loadProto();
  const dir = fs.mkdtempSync(path.join(process.env.FARM_DATA_DIR, 'email-'));
  const clock = { now: Date.parse('2026-11-12T01:59:59Z'), failWrite: false };
  const calls = [], emails = { 1: [], 2: [] }, failures = new Set();
  let active = 0, maxActive = 0, hold;
  const utils = require('../src/utils/utils');
  class ClockDate extends Date { static now() { return clock.now; } }
  const filename = path.resolve(__dirname, '../src/services/email.js');
  const statePath = id => path.join(dir, `email-claim-${crypto.createHash('sha256').update(id).digest('hex')}.json`);
  function load() {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Date: ClockDate, require(id) {
      if (id === '../config/runtime-paths') return { getDataFile: name => path.join(dir, name) };
      if (id === '../config/gameConfig') return { getItemById: () => null };
      if (id === './json-db') return { ...db, writeJsonFileAtomic(...args) {
        if (clock.failWrite) throw new Error('fixture disk full');
        return db.writeJsonFileAtomic(...args);
      } };
      if (id === '../utils/utils') return { log() {}, toNum: utils.toNum,
        getSystemDateKey: () => utils.getSystemDateKey(clock.now),
        getSystemClockMinutes: (now = clock.now) => utils.getSystemClockMinutes(now),
        getServerTimeSec: () => clock.now / 1000 };
      if (id === '../utils/proto') return proto;
      if (id === '../utils/hour-of-day') return require('../src/utils/hour-of-day');
      if (id === '../utils/network') return { async sendMsgAsync(service, method, body) {
        assert.equal(service, 'gamepb.emailpb.EmailService');
        const request = proto.types[method + 'Request'].decode(body);
        calls.push({ method, box: request.box_type, ids: Array.from(request.email_ids || []) });
        active++; maxActive = Math.max(maxActive, active);
        try {
          if (hold) await hold;
          await new Promise(resolve => setImmediate(resolve));
          if (failures.has(`${method}:${request.box_type}`)) throw new Error('fixture gateway failed');
          const reply = method === 'GetEmailList' ? { emails: emails[request.box_type] } : { items: [{ id: 1001, count: 2 }] };
          return { body: proto.types[method + 'Reply'].encode(reply).finish() };
        } finally { active--; }
      } };
      return require(id);
    } }, { filename });
    return module.exports;
  }
  return { clock, calls, emails, failures, load, statePath, get maxActive() { return maxActive; }, hold: promise => { hold = promise; } };
}

test('email respects the hour, serializes discovery and persists per-account daily completion', async t => {
  const h = await harness(t), email = h.load();
  email.configureEmailClaim({ accountId: 'A', hour: 10 });
  assert.equal((await email.checkAndClaimEmails()).skipped, 'waiting');
  h.clock.now += 1000;
  await Promise.all([email.checkAndClaimEmails(), email.checkAndClaimEmails()]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.maxActive, 1);
  assert.equal(email.getEmailDailyState().result, 'none');
  const restarted = h.load();
  restarted.configureEmailClaim({ accountId: 'A', hour: 0 });
  assert.equal((await restarted.checkAndClaimEmails(true)).skipped, 'done');
  restarted.configureEmailClaim({ accountId: 'B', hour: 0 });
  await restarted.checkAndClaimEmails();
  assert.equal(h.calls.length, 4, 'another account owns independent daily state');
  h.clock.now += 86400000;
  await restarted.checkAndClaimEmails();
  assert.equal(h.calls.length, 6);
});

test('interrupted email attempt resumes by rereading live lists; zero hour is valid', async t => {
  const h = await harness(t);
  fs.writeFileSync(h.statePath('A'), JSON.stringify({ version: 1, dateKey: '2026-11-12', result: 'running', attemptedAt: h.clock.now }));
  const email = h.load();
  email.configureEmailClaim({ accountId: 'A', hour: 0 });
  assert.equal(email.getEmailDailyState().doneToday, false);
  await email.checkAndClaimEmails();
  assert.equal(h.calls.length, 2);
  assert.equal(email.getEmailDailyState().scheduledHour, 0);
});

test('email batch encodes every ID once per box; successful batches are never claimed again', async t => {
  const h = await harness(t), email = h.load();
  email.configureEmailClaim({ accountId: 'A', hour: 0 });
  h.emails[1] = ['same', 'second', 'same'].map(id => ({ id, has_reward: true }));
  h.emails[2] = [{ id: 'same', has_reward: true }];
  const result = await email.checkAndClaimEmails();
  assert.equal(result.claimed, 3);
  assert.equal(result.rewardItems, 2);
  assert.deepEqual(h.calls.filter(c => c.method === 'BatchClaimEmail'), [
    { method: 'BatchClaimEmail', box: 1, ids: ['same', 'second'] },
    { method: 'BatchClaimEmail', box: 2, ids: ['same'] },
  ]);
  assert.equal(email.getEmailDailyState().result, 'ok');
  await email.checkAndClaimEmails(true);
  assert.equal(h.calls.length, 4);
});

test('partial discovery and failed writes are reported, never hidden as complete or retried as singles', async t => {
  const h = await harness(t), email = h.load();
  email.configureEmailClaim({ accountId: 'A', hour: 0 });
  h.emails[1] = [{ id: 'one', has_reward: true }];
  h.failures.add('GetEmailList:2');
  await email.checkAndClaimEmails();
  assert.equal(email.getEmailDailyState().result, 'partial');
  email.configureEmailClaim({ accountId: 'B' });
  h.failures.add('BatchClaimEmail:1');
  await email.checkAndClaimEmails();
  assert.equal(email.getEmailDailyState().result, 'error');
  assert.equal(h.calls.some(c => c.method === 'ClaimEmail'), false);
  email.configureEmailClaim({ accountId: 'C' });
  h.clock.failWrite = true;
  const count = h.calls.length;
  assert.equal((await email.checkAndClaimEmails()).skipped, 'storage');
  assert.equal(h.calls.length, count);
  assert.equal(email.getEmailDailyState().result, 'error');
});

test('in-flight email check cannot switch identities, and remains single across midnight', async t => {
  const h = await harness(t), email = h.load();
  email.configureEmailClaim({ accountId: 'A', hour: 0 });
  let release;
  h.hold(new Promise(resolve => { release = resolve; }));
  const running = email.checkAndClaimEmails();
  assert.throws(() => email.configureEmailClaim({ accountId: 'B' }), /切换账号/);
  h.clock.now += 86400000;
  assert.equal((await email.checkAndClaimEmails()).skipped, 'running');
  release(); await running;
  assert.equal(h.calls.length, 2);
});
