const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createSocksBridge, createProxyAgent, resolveProxyURL } = require('../src/services/account-proxy');

async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  return server.address().port;
}

test('native SOCKS bridge uses HTTP CONNECT authentication and carries payload bytes', async t => {
  let authorization; let target;
  const proxy = http.createServer();
  proxy.on('connect', (request, socket, head) => {
    authorization = request.headers['proxy-authorization']; target = request.url;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
    socket.on('error', () => {});
  });
  const port = await listen(t, proxy);
  const bridge = await createSocksBridge(`http://test:p%40ss@127.0.0.1:${port}`);
  t.after(() => bridge.close());
  const socket = net.connect(Number(new URL(bridge.url).port), '127.0.0.1');
  socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect');
  let next = once(socket, 'data'); socket.write(Buffer.from([5, 1, 0]));
  assert.deepEqual((await next)[0], Buffer.from([5, 0]));
  const domain = Buffer.from('remote.fixture');
  next = once(socket, 'data'); socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, Buffer.from([1, 187])]));
  assert.equal((await next)[0][1], 0);
  assert.equal(target, 'remote.fixture:443');
  assert.equal(authorization, `Basic ${Buffer.from('test:p@ss').toString('base64')}`);
  next = once(socket, 'data'); socket.write('fixture-payload');
  assert.equal((await next)[0].toString(), 'fixture-payload');
});

test('selected proxy rejection never contacts a directly reachable game WebSocket', async t => {
  let direct = 0; let requests = 0;
  const game = http.createServer(); game.on('upgrade', (_request, socket) => { direct++; socket.destroy(); });
  const gamePort = await listen(t, game);
  const proxy = http.createServer(); proxy.on('connect', (_request, socket) => { requests++; socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); });
  const port = await listen(t, proxy);
  const client = new WebSocket(`ws://127.0.0.1:${gamePort}/`, { agent: createProxyAgent(`http://127.0.0.1:${port}`), handshakeTimeout: 2000 });
  client.on('error', () => {});
  await once(client, 'error'); client.terminate();
  assert.equal(requests, 1); assert.equal(direct, 0);
});

test('missing selected profile is an error instead of falling back to direct', async () => {
  await assert.rejects(resolveProxyURL({ proxyMode: 'static' }));
  await assert.rejects(resolveProxyURL({ proxyMode: 'direct' }), /缺少账号所属用户/);
});

test('native bridge removes its handshake parser before relaying large binary payloads', async t => {
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on('connect', (_request, socket, head) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const port = await listen(t, proxy);
  const bridge = await createSocksBridge(`http://127.0.0.1:${  port}`);
  t.after(() => bridge.close());
  const socket = net.connect(Number(new URL(bridge.url).port), '127.0.0.1');
  socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect');
  let next = once(socket, 'data'); socket.write(Buffer.from([5, 1, 0]));
  assert.deepEqual((await next)[0], Buffer.from([5, 0]));
  const domain = Buffer.from('native.fixture');
  next = once(socket, 'data');
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, Buffer.from([1, 187])]));
  assert.equal((await next)[0][1], 0);
  const expected = require('node:crypto').randomBytes(65536);
  const received = new Promise((resolve, reject) => {
    const chunks = []; let length = 0;
    const timer = setTimeout(() => finish(new Error('Tunnel payload timed out')), 2000);
    function finish(error) {
      clearTimeout(timer); socket.off('data', data); socket.off('close', closed);
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    }
    function data(chunk) { chunks.push(chunk); length += chunk.length; if (length >= expected.length) finish(); }
    function closed() { finish(new Error(`Tunnel closed after ${  length  } payload bytes`)); }
    socket.on('data', data); socket.once('close', closed);
  });
  socket.write(expected);
  assert.deepEqual(await received, expected);
});

test('game SOCKS connections retain the normal heartbeat idle window and proxy DNS', () => {
  const agent = createProxyAgent('socks5://test:private@127.0.0.1:1080');
  assert.equal(agent.timeout, null); assert.equal(agent.shouldLookup, false);
});

test('native bridge supports upstream SOCKS5 authentication and sends the target hostname to the proxy', async t => {
  let credentials; let target;
  const proxy = net.createServer(socket => {
    let stage = 0; let pending = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', data => {
      if (stage === 3) { socket.write(data); return; }
      pending = Buffer.concat([pending, data]);
      if (stage === 0 && pending.length >= 2 + pending[1]) {
        pending = pending.subarray(2 + pending[1]); stage = 1; socket.write(Buffer.from([5, 2]));
      }
      if (stage === 1 && pending.length >= 3 + pending[1] && pending.length >= 3 + pending[1] + pending[2 + pending[1]]) {
        const length = pending[1]; const end = 3 + length + pending[2 + length];
        credentials = [pending.subarray(2, 2 + length).toString(), pending.subarray(3 + length, end).toString()];
        pending = pending.subarray(end); stage = 2; socket.write(Buffer.from([1, 0]));
      }
      if (stage === 2 && pending.length >= 7 && pending[3] === 3 && pending.length >= 7 + pending[4]) {
        target = pending.subarray(5, 5 + pending[4]).toString();
        stage = 3; socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      }
    });
  });
  const port = await listen(t, proxy);
  const bridge = await createSocksBridge(`socks5://test:private@127.0.0.1:${port}`);
  t.after(() => bridge.close());
  const socket = net.connect(Number(new URL(bridge.url).port), '127.0.0.1');
  socket.on('error', () => {}); t.after(() => socket.destroy()); await once(socket, 'connect');
  let next = once(socket, 'data'); socket.write(Buffer.from([5, 1, 0])); await next;
  const domain = Buffer.from('remote.invalid');
  next = once(socket, 'data'); socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, Buffer.from([1, 187])]));
  assert.equal((await next)[0][1], 0);
  assert.deepEqual(credentials, ['test', 'private']); assert.equal(target, 'remote.invalid');
  next = once(socket, 'data'); socket.write('socks-fixture'); assert.equal((await next)[0].toString(), 'socks-fixture');
  const payload = require('node:crypto').randomBytes(32768);
  const echoed = new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    const timer = setTimeout(() => finish(new Error('SOCKS relay timed out')), 2000);
    function finish(error) {
      clearTimeout(timer); socket.off('data', data); socket.off('close', closed);
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    }
    function data(chunk) { chunks.push(chunk); total += chunk.length; if (total >= payload.length) finish(); }
    function closed() { finish(new Error(`SOCKS tunnel closed after ${  total  } bytes`)); }
    socket.on('data', data); socket.once('close', closed);
  });
  socket.write(payload.subarray(0, 4096));
  socket.write(payload.subarray(4096));
  assert.deepEqual(await echoed, payload);
});
