const test = require('node:test');
const assert = require('node:assert/strict');
const { createMilkTeaAutomation } = require('../src/services/milk-tea-automation');
const { classForSchedulerNamespace } = require('../src/utils/request-context');
function harness(execute = async () => ({ status: 'idle', completed: [] })) {
    let time = 1000, ready = true, paused = false;
    const tasks = new Map(), errors = [];
    const scheduler = { clear: name => tasks.delete(name), setTimeoutTask: (name, delay, fn) => tasks.set(name, { delay, fn }) };
    const service = createMilkTeaAutomation({ scheduler, execute, now: () => time, onError: state => errors.push(state) });
    service.start({ ready: () => ready, paused: () => paused });
    return { service, tasks, errors, tick: async () => { const task = tasks.get('check'); tasks.delete('check'); time += task.delay; await task.fn(); }, set: values => { ({ ready = ready, paused = paused } = values); } };
}
test('milk tea always runs in background, waits for login and pauses for sync', async () => {
    assert.equal(classForSchedulerNamespace('milk-tea'), 'background');
    let runs = 0;
    const h = harness(async () => { runs++; return { status: 'idle', completed: [] }; });
    assert.equal(h.tasks.get('check').delay, 15000);
    h.set({ ready: false }); await h.tick(); assert.equal(runs, 0);
    assert.equal(h.service.snapshot().status, 'paused');
    h.set({ ready: true, paused: true }); await h.tick(); assert.equal(runs, 0);
    h.set({ paused: false }); await h.tick(); assert.equal(runs, 1);
    assert.equal(h.tasks.get('check').delay, 300000);
    await h.tick();
    assert.equal(runs, 2);
    assert.equal(h.service.snapshot().status, 'idle');
});
test('reconnect invalidates the running cycle and never overlaps or commits a stale result', async () => {
    let release, valid, runs = 0;
    const h = harness(async allowed => { runs++; valid = allowed; return new Promise(resolve => release = resolve); });
    const first = h.tick();
    assert.equal(valid(), true);
    h.service.stop(); assert.equal(valid(), false);
    h.service.start(); await h.tick(); assert.equal(runs, 1);
    release({ status: 'idle', message: 'stale', completed: [] }); await first;
    assert.notEqual(h.service.snapshot().message, 'stale');
    assert.equal(h.tasks.size, 1);
    const second = h.tick(); assert.equal(runs, 2);
    release({ status: 'idle', completed: [] }); await second;
});
test('inactive activities poll less, opening wakes the timer, failures retain partial success without immediate replay', async () => {
    let runs = 0;
    const h = harness(async () => { if (++runs === 1) return { status: 'inactive', completed: [] }; throw Object.assign(new Error('private server details'), { completed: ['营业收益'] }); });
    await h.tick(); assert.equal(h.tasks.get('check').delay, 1800000);
    h.service.wake(); assert.equal(h.tasks.get('check').delay, 15000);
    await h.tick();
    assert.equal(h.tasks.get('check').delay, 300000);
    assert.equal(h.service.snapshot().status, 'error');
    assert.deepEqual(h.service.snapshot().completed, ['营业收益']);
    assert.match(h.errors[0].message, /已完成营业收益/);
    assert.equal(JSON.stringify(h.errors).includes('private'), false);
    h.service.stop(); assert.equal(h.tasks.size, 0);
});

test('partial task failures are reported and remain scheduled for a fresh cycle', async () => {
    const h = harness(async () => ({ status: 'error', message: '店铺升级待重试', completed: ['营业收益'] }));
    await h.tick();
    assert.equal(h.errors.length, 1);
    assert.equal(h.service.snapshot().status, 'error');
    assert.equal(h.tasks.get('check').delay, 300000);
    h.service.stop();
});
