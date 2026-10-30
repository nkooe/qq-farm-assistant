const net = require('node:net');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { callYybApi, resolveYybCreds } = require('../controllers/admin-yyb-routes');

function proxySetting(input = {}) {
  const mode = input.proxyMode || 'direct';
  const id = Number(input.proxyProfileId);
  if (!['direct', 'static'].includes(mode) || (mode === 'static' && (!Number.isSafeInteger(id) || id <= 0))) {
    throw new Error('请选择有效的代理配置');
  }
  return { proxyMode: mode, proxyProfileId: mode === 'static' ? id : null };
}

async function resolveProxyURL(input, context) {
  const setting = proxySetting(input);
  const userId = context?.userId;
  if (!require('../models/user-id').isUserId(userId)) throw new Error('缺少账号所属用户');
  // Runtime account fields are user editable; role comes from the user database.
  const headers = require('./user-identity').trustedUserHeaders(userId);
  if (setting.proxyMode === 'direct') return '';
  const { apiBase, apiKey } = resolveYybCreds();
  const result = await callYybApi(apiBase, '/internal/proxy-url', apiKey, {
    method: 'POST', body: JSON.stringify({ proxy_profile_id: setting.proxyProfileId }),
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!result.ok || typeof result.data?.url !== 'string') throw new Error('代理配置读取失败，请检查代理服务；连接已停止');
  try { createProxyAgent(result.data.url); }
  catch { throw new Error('代理配置格式无效；连接已停止'); }
  return result.data.url;
}

function createProxyAgent(value) {
  const url = new URL(value);
  if (['http:', 'https:'].includes(url.protocol)) return new HttpsProxyAgent(url);
  if (['socks5:', 'socks5h:'].includes(url.protocol)) { url.protocol = 'socks5h:'; return new SocksProxyAgent(url); }
  throw new Error('不支持的代理协议');
}

async function openProxySocket(value, host, port, signal) {
  const url = new URL(value);
  if (url.protocol.startsWith('socks')) {
    const agent = createProxyAgent(value);
    agent.timeout = 15000;
    const request = new EventEmitter();
    request.destroy = () => {};
    const socket = await agent.connect(request, { host, port, secureEndpoint: false });
    socket.setTimeout(0);
    if (signal.aborted) { socket.destroy(); throw new Error('Tunnel closed'); }
    return socket;
  }
  return new Promise((resolve, reject) => {
    const headers = {};
    if (url.username || url.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
    const request = (url.protocol === 'https:' ? https : http).request({
      hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: `${net.isIPv6(host) ? `[${host}]` : host}:${port}`, headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    request.once('error', reject);
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || signal.aborted) { socket.destroy(); reject(new Error('Proxy connection refused')); return; }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

// Native QQ consumes SOCKS5. Adapt both supported profile types (including auth)
// on loopback; an upstream failure only closes the tunnel, with no direct retry.
async function createSocksBridge(value) {
  createProxyAgent(value); // Validate before opening any listener.
  const sockets = new Set();
  const server = net.createServer(client => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    const controller = new AbortController();
    client.on('close', () => controller.abort());
    client.setTimeout(20000, () => client.destroy());
    let phase = 0;
    let pending = Buffer.alloc(0);
    const read = async chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 8192) return client.destroy();
      if (phase === 0) {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return;
        if (pending[0] !== 5 || !pending.subarray(2, 2 + pending[1]).includes(0)) return client.end(Buffer.from([5, 255]));
        pending = pending.subarray(2 + pending[1]); phase = 1;
        client.write(Buffer.from([5, 0]));
      }
      if (phase !== 1 || pending.length < 5) return;
      const type = pending[3];
      const count = type === 1 ? 4 : type === 3 ? pending[4] + 1 : type === 4 ? 16 : 0;
      if (pending[0] !== 5 || pending[1] !== 1 || !count) return client.destroy();
      if (pending.length < 4 + count + 2) return;
      const host = type === 1 ? [...pending.subarray(4, 8)].join('.')
        : type === 3 ? pending.subarray(5, 4 + count).toString()
          : Array.from({ length: 8 }, (_, i) => pending.readUInt16BE(4 + i * 2).toString(16)).join(':');
      const port = pending.readUInt16BE(4 + count);
      const rest = pending.subarray(6 + count);
      phase = 2; client.pause(); client.removeListener('data', onData);
      pending = Buffer.alloc(0);
      let upstream;
      try {
        upstream = await openProxySocket(value, host, port, controller.signal);
        if (client.destroyed) throw new Error('Tunnel closed');
        sockets.add(upstream);
        upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        client.setTimeout(0);
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (rest.length) upstream.write(rest);
        client.pipe(upstream).pipe(client); client.resume();
      } catch {
        upstream?.destroy();
        client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    };
    const onData = chunk => { void read(chunk); };
    client.on('data', onData);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `socks5://127.0.0.1:${server.address().port}`,
    close() { server.close(); for (const socket of sockets) socket.destroy(); },
  };
}

module.exports = { proxySetting, resolveProxyURL, createProxyAgent, createSocksBridge };
