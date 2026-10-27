const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createFriendPetCache, dateKey } = require('../src/services/friend-pet-cache');
const { createFriendPetSync } = require('../src/services/friend-pet-sync');

test('pet cache isolates accounts, corrects old guard/no-dog results and expires at midnight', () => {
    let clock = new Date(2026, 9, 19, 12).getTime();
    const disk = new Map(), writes = [];
    const cache = createFriendPetCache({ now: () => clock, file: id => `account:${id}`,
        read: file => disk.get(file), write: (file, value) => { disk.set(file, structuredClone(value)); writes.push(file); } });
    cache.record(9, 90021, 'a'); cache.record(9, 90002, 'b');
    assert.equal(cache.getState(9, 'a'), 'protect'); assert.equal(cache.getState(9, 'b'), 'other');
    cache.record(9, 0, 'a'); assert.deepEqual(cache.guards('a'), {});
    assert.equal(cache.entries('a')[9].dogId, 0);
    assert.equal(cache.getState(10, 'a'), 'unknown');
    cache.record(10, undefined, 'a'); cache.record(10, NaN, 'a');
    assert.equal(cache.getState(10, 'a'), 'unknown');
    assert.equal(writes.length, 0, 'visits batch disk writes');
    cache.flushAll(); assert.equal(writes.length, 2);
    clock += 86400000;
    assert.equal(cache.getState(9, 'a'), 'unknown');
    cache.flushAll(); assert.deepEqual(disk.get('account:a').entries, {});
});

test('same-day legacy guards migrate; old-day entries and malformed pet data remain unknown', () => {
    const clock = new Date(2026, 9, 19, 12).getTime(), writes = [];
    const cache = createFriendPetCache({ now: () => clock, file: id => `new:${id}`,
        read: file => file === 'new:old' ? { version: 1, date: dateKey(clock - 86400000), entries: { 9: { dogId: 90021, checkedAt: clock } } }
            : file === 'new:bad' ? { version: 1, date: dateKey(clock), entries: { 9: { dogId: -2, checkedAt: clock }, 10: { dogId: 90021 } } }
                : file.startsWith('new:') ? null : { updatedAt: clock, dogInfo: { 9: { dogId: 90021 } } },
        write: (file, value) => writes.push({ file, value }) });
    assert.equal(cache.getState(9, 'legacy'), 'protect');
    assert.equal(cache.getState(9, 'old'), 'unknown');
    assert.equal(cache.getState(9, 'bad'), 'unknown');
    assert.equal(cache.getState(10, 'bad'), 'unknown');
    cache.flushAll(); assert.equal(writes.find(w => w.file === 'new:legacy').value.entries[9].dogId, 90021);
});

function harness(overrides = {}) {
    const known = new Set(), calls = [], load = { heartbeatMisses: 0, oldestPendingAgeMs: 0 };
    const deps = { enabled: () => true, connected: () => true, quiet: () => false,
        myGid: () => 1, load: () => load, idle: async () => true,
        listFriends: async () => [{ gid: 1 }, { gid: 2 }, { gid: 2 }, { gid: 3 }],
        excluded: gid => gid === 3, known: gid => known.has(gid), friendBusy: () => false,
        enter: async gid => { calls.push(`enter:${gid}`); known.add(gid); },
        leave: async gid => { calls.push(`leave:${gid}`); }, flush: () => calls.push('flush'),
        pause: async () => {}, ...overrides };
    const sync = createFriendPetSync(deps, { startup: 999999 });
    sync.start(); return { sync, known, calls, deps, load };
}

test('sync visits only unknown allowed friends, pairs Leave, and never re-probes known no-dog results', async t => {
    const h = harness(); t.after(() => h.sync.stop());
    const result = await h.sync.run();
    assert.equal(result.reason, 'done'); assert.equal(result.checked, 1);
    assert.deepEqual(h.calls.slice(1, 3), ['enter:2', 'leave:2']);
    assert.equal((await h.sync.run()).reason, 'fresh');
    assert.equal(h.calls.filter(c => c === 'enter:2').length, 1);
});

test('sync yields to business or quiet hours and does not call failed probes completed', async t => {
    const busy = harness({ idle: async () => false }); t.after(() => busy.sync.stop());
    assert.equal((await busy.sync.run()).reason, 'contention');
    assert.ok(!busy.calls.some(c => c.startsWith('enter')));
    const quiet = harness({ quiet: () => true }); t.after(() => quiet.sync.stop());
    assert.equal((await quiet.sync.run()).reason, 'skipped');
    const fail = harness({ enter: async () => { throw new Error('gateway timeout'); } }); t.after(() => fail.sync.stop());
    assert.equal((await fail.sync.run()).reason, 'gateway_busy');
    assert.equal(fail.known.size, 0);
});

test('stop cancels in-flight work, prevents further visits and still leaves a successfully entered farm', async () => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const h = harness({ listFriends: async () => [{ gid: 2 }, { gid: 4 }],
        enter: async gid => { h.calls.push(`enter:${gid}`); entered(); await new Promise(resolve => { release = resolve; }); } });
    const round = h.sync.run(); await ready;
    assert.equal(h.sync.isVisiting(), true);
    h.sync.stop(); release();
    await round;
    assert.ok(h.calls.includes('leave:2')); assert.ok(!h.calls.includes('enter:4'));
    assert.equal(h.sync.isVisiting(), false);
    assert.equal((await h.sync.run()).reason, 'skipped');
});

test('large friend lists are bounded per round and failures stay retryable', async t => {
    const h = harness({ listFriends: async () => Array.from({ length: 50 }, (_, i) => ({ gid: i + 10 })) });
    t.after(() => h.sync.stop());
    const first = await h.sync.run();
    assert.equal(first.reason, 'quota'); assert.equal(first.checked, 10); assert.equal(first.remaining, 40);
    const second = await h.sync.run(); assert.equal(second.checked, 10); assert.equal(second.remaining, 30);
});

test('stop aborts transport signals and an old scheduled round cannot restart after stop', async () => {
    let entered, observedSignal, listCalls = 0;
    const ready = new Promise(resolve => { entered = resolve; });
    const h = harness({ listFriends: async () => { listCalls++; return [{ gid: 2 }]; },
        enter: async (_gid, { signal }) => {
            observedSignal = signal; entered();
            await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        } });
    const round = h.sync.run(); await ready;
    h.sync.stop(); assert.equal(observedSignal.aborted, true);
    assert.equal((await round).reason, 'stopped');
    await delay(15); assert.equal(listCalls, 1);
    assert.equal(h.sync.isRunning(), false);
    assert.ok(!h.calls.some(c => c.startsWith('leave:')), 'failed Enter has no successful visit to leave');
});
