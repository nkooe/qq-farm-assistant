const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getDataDir, getProgramRoot } = require('../config/runtime-paths');

const PREFIX = Buffer.from('QQFARM_LOGIN:');
const MAX_LINE = 3 * 1024 * 1024;
const PHASES = new Set(['starting', 'waiting_scan', 'scanned', 'initializing', 'requesting', 'success', 'login_failed', 'expired', 'offline', 'error']);
const validCode = value => typeof value === 'string' && /^[\w.~+/=%-]{8,2048}$/.test(value) && !/^[-+]?\d+$/.test(value);

class QqScanError extends Error {
  constructor(message, status = 400, kind) { super(message); this.status = status; this.kind = kind || (status === 410 ? 'cancelled' : status === 429 ? 'busy' : status === 504 ? 'timeout' : undefined); }
}

function nativeLaunch(environment = process.env) {
  const component = environment.QQ_LOGIN_COMPONENT_DIR || path.join(getProgramRoot(), 'core', 'qq-login');
  const runtime = environment.QQ_LOGIN_RUNTIME_DIR || path.join(component, 'native', `${process.platform}-${process.arch}`);
  const host = path.join(component, 'host.mjs');
  const executable = environment.QQ_LOGIN_EXECUTABLE || path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'qq');
  if (![host, path.join(runtime, 'wrapper.node'), path.join(runtime, 'napcat', 'napcat.mjs'), executable].every(file => fs.existsSync(file))) {
    throw new QqScanError('QQ 扫码组件未安装，请使用包含扫码组件的完整部署包', 503, 'configuration');
  }
  return { component, runtime, host, executable, electron: environment.QQ_LOGIN_ELECTRON === '1' };
}

function helperEnvironment(sessionDir, launch, environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NAPCAT_') || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
  }
  Object.assign(env, { FARM_QQ_RUNTIME: launch.runtime, FARM_QQ_SESSION_DIR: sessionDir, FARM_QQ_HOST: launch.host });
  const proxy = environment.QQ_LOGIN_SOCKS_PROXY || '';
  if (proxy) {
    let url;
    try { url = new URL(proxy); } catch { throw new QqScanError('QQ 扫码代理配置无效', 503); }
    if (!['socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname || !url.port || url.username || url.password) {
      throw new QqScanError('QQ 扫码代理需为 socks5://主机:端口，暂不支持密码认证', 503);
    }
    env.NAPCAT_PROXY_ADDRESS = url.hostname;
    env.NAPCAT_PROXY_PORT = url.port;
  }
  return env;
}

class QqLoginService {
  constructor(options = {}) {
    this.sessions = new Map();
    this.warm = null;
    this.closed = false;
    this.environment = options.environment || process.env;
    this.spawn = options.spawn || spawn;
    this.getLaunch = options.getLaunch || (() => nativeLaunch(this.environment));
    this.dataDir = options.dataDir || path.join(getDataDir(), 'qq-login');
    const configuredLimit = Number(this.environment.QQ_LOGIN_MAX_SESSIONS);
    this.maxSessions = options.maxSessions || (Number.isInteger(configuredLimit) && configuredLimit >= 1 && configuredLimit <= 3 ? configuredLimit : 3);
    this.ttlMs = options.ttlMs || 5 * 60 * 1000;
    this.now = options.now || Date.now;
    this.prewarmError = '';
    this.bootDir = null;
    this.credentialQueue = Promise.resolve();
    this.resolveProxy = options.resolveProxy;
    this.bridgeProxy = options.bridgeProxy;
    this.identityWaitMs = options.identityWaitMs ?? 5000;
    this.lastRecovery = null;
  }

  start() {
    if (this.closed || this.environment.QQ_LOGIN_ENABLED === '0') return;
    if (!this.timer) {
      this.timer = setInterval(() => this.sweep(), 10000);
      this.timer.unref?.();
    }
    if (!this.warm) {
      try { this.warm = this.launch(); this.prewarmError = ''; }
      catch (error) { this.prewarmError = error instanceof QqScanError ? error.message : 'QQ 扫码组件暂时不可用'; }
    }
  }

