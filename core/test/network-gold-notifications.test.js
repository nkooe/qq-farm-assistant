const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { loadProto, types } = require('../src/utils/proto');

test.before(loadProto);

function harness(t) {
  const filename = path.resolve(__dirname, '../src/utils/network.js');
  const localRequire = createRequire(filename);
  const displayed = [];
  const context = { Buffer, process, setTimeout, clearTimeout, AbortController, console,
    module: { exports: {} }, require(name) {
      if (name === '../services/status') return { updateStatusGold: gold => displayed.push(gold) };
      return localRequire(name);
    } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.fixtureNotify = handleNotify;', context, { filename });
  const api = context.module.exports;
  t.after(() => api.stopNetwork());
  function notify(value, type = 'ItemNotify') {
    api.fixtureNotify({ body: types.EventMessage.encode({ message_type: type,
      body: types[type].encode(value).finish() }).finish() });
  }
  return { state: api.getUserState(), displayed, notify };
}

test('金币通知严格区分显式零总额与缺失总额，仅缺失总额时累加 delta', t => {
  const h = harness(t);
  h.state.gold = 1000;
  h.notify({ items: [{ item: { id: 1001, count: 970 }, delta: -30 }] });
  assert.equal(h.state.gold, 970);
  h.notify({ items: [{ item: { id: 1001 }, delta: -20 }] });
  assert.equal(h.state.gold, 950);
  h.notify({ items: [{ item: { id: 1001, count: 0 } }] });
  assert.equal(h.state.gold, 0);
  assert.deepEqual(h.displayed, [970, 950, 0]);
});

test('金币总额零优先于 delta，基本信息缺少金币时保留余额', t => {
  const h = harness(t);
  h.state.gold = 1000;
  h.notify({ items: [{ item: { id: 1, count: 0 }, delta: -30 }] });
  assert.equal(h.state.gold, 0);
  h.notify({ basic: { gold: 500 } }, 'BasicNotify');
  h.notify({ basic: { name: 'fixture' } }, 'BasicNotify');
  assert.equal(h.state.gold, 500);
  h.notify({ basic: { gold: 0 } }, 'BasicNotify');
  assert.equal(h.state.gold, 0);
});
