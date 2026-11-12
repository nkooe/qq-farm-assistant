const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness(mode) {
  const events = [];
  const filename = path.resolve(__dirname, '../src/services/friend-visit.js');
  const local = createRequire(filename);
  const mocks = {
    '../models/store': { isAutomationOn: () => false, getPlantBlacklist: () => [] },
    '../utils/utils': { toNum: Number, log() {}, logWarn() {} },
    './friend-operation-limits': { setCanGetHelpExp() {} },
    './friend-pet-cache': { getState: () => 'none' },
    './friend-api': {
      enterFriendFarm: async gid => {
        events.push(`enter:${gid}`);
        if (mode === 'enter-error') throw new Error('enter failed');
        return { lands: mode === 'empty' ? [] : [{ id: 1 }] };
      },
      leaveFriendFarm: async gid => { events.push(`leave:${gid}`); },
      handleFriendEnterError: () => ({ handled: true }),
    },
    './friend-land-analyzer': { analyzeFriendLands() { throw new Error('analysis failed'); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process, require: name => Object.hasOwn(mocks, name) ? mocks[name] : local(name),
  }, { filename });
  return { api: module.exports, events };
}

for (const name of ['visitFriend', 'visitFriendForSteal', 'visitFriendForHelp']) {
  test(`${name} leaves exactly once after an empty farm or a processing failure`, async () => {
    for (const mode of ['empty', 'analysis-error', 'enter-error']) {
      const h = harness(mode);
      const task = h.api[name]({ gid: 42, name: 'fixture' }, {}, 1, 'A');
      if (mode === 'analysis-error') await assert.rejects(task, /analysis failed/);
      else await task;
      assert.deepEqual(h.events, mode === 'enter-error' ? ['enter:42'] : ['enter:42', 'leave:42']);
    }
  });
}
