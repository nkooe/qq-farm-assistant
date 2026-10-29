const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { loadProto, types } = require('../src/utils/proto');
const tick = () => new Promise(resolve => setImmediate(resolve));
test.before(loadProto);

function harness(t, platform = 'qq', version = '1.15.0.2_20261001') {
    const filename = path.resolve(__dirname, '../src/utils/network.js');
    const localRequire = createRequire(filename);
    const config = { platform, clientVersion: version, wxClientVersion: version,
        serverUrl: 'wss://fixture.invalid/ws?existing=1', os: 'Windows', tsdkAceEnabled: true, heartbeatInterval: 25000 };
    const sockets = []; const runtimes = []; const timers = new Map(); const logs = [];
    let monotonic = 0; let wallTime = 1000000; let initialization;
    class Socket extends EventEmitter {
        static OPEN = 1;
        constructor(url, options) { super(); Object.assign(this, { url, options, frames: [], readyState: 0 }); sockets.push(this); }
        open() { this.readyState = 1; this.emit('open'); }
        send(bytes) { this.frames.push(types.GateMessage.decode(bytes)); }
        terminate() { this.readyState = 3; }
    }
    class Runtime {
        constructor(options) { this.options = options; runtimes.push(this); }
        async init() { if (initialization) await initialization; this.ready = true; }
        destroy() { this.ready = false; this.destroyed = true; }
        bindUser() { this.bound = true; }
        getEncryptedInitInfo() { return 'fixture-init'; }
    }
    class Ace { start() {} stop() {} }
    const profileContext = { module: { exports: {} }, require() { return {
        CONFIG: config, DEFAULT_CLIENT_VERSION: version, DEFAULT_WX_CLIENT_VERSION: version,
    }; } };
    vm.runInNewContext(fs.readFileSync(path.join(path.dirname(filename), 'client-profile.js'), 'utf8'), profileContext);
    const context = { Buffer, process, setTimeout, clearTimeout, AbortController, console,
        Date: class extends Date { static now() { return wallTime; } }, module: { exports: {} },
        require(name) {
            if (name === 'ws') return Socket;
            if (name === 'node:perf_hooks') return { performance: { now: () => monotonic } };
            if (name === '../config/config') return { CONFIG: config };
            if (name === './client-profile') return profileContext.module.exports;
            if (name === './proto') return { types };
            if (name === './crypto-wasm') return { setRuntime() {}, encryptBuffer: async b => b };
            if (name === './gateway-token') return { createGatewayToken: () => 'fixture-token' };
            if (name === './tsdk-runtime') return { TsdkRuntime: Runtime };
            if (name === '../services/ace-service') return { AceService: Ace };
            if (name === '../services/scheduler') return { createScheduler: () => ({
                setTimeoutTask: (key, ms, fn) => timers.set(key, { ms, fn }),
                setIntervalTask: (key, ms, fn) => timers.set(key, { ms, fn }),
                clear: key => timers.delete(key), clearAll: () => timers.clear(),
            }) };
            if (name === '../models/store') return { getDeviceProtocol: () => ({ enabled: false, memory: 7672, deviceId: 'ignored' }) };
            if (name === '../services/warehouse') return { getBag: async () => ({}), getBagItems: () => [] };
            if (name === '../services/status') return { updateStatusFromLogin() {} };
            if (name === './utils') return { ...localRequire(name), syncServerTime() {}, log: (...args) => logs.push(args.join(' ')), logWarn: (...args) => logs.push(args.join(' ')) };
            return localRequire(name);
        } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const api = context.module.exports;
    t.after(() => api.stopNetwork());
    function reply(socket, frame, type, value) {
        socket.emit('message', types.GateMessage.encode({ meta: { ...frame.meta, message_type: 2 },
            body: type.encode(value).finish() }).finish());
    }
    async function player(socket = sockets.at(-1), basic = { gid: 123, open_id: 'fixture-user', name: 'fixture' }) {
        socket.open(); await tick();
        const frame = socket.frames[0];
        reply(socket, frame, frame.meta.method_name === 'Login' ? types.LoginReply : types.PlayerLoginReply, basic ? { basic } : {});
        await tick();
        return frame;
    }
    async function scene(socket = sockets.at(-1), value = { global_scene_id: 1, farm_scene_ext_data: Buffer.from([1]) }) {
        reply(socket, socket.frames.at(-1), types.PlayerSceneLoginReply, value); await tick();
    }
    return { api, config, sockets, runtimes, timers, logs, player, scene, reply,
        time: (mono, wall) => { monotonic = mono; wallTime = wall; },
        initialization: promise => { initialization = promise; } };
}

for (const platform of ['qq', 'wx', 'wechat']) {
    test(`${platform}: 1.15 waits for the farm scene and pins handshake/login/heartbeat versions`, async t => {
        const h = harness(t, platform); let ready = 0;
        h.config.wxClientVersion = '1.15.0.2_wechat-custom';
        const version = platform === 'qq' ? h.config.clientVersion : h.config.wxClientVersion;
        h.api.connect('fresh-code+/', () => ready++);
        const socket = h.sockets[0]; const url = new URL(socket.url);
        assert.equal(url.searchParams.get('code'), 'fresh-code+/');
        assert.equal(url.searchParams.get('existing'), '1');
        assert.equal(url.searchParams.get('ver'), version);
        assert.equal(url.searchParams.get('platform'), platform === 'qq' ? 'qq' : 'wx');
        assert.equal(socket.options.handshakeTimeout, 20000);
        // A broadcast before the socket opens must not change this session.
        h.config.clientVersion = '1.16.9_qq'; h.config.wxClientVersion = '1.16.9_wx'; h.config.platform = 'other';
        const frame = await h.player(socket);
        assert.equal(frame.meta.method_name, 'PlayerLogin');
        const request = types.PlayerLoginRequest.decode(frame.body);
        assert.equal(request.device_info.client_version, version);
        assert.equal(request.device_info.sys_software, 'Windows');
        assert.equal(Object.hasOwn(request.device_info, 'memory'), false);
        assert.equal(Object.hasOwn(request.device_info, 'device_id'), false);
        assert.equal(request.report_data.minigame_channel, platform === 'qq' ? 'other-qq' : 'other');
        assert.equal(Object.hasOwn(request.report_data, 'callback'), false);
        assert.equal(Object.hasOwn(request, 'scene_id'), platform === 'qq');
        if (platform === 'qq') assert.equal(request.scene_id, '1234567');
        assert.equal(request.game_scene_id, 1);
        assert.equal(ready, 0); assert.equal(h.api.getUserState().gid, 0);
        const sceneFrame = socket.frames.at(-1);
        assert.equal(sceneFrame.meta.service_name, 'gamepb.globalscenepb.GlobalSceneService');
        assert.equal(sceneFrame.meta.method_name, 'PlayerSceneLogin');
        assert.equal(types.PlayerSceneLoginRequest.decode(sceneFrame.body).global_scene_id, 1);
        await h.scene(socket);
        assert.equal(ready, 1); assert.equal(h.api.getUserState().gid, 123);
        assert.equal(h.runtimes[0].options.platform, platform === 'qq' ? 'qq' : 'wx');
        h.time(25000, -1e12);
        const heartbeat = h.timers.get('heartbeat_interval').fn(); await tick();
        const hb = socket.frames.at(-1);
        const decoded = types.HeartbeatRequest.decode(hb.body);
        assert.equal(decoded.client_version, version);
        assert.equal(Object.hasOwn(decoded, 'field_3'), true);
        h.reply(socket, hb, types.HeartbeatReply, {}); await heartbeat;
        assert.equal(h.api.getGatewayLoad().heartbeatMisses, 0);
        h.time(50000, 1e15);
        const heartbeat2 = h.timers.get('heartbeat_interval').fn(); await tick();
        h.reply(socket, socket.frames.at(-1), types.HeartbeatReply, {}); await heartbeat2;
        assert.equal(h.api.getGatewayLoad().heartbeatMisses, 0);
        assert.equal(h.api.getConnectionDiagnostics().elapsedMs, 50000);
    });
}

for (const platform of ['qq', 'wx']) {
    test(`${platform}: custom 1.14 keeps the legacy Login wire layout`, async t => {
        const h = harness(t, platform, '1.14.9_custom'); let ready = 0;
        h.api.connect('legacy-code', () => ready++);
        const frame = await h.player();
        assert.equal(frame.meta.method_name, 'Login');
        const request = types.LoginRequest.decode(frame.body);
        assert.equal(request.device_info.client_version, '1.14.9_custom');
        assert.equal(Object.hasOwn(request, 'extra'), true);
        assert.equal(types.LoginRequest.fields.device_info.id, 5);
        assert.equal(ready, 1); assert.equal(h.sockets[0].frames.length, 1);
    });
}

for (const value of [{}, { global_scene_id: 2, farm_scene_ext_data: Buffer.from([1]) }, { global_scene_id: 1 }]) {
    test(`invalid scene ${JSON.stringify(value)} cannot start automation`, async t => {
        const h = harness(t); let ready = 0; let disconnected = 0;
        h.api.networkEvents.on('disconnect', () => disconnected++);
        h.api.connect('fresh-code', () => ready++); await h.player(); await h.scene(undefined, value);
        assert.equal(ready, 0); assert.equal(disconnected, 1);
        assert.equal(h.api.getUserState().gid, 0); assert.equal(h.api.getGatewayLoad().pending, 0);
        assert.equal(h.timers.size, 0); assert.equal(h.runtimes[0].destroyed, true);
    });
}

test('missing player data fails closed before attempting a scene', async t => {
    const h = harness(t); let ready = 0;
    h.api.connect('bad-player', () => ready++); await h.player(undefined, null);
    assert.equal(ready, 0); assert.equal(h.sockets[0].frames.length, 1); assert.equal(h.api.isConnected(), false);
});

test('legacy identity lookup uses the selected proxy and closes before scene login or automation', async t => {
    const h = harness(t); let identity;
    h.api.connect('probe-code', value => { identity = value; }, { identityOnly: true, proxyURL: 'http://fixture-proxy:8080' });
    assert.ok(h.sockets[0].options.agent);
    await h.player();
    assert.equal(identity.gid, '123'); assert.equal(identity.openId, 'fixture-user');
    assert.equal(h.sockets[0].frames.length, 1);
    assert.equal(h.api.isConnected(), false); assert.equal(h.timers.size, 0);
});

test('explicit reconnect with a fresh Code retains the configured proxy', async t => {
    const h = harness(t);
    h.api.connect('proxy-first-code', () => {}, { proxyURL: 'http://fixture-proxy:8080' });
    assert.equal(h.api.reconnect('proxy-second-code'), true);
    assert.ok(h.sockets[1].options.agent);
    assert.equal(h.sockets[1].options.agent.proxy.hostname, 'fixture-proxy');
});

test('a stopped or replaced scene response cannot complete login or tear down the new connection', async t => {
    const h = harness(t); let ready = 0;
    h.api.connect('old-code', () => ready++); await h.player();
    const old = h.sockets[0]; const staleMessage = old.listeners('message')[0]; const staleClose = old.listeners('close')[0];
    const frame = old.frames.at(-1);
    h.api.stopNetwork(); h.api.connect('new-code', () => ready++); await tick();
    staleMessage(types.GateMessage.encode({ meta: { ...frame.meta, message_type: 2 },
        body: types.PlayerSceneLoginReply.encode({ global_scene_id: 1, farm_scene_ext_data: Buffer.from([1]) }).finish() }).finish());
    staleClose(1006); await tick();
    assert.equal(ready, 0); assert.equal(h.sockets[1].readyState, 0);
    await h.player(h.sockets[1]); await h.scene(h.sockets[1]); assert.equal(ready, 1);
});

test('late security initialization cannot affect a newer runtime', async t => {
    const h = harness(t); let release; let ready = 0;
    h.initialization(new Promise(resolve => { release = resolve; }));
    h.api.connect('first-code', () => ready++); h.sockets[0].open(); await tick();
    h.initialization(null); h.api.connect('next-code', () => ready++);
    await h.player(h.sockets[1]); await h.scene(h.sockets[1]);
    release(); await tick();
    assert.equal(ready, 1); assert.equal(h.runtimes[1].destroyed, undefined);
    assert.equal(h.sockets[0].frames.length, 0); assert.equal(h.api.isConnected(), true);
});

test('handshake errors finalize once and reconnect requires a distinct fresh Code', async t => {
    const h = harness(t); let disconnected = 0; let failed = 0;
    h.api.networkEvents.on('disconnect', () => disconnected++);
    h.api.networkEvents.on('reconnect_failed', () => failed++);
    h.api.connect('secret-once', () => {});
    const socket = h.sockets[0]; const close = socket.listeners('close')[0];
    socket.emit('error', new Error('Unexpected server response: 403 secret-once'));
    close(1006); close(1006);
    assert.equal(disconnected, 1); assert.equal(failed, 1);
    assert.equal(h.api.reconnect(), false); assert.equal(h.api.reconnect('secret-once'), false);
    assert.equal(h.sockets.length, 1); assert.equal(h.api.getWsErrorState().code, 403);
    assert.ok(!JSON.stringify([h.api.getWsErrorState(), h.api.getConnectionDiagnostics(), h.logs]).includes('secret-once'));
    assert.equal(h.api.reconnect('fresh-second'), true); assert.equal(h.sockets.length, 2);
});

test('login initialization timeout cancels outstanding requests without reusing Code', async t => {
    const h = harness(t); let ready = 0;
    h.api.connect('timeout-code', () => ready++); h.sockets[0].open(); await tick();
    h.timers.get('connection_login_timeout').fn(); await tick();
    assert.equal(ready, 0); assert.equal(h.api.isConnected(), false);
    assert.equal(h.api.getGatewayLoad().pending, 0); assert.equal(h.timers.size, 0);
    assert.equal(h.sockets.length, 1);
});
