const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { GatewayRequestQueue } = require('../src/utils/request-queue');
const { runWithRequestClass, getAmbientRequestClass, getAmbientRequestSignal } = require('../src/utils/request-context');
const { createScheduler } = require('../src/services/scheduler');

const tick = () => new Promise(resolve => setImmediate(resolve));
function pending(queue, label, opts, starts) {
    let release;
    const promise = queue.enqueue(signal => {
        starts.push(label);
        return new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => starts.push(`abort:${label}`), { once: true }); });
    }, opts);
    promise.catch(() => {});
    return { promise, release: () => release?.(label) };
}

test('foreground bypasses queued automation while heartbeat and ACE retain independent lanes', async t => {
    const q = new GatewayRequestQueue(), starts = [];
    t.after(() => q.rejectAll());
    const farm = pending(q, 'farm', { requestClass: 'farm' }, starts);
    const friend = pending(q, 'friend', { requestClass: 'friend' }, starts);
    const fg = pending(q, 'foreground', {}, starts);
    const hb = pending(q, 'heartbeat', { criticalLane: 'heartbeat' }, starts);
    const ace = pending(q, 'ace', { criticalLane: 'ace' }, starts);
    const hb2 = pending(q, 'heartbeat2', { criticalLane: 'heartbeat' }, starts);
    await tick();
    assert.deepEqual(starts, ['farm', 'foreground', 'heartbeat', 'ace']);
    hb.release(); await hb.promise; await tick();
    assert.ok(starts.includes('heartbeat2'));
    assert.ok(!starts.includes('friend'));
    farm.release(); await farm.promise; await tick();
    assert.ok(starts.includes('friend'));
    for (const task of [friend, fg, ace, hb2]) task.release();
    await Promise.all([friend.promise, fg.promise, ace.promise, hb2.promise]);
    assert.equal(q.getLoad().pending, 0);
});

test('business total is bounded, background yields, and separate account queues do not interfere', async t => {
    const q = new GatewayRequestQueue(), other = new GatewayRequestQueue(), starts = [];
    t.after(() => { q.rejectAll(); other.rejectAll(); });
    const tasks = Array.from({ length: 5 }, (_, i) => pending(q, `fg${i}`, {}, starts));
    const bg = pending(q, 'background', { priority: 'low' }, starts);
    const independent = pending(other, 'other-account', { priority: 'low' }, starts);
    await tick();
    assert.equal(q.getLoad().pending, 3);
    assert.ok(starts.includes('other-account'));
    assert.ok(!starts.includes('background'));
    for (let i = 0; i < tasks.length; i++) { tasks[i].release(); await tick(); }
    await Promise.all(tasks.map(t => t.promise)); await tick();
    assert.ok(starts.includes('background'));
    bg.release(); independent.release(); await Promise.all([bg.promise, independent.promise]);
});

test('timeout includes queue wait, abort removes inflight transport before releasing slots, teardown never sends queued work', async () => {
    const q = new GatewayRequestQueue(), starts = [];
    const farm = pending(q, 'farm', { requestClass: 'farm' }, starts);
    const expires = q.enqueue(() => starts.push('expired'), { requestClass: 'friend', timeoutMs: 15 });
    await assert.rejects(expires, /stage=queued/);
    const controller = new AbortController();
    const fg = pending(q, 'fg', { signal: controller.signal }, starts);
    await tick(); controller.abort(new Error('cancelled'));
    await assert.rejects(fg.promise, /cancelled/);
    assert.ok(starts.includes('abort:fg'));
    const friend = pending(q, 'never', { requestClass: 'friend' }, starts);
    q.rejectAll('stopping');
    await assert.rejects(farm.promise, /stopping/); await assert.rejects(friend.promise, /stopping/);
    await tick();
    assert.ok(!starts.includes('never'));
    assert.equal(q.getLoad().pending + q.getLoad().queued, 0);
    const next = q.enqueue(() => 'new connection');
    assert.equal(await next, 'new connection');
});

test('inflight timeouts cancel execution and background queue is bounded', async t => {
    const q = new GatewayRequestQueue(), starts = [];
    t.after(() => q.rejectAll());
    const hung = pending(q, 'hung', { timeoutMs: 15 }, starts);
    await assert.rejects(hung.promise, /stage=pending/);
    assert.ok(starts.includes('abort:hung'));
    pending(q, 'block', {}, starts);
    for (let i = 0; i < 10; i++) pending(q, `bg${i}`, { requestClass: 'background' }, starts);
    await assert.rejects(q.enqueue(() => {}, { priority: 'low' }), /队列已满/);
});

test('request contexts isolate concurrent callers and infrastructure timers clear inherited cancellation', async () => {
    const controller = new AbortController();
    const values = await Promise.all(['farm', 'foreground'].map(cls => runWithRequestClass(cls, async () => {
        await delay(2); return getAmbientRequestClass();
    })));
    assert.deepEqual(values, ['farm', 'foreground']);
    await runWithRequestClass('background', () => new Promise(resolve => {
        createScheduler('ace-account-test').setTimeoutTask('context', 1, () => {
            assert.equal(getAmbientRequestClass(), null);
            assert.equal(getAmbientRequestSignal(), undefined);
            resolve();
        });
    }), { signal: controller.signal });
    assert.equal(getAmbientRequestClass(), null);
});

test('queue ages use a monotonic clock and a request starting at zero is pending', async t => {
    let now = 0;
    const q = new GatewayRequestQueue({ now: () => now });
    const starts = [];
    t.after(() => q.rejectAll());
    const request = pending(q, 'zero-start', { timeoutMs: 30 }, starts);
    await tick(); now = 5001;
    assert.equal(q.getLoad().oldestPendingAgeMs, 5001);
    await assert.rejects(request.promise, /stage=pending/);
    assert.equal(q.getLoad().oldestPendingAgeMs, 0);
});
