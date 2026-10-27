const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    const filename = path.resolve(__dirname, '../src/utils/network.js'); const localRequire = createRequire(filename);
    const frames = []; const crypto = { encryptBuffer: async body => body, setRuntime() {} };
    const types = { GateMessage: { create: msg => msg,
        encode: msg => ({ finish: () => Buffer.from(JSON.stringify(msg)) }),
        decode: bytes => JSON.parse(bytes.toString()) } };
    const context = { Buffer, process, setTimeout, clearTimeout, console, AbortController,
        module: { exports: {} }, require(name) {
            if (name === 'ws') return { OPEN: 1 };
            if (name === './proto') return { types };
            if (name === './crypto-wasm') return crypto;
            if (name === './gateway-token') return { createGatewayToken: () => 'fixture' };
            return localRequire(name);
        } };
    const source = `${fs.readFileSync(filename, 'utf8')  }
        module.exports.fixture = { socket(value) { ws = value; }, handleMessage, count: () => pendingCallbacks.size };
    `;
    vm.runInNewContext(source, context, { filename });
    const api = context.module.exports;
    const socket = { readyState: 1, send: bytes => frames.push(JSON.parse(bytes.toString())), removeAllListeners() {}, terminate() {} };
    api.fixture.socket(socket);
    function reply(frame, code = 0) {
        api.fixture.handleMessage(Buffer.from(JSON.stringify({ meta: { ...frame.meta, message_type: 2, error_code: code }, body: [1] })));
    }
    return { api, frames, crypto, reply, socket };
}

test('concurrent encodes reserve distinct sequence IDs and responses/expected errors settle exact requests', async t => {
    const h = harness(); t.after(() => h.api.stopNetwork());
    const a = h.api.sendMsgAsync('fixture', 'A', Buffer.from([1]));
    const b = h.api.sendMsgAsync('fixture', 'B', Buffer.from([2]), { expectedErrorCodes: [99] });
    await tick();
    assert.equal(new Set(h.frames.map(f => f.meta.client_seq.low)).size, 2);
    h.reply(h.frames[1], 99); h.reply(h.frames[0]);
    await Promise.all([a, b]); assert.equal(h.api.fixture.count(), 0);
    const diagnostics = h.api.getRequestDiagnostics();
    assert.equal(diagnostics.recent.length, 2);
    assert.equal(diagnostics.recent.some(record => record.outcome === 'ok'), true);
    assert.equal(diagnostics.pending.length, 0);
    assert.equal(diagnostics.recent.every(record => record.encodeMs !== null && record.responseMs !== null), true);
    assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-token|auth_token|\bbody\b/);
    assert.equal(h.api.getGatewayLoad().pending, 0);
    await h.api.sendMsgNoReply('fixture', 'NoReply', Buffer.alloc(0));
    assert.equal(h.api.fixture.count(), 0, 'fire-and-forget never leaks a response listener');
});

test('wire sequences stay increasing when an empty request overtakes a slow encode', async t => {
    const h = harness(); t.after(() => h.api.stopNetwork());
    let complete;
    h.crypto.encryptBuffer = () => new Promise(resolve => { complete = resolve; });
    const slow = h.api.sendMsgAsync('fixture', 'SlowEncode', Buffer.from([1]));
    const empty = h.api.sendMsgAsync('fixture', 'Empty', Buffer.alloc(0));
    await tick();
    assert.equal(h.frames.length, 1, 'ready requests need not wait for unrelated encoding');
    complete(Buffer.from([1])); await tick();
    for (const frame of h.frames) h.reply(frame);
    await Promise.all([slow, empty]);
    const sequences = h.frames.map(frame => frame.meta.client_seq.low);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(h.api.fixture.count(), 0);
});

test('timeout during encryption cannot send later or leak pending callbacks', async t => {
    const h = harness(); t.after(() => h.api.stopNetwork());
    let complete;
    h.crypto.encryptBuffer = () => new Promise(resolve => { complete = resolve; });
    const request = h.api.sendMsgAsync('fixture', 'SlowEncode', Buffer.from([1]), 15);
    await assert.rejects(request, /stage=pending/);
    const diagnostic = h.api.getRequestDiagnostics().recent.at(-1);
    assert.equal(diagnostic.phase, 'encoding');
    assert.equal(diagnostic.encodeMs, null);
    assert.equal(diagnostic.outcome, 'aborted');
    complete(Buffer.from([1])); await tick();
    assert.equal(h.frames.length, 0); assert.equal(h.api.fixture.count(), 0);
});

test('disconnect rejects queued and in-flight work; old encryption never sends on a replacement socket', async t => {
    const h = harness(); t.after(() => h.api.stopNetwork());
    let complete;
    h.crypto.encryptBuffer = () => new Promise(resolve => { complete = resolve; });
    const a = h.api.sendMsgAsync('fixture', 'Old', Buffer.from([1]), { requestClass: 'friend' });
    const b = h.api.sendMsgAsync('fixture', 'Queued', Buffer.alloc(0), { requestClass: 'friend' });
    a.catch(() => {}); b.catch(() => {});
    await tick(); h.api.cleanup('fixture disconnect');
    await assert.rejects(a, /中断/); await assert.rejects(b, /中断/);
    h.api.fixture.socket({ ...h.socket }); complete(Buffer.from([1])); await tick();
    assert.equal(h.frames.length, 0); assert.equal(h.api.fixture.count(), 0);
    const next = h.api.sendMsgAsync('fixture', 'New', Buffer.alloc(0));
    await tick(); h.reply(h.frames[0]); await next;
    assert.equal(h.api.getGatewayLoad().queued, 0);
});

test('socket write errors reject immediately and diagnose the sending phase', async t => {
    const h = harness(); t.after(() => h.api.stopNetwork());
    h.socket.send = (_bytes, callback) => callback(new Error('fixture write failure'));
    await assert.rejects(h.api.sendMsgAsync('fixture', 'Heartbeat', Buffer.alloc(0)), /fixture write failure/);
    const diagnostic = h.api.getRequestDiagnostics().recent.at(-1);
    assert.equal(diagnostic.phase, 'sending');
    assert.equal(diagnostic.outcome, 'failed');
    assert.equal(diagnostic.responseMs, null);
    assert.equal(h.api.fixture.count(), 0);
});