  status() {
    const enabled = !this.closed && this.environment.QQ_LOGIN_ENABLED !== '0';
    let installed = false; let error = '';
    try { this.getLaunch(); installed = true; }
    catch (cause) { error = cause instanceof QqScanError ? cause.message : 'QQ 扫码组件暂时不可用'; }
    return { enabled, installed, available: enabled && installed, running: !!this.warm || this.sessions.size > 0,
      activeSessions: this.sessions.size, error: error || this.prewarmError, lastRecovery: this.lastRecovery };
  }

  launch(options = {}) {
    const launch = this.getLaunch();
    if (!this.bootDir) {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      this.bootDir = fs.mkdtempSync(path.join(this.dataDir, 'boot-'));
    }
    const directory = fs.mkdtempSync(path.join(this.bootDir, 'session-'));
    const item = { id: crypto.randomUUID(), owner: null, directory, phase: 'starting', message: '正在生成 QQ 二维码',
      image: '', code: '', canRequest: false, version: 0, createdAt: this.now(), expiresAt: this.now() + this.ttlMs, disposed: false,
      abortController: new AbortController(), ...options };
    try {
      if (options.profileDirectory) {
        for (const name of ['qq-data', 'state']) {
          const source = path.join(options.profileDirectory, name);
          if (fs.existsSync(source)) fs.cpSync(source, path.join(directory, name), { recursive: true, dereference: false });
        }
      }
      const args = launch.electron ? ['--no-sandbox'] : [launch.host, launch.runtime, directory];
      const environment = options.nativeProxyURL !== undefined ? { ...this.environment, QQ_LOGIN_SOCKS_PROXY: options.nativeProxyURL } : this.environment;
      const env = helperEnvironment(directory, launch, environment);
      if (options.restoreUin) env.FARM_QQ_RESTORE_UIN = String(options.restoreUin);
      else delete env.FARM_QQ_RESTORE_UIN;
      item.child = this.spawn(launch.executable, args, { cwd: directory, env,
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      // Linux QQ's Electron bootstrap needs a pipe for stderr. Drain native
      // diagnostics here without persisting account or protocol output.
      item.child.stderr?.on('data', () => {});
      let pending = Buffer.alloc(0);
      let dropping = false;
      item.child.stdout.on('data', chunk => {
        if (item.disposed) return;
        // Line framing without unbounded buffers for arbitrary native logs.
        pending = Buffer.concat([pending, chunk]);
        let at = pending.indexOf(10);
        while (at !== -1) {
          const line = pending.subarray(0, at); pending = pending.subarray(at + 1);
          if (!dropping && line.length <= MAX_LINE) this.consume(item, line);
          dropping = false;
          at = pending.indexOf(10);
        }
        if (pending.length > MAX_LINE) { pending = Buffer.alloc(0); dropping = true; }
      });
      item.child.stdin.on('error', () => {});
      item.child.on('error', () => this.fail(item, 'QQ 扫码组件无法启动，请检查部署文件'));
      item.child.on('exit', () => {
        item.exited = true;
        item.proxyBridge?.close();
        item.codeReject?.(new QqScanError('QQ 取码进程已退出，请重新扫码'));
        if (!item.disposed) this.fail(item, 'QQ 扫码组件已退出，请重新生成二维码');
        if (!item.retainDirectory) this.cleanDirectory(directory);
      });
      item.startTimer = setTimeout(() => this.fail(item, '连接 QQ 服务器超时，请检查扫码服务的网络'), 45000);
      item.startTimer.unref?.();
      return item;
    } catch (error) {
      this.cleanDirectory(directory);
      throw error;
    }
  }

  consume(item, line) {
    if (item.disposed || !line.subarray(0, PREFIX.length).equals(PREFIX)) return;
    try {
      const { kind, value } = JSON.parse(line.subarray(PREFIX.length).toString('utf8'));
      if (!value || typeof value !== 'object') return;
      if (kind === 'session') {
        // Missing identity is not a different account. Retain only its shape
        // for diagnostics and wait for a valid observed identity before saving.
        const text = ['string', 'number', 'bigint'].includes(typeof value.uin) ? String(value.uin) : '';
        item.identityShape = { type: value.uin === null ? 'null' : typeof value.uin, length: Math.min(text.length, 100) };
        if (/^\d{5,20}$/.test(text)) {
          if (item.uin && item.uin !== text) item.identityChanged = true;
          item.uin = text;
        }
      } else if (kind === 'state' && PHASES.has(value.phase)) {
        if (value.reason === 'identity_pending') item.identityPending = true;
        item.nativePhase = value.phase;
        // A native result remains retrievable even if the helper later exits.
        if (item.code && !item.codeResolve) return;
        item.phase = value.phase; item.message = String(value.message || '').slice(0, 240); item.canRequest = value.canRequest === true;
        if (['error', 'offline', 'expired', 'login_failed'].includes(value.phase)) {
          clearTimeout(item.startTimer);
          item.image = '';
          if (item.proxyMode === 'static') {
            if (value.phase === 'offline') item.message = 'QQ 代理连接已断开，当前二维码已失效；请检查所选代理或重新生成二维码';
            else if (value.phase === 'error' && item.message.startsWith('QQ 未返回有效格式的授权结果')) {
              item.message += '；扫码代理链路返回异常，请重新生成二维码';
            }
          }
          item.codeReject?.(new QqScanError(item.message));
        }
      } else if (kind === 'diagnostic' && ['identity_ready', 'identity_pending'].includes(value.event)) {
        if (['undefined', 'string', 'number', 'bigint', 'object', 'null', 'boolean'].includes(value.type)) {
          item.identityShape = { type: value.type, length: Number.isInteger(value.length) ? Math.max(0, Math.min(value.length, 100)) : 0 };
        }
      } else if (kind === 'diagnostic' && value.event === 'invalid_code_result') {
        // Retain shape only. The host never sends raw results or errMsg here.
        const types = ['undefined', 'string', 'object', 'number', 'boolean', 'null', 'array'];
        if (types.includes(value.resultType)) {
          item.diagnostic = { resultType: value.resultType,
            length: Number.isInteger(value.length) && value.length >= 0 && value.length <= 65536 ? value.length : null,
            syntax: ['empty', 'numeric', 'opaque', 'other'].includes(value.syntax) ? value.syntax : null };
        }
      } else if (kind === 'qr' && typeof value.png === 'string' && value.png.length <= 2800000) {
        const png = Buffer.from(value.png, 'base64');
        if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
        clearTimeout(item.startTimer);
        item.image = `data:image/png;base64,${value.png}`;
        item.phase = 'waiting_scan'; item.message = '请用手机 QQ 扫码并确认登录'; item.version++;
        const seconds = Number(value.expireTimeRaw);
        item.qrExpiresAt = this.now() + (seconds > 0 && seconds <= 600 ? seconds : 120) * 1000;
      } else if (kind === 'code' && validCode(value.code)) {
        clearTimeout(item.startTimer);
        item.code = value.code; item.image = ''; item.phase = 'success'; item.message = '已获取 Code';
        // A legacy record may need a farm identity check. Retain the native
        // session until import, so it can mint a fresh Code after that check.
        item.codeResolve?.(value.code);
      }
    } catch { /* Discard malformed/native diagnostic lines without logging credentials. */ }
  }

  fail(item, message) {
    if (item.disposed || item.code) return;
    item.phase = 'error'; item.message = message; item.image = ''; item.canRequest = false;
    clearTimeout(item.startTimer);
    this.stopChild(item);
  }

  create(owner, options = {}) {
    if (!owner) throw new QqScanError('请先登录管理面板', 401);
    if (this.closed || this.environment.QQ_LOGIN_ENABLED === '0') throw new QqScanError('QQ 扫码服务未启用', 503);
    this.sweep();
    for (const item of this.sessions.values()) if (item.owner === owner) this.dispose(item);
    if (this.sessions.size >= this.maxSessions) throw new QqScanError('QQ 扫码正在被使用，请稍后重试', 429);
    let item = this.warm;
    this.warm = null;
    const requestedProxy = options.nativeProxyURL ?? this.environment.QQ_LOGIN_SOCKS_PROXY ?? '';
    if (item && requestedProxy !== (this.environment.QQ_LOGIN_SOCKS_PROXY || '')) { this.dispose(item); item = null; }
    if (!item || ['error', 'expired', 'login_failed', 'offline'].includes(item.phase) || item.disposed
      || (item.qrExpiresAt && item.qrExpiresAt <= this.now())) {
      if (item) this.dispose(item);
      item = this.launch(options);
    }
    Object.assign(item, options);
    item.owner = owner; item.expiresAt = this.now() + this.ttlMs;
    this.sessions.set(item.id, item);
    return this.snapshot(item);
  }

  owned(owner, id) {
    const item = this.sessions.get(String(id || ''));
    if (!item || item.owner !== owner) throw new QqScanError('扫码会话不存在或已过期，请重新生成', 404);
    if (item.expiresAt <= this.now()) { this.dispose(item); throw new QqScanError('扫码会话已过期，请重新生成', 410); }
    return item;
  }

  snapshot(item) {
    return { sessionId: item.id, status: item.phase, message: item.message, image: item.image, code: item.code,
      expiresAt: item.expiresAt, qrVersion: item.version };
  }
  get(owner, id) { return this.snapshot(this.owned(owner, id)); }
  async refreshCode(owner, id) {
    const item = this.owned(owner, id);
    if (!item.child || item.stopping || item.disposed) throw new QqScanError('QQ 取码会话已结束，请重新扫码');
    if (item.codeResolve) throw new QqScanError('正在获取新 Code，请稍后重试', 409);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new QqScanError('获取新 Code 超时，请重新扫码')), 25000);
      const done = (error, code) => {
        clearTimeout(timer); item.codeResolve = null; item.codeReject = null;
        if (error) reject(error); else resolve(code);
      };
      item.codeResolve = code => done(null, code);
      item.codeReject = error => done(error);
      item.child.stdin.write('{"command":"request_code"}\n', error => { if (error) done(new QqScanError('QQ 取码会话已结束，请重新扫码')); });
    });
  }
  cancel(owner, id) { this.dispose(this.owned(owner, id)); }
  sweep() {
    for (const item of this.sessions.values()) if (item.expiresAt <= this.now()) this.dispose(item);
    if (this.warm && this.warm.expiresAt <= this.now()) { this.dispose(this.warm); this.warm = null; }
  }
  stopChild(item) {
    if (!item.child || item.stopping) return;
    item.stopping = true;
    try { item.child.stdin.end('{"command":"shutdown"}\n'); } catch { /* pipe already closed */ }
    const timer = setTimeout(() => { try { item.child.kill(); } catch {} }, 1500);
    timer.unref?.();
    item.child.once('exit', () => clearTimeout(timer));
  }
  cleanDirectory(directory) {
    if (!this.bootDir || path.dirname(directory) !== this.bootDir || !path.basename(directory).startsWith('session-')) return;
    fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }, () => {});
  }
  dispose(item) {
    item.disposed = true; item.image = ''; item.code = ''; clearTimeout(item.startTimer);
    item.abortController?.abort();
    item.codeReject?.(new QqScanError('扫码会话已取消或过期', 410));
    this.stopChild(item); this.sessions.delete(item.id);
    if (this.warm === item) this.warm = null;
    if (!item.retainDirectory && item.child?.exitCode !== null) this.cleanDirectory(item.directory);
  }
  profilePath(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(id || ''))) throw new QqScanError('QQ 登录态无效，请重新扫码更新', 409);
    return path.join(this.dataDir, 'profiles', id);
  }

  async shutdownForProfile(item) {
    item.retainDirectory = true;
    this.stopChild(item);
    const deadline = Date.now() + 7000;
    while (!item.exited && item.child?.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!item.exited && item.child?.exitCode === null) throw new QqScanError('QQ 登录态保存超时，请重新扫码更新', 503);
  }

  async saveProfile(item, username, id = crypto.randomUUID()) {
    if (!item.uin || item.identityChanged || item.nativePhase === 'offline') throw new QqScanError('QQ 登录态不可用，请重新扫码更新', 409);
    const verifiedUin = item.uin;
    const directory = this.profilePath(id);
    const staging = `${directory  }.new-${  crypto.randomUUID()}`;
    try {
      await this.shutdownForProfile(item);
      if (item.disposed) throw new QqScanError('扫码已取消，请重新扫码更新', 410);
      if (item.identityChanged || item.uin !== verifiedUin || item.nativePhase === 'offline') {
        throw new QqScanError('QQ 保存期间登录身份或状态变化，请重新扫码更新', 409, 'rescan');
      }
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      for (const name of ['qq-data', 'state']) {
        const source = path.join(item.directory, name);
        if (fs.existsSync(source)) fs.cpSync(source, path.join(staging, name), { recursive: true, dereference: false });
      }
      if (!fs.existsSync(path.join(staging, 'qq-data'))) throw new QqScanError('QQ 未生成可恢复的登录态，请重新扫码更新', 409);
      fs.writeFileSync(path.join(staging, 'identity.json'), JSON.stringify({ username, uin: item.uin }), { mode: 0o600 });
      fs.renameSync(staging, directory);
      return id;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      item.retainDirectory = false;
      if (item.exited || item.child?.exitCode !== null) this.cleanDirectory(item.directory);
    }
  }

  discardProfile(id) {
    if (!id) return;
    fs.rmSync(this.profilePath(id), { recursive: true, force: true });
  }

  refreshAccountCode(account, { signal, mark = () => {} } = {}) {
    mark('queued');
    const operation = this.credentialQueue.catch(() => {}).then(() => { mark('requesting'); return this.restoreAccountCode(account, signal); });
    this.credentialQueue = operation;
    return operation;
  }

  async restoreAccountCode(account, signal) {
    if (this.closed || this.environment.QQ_LOGIN_ENABLED === '0') throw new QqScanError('QQ 登录态服务已停用', 503, 'configuration');
    if (signal?.aborted) throw new QqScanError('QQ 取码已取消', 410);
    const directory = this.profilePath(account.qqLoginProfile);
    let identity;
    try { identity = JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8')); }
    catch { throw new QqScanError('QQ 登录态不存在，请使用 QQ 扫码更新一次', 409, 'rescan'); }
    if (identity.username !== account.username || identity.uin !== String(account.uin || account.qq || '')) {
      throw new QqScanError('QQ 登录态身份不符，请重新扫码更新', 409, 'rescan');
    }
    this.sweep();
    if (this.sessions.size >= this.maxSessions) throw new QqScanError('QQ 扫码服务繁忙，稍后自动重试', 429);
    const { proxySetting, resolveProxyURL, createSocksBridge } = require('./account-proxy');
    const setting = proxySetting(account);
    let proxyURL; let proxyBridge;
    try {
      proxyURL = await (this.resolveProxy || resolveProxyURL)(setting);
      proxyBridge = proxyURL ? await (this.bridgeProxy || createSocksBridge)(proxyURL) : null;
    } catch { throw new QqScanError('QQ 账号代理不可用，请检查所选代理配置', 503, 'proxy'); }
    let item;
    const startedAt = Date.now();
    const diagnostic = outcome => {
      this.lastRecovery = { outcome, durationMs: Date.now() - startedAt, hasCode: !!item?.code,
        hasIdentity: !!item?.uin, identityType: item?.identityShape?.type || 'undefined',
        identityLength: item?.identityShape?.length || 0,
        matchesSaved: item?.uin ? item.uin === identity.uin && !item.identityChanged : null };
    };
    try {
      if (signal?.aborted) throw new QqScanError('QQ 取码已取消', 410);
      if (this.closed || this.sessions.size >= this.maxSessions) throw new QqScanError('QQ 扫码服务繁忙，稍后自动重试', 429);
      if (this.warm) { this.dispose(this.warm); this.warm = null; }
      item = this.launch({ ...setting, proxyURL, proxyBridge, nativeProxyURL: proxyBridge?.url || '',
        profileDirectory: directory, restoreUin: identity.uin });
      item.owner = `credential:${  crypto.randomUUID()}`;
      this.sessions.set(item.id, item);
      const deadline = Date.now() + 65000;
      let identityDeadline;
      while (!item.code || !item.uin) {
        if (signal?.aborted || item.disposed || this.closed) throw new QqScanError('QQ 取码已取消', 410);
        if (item.identityChanged || (item.uin && item.uin !== identity.uin)) throw new QqScanError('QQ 登录身份变化，请重新扫码更新', 409, 'rescan');
        if (item.code && !item.uin) identityDeadline ??= Date.now() + this.identityWaitMs;
        if (item.identityPending || (identityDeadline && Date.now() >= identityDeadline)) {
          throw new QqScanError('QQ 身份尚未就绪，稍后自动重试', 503, 'temporary');
        }
        if (['waiting_scan', 'expired', 'login_failed'].includes(item.phase)) {
          throw new QqScanError('QQ 登录态需要重新验证，请使用 QQ 扫码更新', 409, 'rescan');
        }
        if (['offline', 'error'].includes(item.phase) || item.exited) {
          throw new QqScanError('QQ 登录连接中断或取码失败，请检查网络后重试', 503, item.proxyMode === 'static' ? 'proxy' : 'temporary');
        }
        if (Date.now() >= deadline) throw new QqScanError('QQ 登录态恢复超时，稍后自动重试', 504);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (signal?.aborted || item.disposed || this.closed) throw new QqScanError('QQ 取码已取消', 410);
      if (item.nativePhase === 'offline' || item.exited) throw new QqScanError('QQ 登录连接已断开，稍后自动重试', 503, 'temporary');
      if (item.identityChanged || item.uin !== identity.uin) throw new QqScanError('QQ 登录身份变化，请重新扫码更新', 409, 'rescan');
      diagnostic('identity_verified');
      const code = item.code;
      // Keep the refreshed native credentials without changing the account's
      // opaque profile reference. Replace the snapshot only after native exit.
      const fresh = await this.saveProfile(item, identity.username);
      const freshPath = this.profilePath(fresh);
      const old = `${directory  }.old-${  crypto.randomUUID()}`;
      try {
        if (signal?.aborted || this.closed) throw new QqScanError('QQ 取码已取消', 410);
        if (!fs.existsSync(directory)) throw new QqScanError('QQ 登录态已删除或替换，请重新扫码更新', 409, 'rescan');
        fs.renameSync(directory, old);
        try { fs.renameSync(freshPath, directory); }
        catch (error) { fs.renameSync(old, directory); throw error; }
        fs.rmSync(old, { recursive: true, force: true });
      } finally {
        fs.rmSync(freshPath, { recursive: true, force: true });
      }
      diagnostic('success');
      return code;
    } catch (error) {
      diagnostic(error.kind || 'temporary');
      throw error;
    } finally {
      if (item) this.dispose(item); else proxyBridge?.close();
    }
  }

  close() {
    this.closed = true; clearInterval(this.timer);
    if (this.warm) this.dispose(this.warm);
    for (const item of this.sessions.values()) this.dispose(item);
  }
}

let sharedService;
function getQqLoginService() { return sharedService ||= new QqLoginService(); }
module.exports = { QqLoginService, QqScanError, nativeLaunch, helperEnvironment, validCode, getQqLoginService };
