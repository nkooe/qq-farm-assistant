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
    this.accountSessions = new Map();
    this.activeProfiles = new Map();
    this.accountRequests = new Map();
    this.accountGenerations = new Map();
    this.trackedItems = new Set();
    this.retiredUsers = new Set();
    this.suspendedUsers = new Set();
    this.warm = null;
    this.closed = false;
    this.environment = options.environment || process.env;
    this.spawn = options.spawn || spawn;
    this.getLaunch = options.getLaunch || (() => nativeLaunch(this.environment));
    this.dataDir = options.dataDir || path.join(getDataDir(), 'qq-login');
    this.maxSessions = Number(options.maxSessions ?? this.environment.QQ_LOGIN_MAX_SESSIONS ?? 3);
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1) throw new QqScanError('QQ_LOGIN_MAX_SESSIONS 必须为正整数', 503, 'configuration');
    this.ttlMs = options.ttlMs || 5 * 60 * 1000;
    this.now = options.now || Date.now;
    this.prewarmError = '';
    this.resolveProxy = options.resolveProxy;
    this.bridgeProxy = options.bridgeProxy;
    this.identityWaitMs = options.identityWaitMs ?? 5000;
    this.codeTimeoutMs = options.codeTimeoutMs ?? 25000;
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

  status({ owner, admin = false } = {}) {
    const enabled = !this.closed && this.environment.QQ_LOGIN_ENABLED !== '0';
    let installed = false; let error = '';
    try { this.getLaunch(); installed = true; }
    catch (cause) { error = cause instanceof QqScanError ? cause.message : 'QQ 扫码组件暂时不可用'; }
    const activeSessions = [...this.sessions.values()].filter(item => !item.accountKey && (admin || item.owner === owner)).length;
    const userId = Number(owner?.split(':')[0]);
    const residentAccounts = [...this.accountSessions.values()].filter(item => !item.disposed && !item.exited && (admin || item.accountUserId === userId)).length;
    return { enabled, installed, available: enabled && installed, running: activeSessions > 0 || residentAccounts > 0 || (admin && !!this.warm),
      activeSessions, residentAccounts, error: error || this.prewarmError, lastRecovery: admin ? this.lastRecovery : null };
  }

  launch(options = {}) {
    const launch = this.getLaunch();
    // The native client writes directly to its own persistent profile. Never
    // copy a live QQ database or change its working directory after login.
    const profileId = options.profileDirectory ? path.basename(options.profileDirectory) : crypto.randomUUID();
    const directory = this.profilePath(profileId);
    if (options.profileDirectory && path.resolve(options.profileDirectory) !== path.resolve(directory)) throw new QqScanError('QQ 登录资料目录无效', 503, 'configuration');
    if (this.activeProfiles.has(profileId)) throw new QqScanError('该账号 QQ 进程正在停止，请稍后重试', 429);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new QqScanError('QQ 登录资料目录无效', 503, 'configuration');
    const item = { id: crypto.randomUUID(), owner: null, directory, phase: 'starting', message: '正在生成 QQ 二维码',
      image: '', code: '', canRequest: false, version: 0, createdAt: this.now(), expiresAt: this.now() + this.ttlMs, disposed: false,
      abortController: new AbortController(), ...options, profileId, retainDirectory: !!options.profileDirectory };
    try {
      if (options.userId) fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ userId: options.userId, targetUserId: options.targetUserId ?? null }), { mode: 0o600 });
      const args = launch.electron ? ['--no-sandbox'] : [launch.host, launch.runtime, directory];
      const environment = options.nativeProxyURL !== undefined ? { ...this.environment, QQ_LOGIN_SOCKS_PROXY: options.nativeProxyURL } : this.environment;
      const env = helperEnvironment(directory, launch, environment);
      if (options.restoreUin) env.FARM_QQ_RESTORE_UIN = String(options.restoreUin);
      else delete env.FARM_QQ_RESTORE_UIN;
      item.child = this.spawn(launch.executable, args, { cwd: directory, env,
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.trackedItems.add(item);
      this.activeProfiles.set(profileId, item);
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
      const exited = () => {
        if (item.exited) return;
        item.exited = true;
        if (this.activeProfiles.get(profileId) === item) this.activeProfiles.delete(profileId);
        if (this.accountSessions.get(item.accountKey) === item) this.accountSessions.delete(item.accountKey);
        item.nativeOnline = false;
        item.proxyBridge?.close();
        item.codeReject?.(new QqScanError('QQ 登录进程已退出，稍后自动重试', 503, 'temporary'));
        if (!item.disposed) this.fail(item, 'QQ 扫码组件已退出，请重新生成二维码');
        if (!item.retainDirectory) this.cleanDirectory(directory);
        this.releaseItem(item);
      };
      item.child.on('exit', exited);
      item.child.on('close', exited);
      item.startTimer = setTimeout(() => this.fail(item, '连接 QQ 服务器超时，请检查扫码服务的网络'), 45000);
      item.startTimer.unref?.();
      return item;
    } catch (error) {
      if (!item.retainDirectory) this.cleanDirectory(directory);
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
          item.nativeOnline = true;
        }
      } else if (kind === 'state' && PHASES.has(value.phase)) {
        if (value.reason === 'identity_pending') item.identityPending = true;
        item.nativePhase = value.phase;
        // A native result remains retrievable even if the helper later exits.
        if (item.code && !item.codeResolve && !item.accountKey) return;
        item.phase = value.phase; item.message = String(value.message || '').slice(0, 240); item.canRequest = value.canRequest === true;
        if (['offline', 'waiting_scan', 'expired', 'login_failed'].includes(value.phase)) item.nativeOnline = false;
        if (value.phase === 'success') item.nativeOnline = true;
        if (['error', 'offline', 'expired', 'login_failed'].includes(value.phase)) {
          clearTimeout(item.startTimer);
          item.image = '';
          if (item.proxyMode === 'static') {
            if (value.phase === 'offline') item.message = 'QQ 代理连接已断开，当前二维码已失效；请检查所选代理或重新生成二维码';
            else if (value.phase === 'error' && item.message.startsWith('QQ 未返回有效格式的授权结果')) {
              item.message += '；扫码代理链路返回异常，请重新生成二维码';
            }
          }
          if (!value.requestId || value.requestId === item.codeRequestId) item.codeReject?.(new QqScanError(item.message, 503, value.reason === 'busy' ? 'busy' : 'temporary'));
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
        item.nativeOnline = false;
        item.phase = 'waiting_scan'; item.message = '请用手机 QQ 扫码并确认登录'; item.version++;
        const seconds = Number(value.expireTimeRaw);
        item.qrExpiresAt = this.now() + (seconds > 0 && seconds <= 600 ? seconds : 120) * 1000;
      } else if (kind === 'code' && validCode(value.code)) {
        if (item.codeResolve && value.requestId !== item.codeRequestId) return;
        if (item.accountKey && !item.codeResolve && !item.restoring) return;
        clearTimeout(item.startTimer);
        item.code = value.code; item.image = ''; item.phase = 'success'; item.message = '已获取 Code';
        item.nativeOnline = true;
        item.codeResolve?.(value.code);
      }
    } catch { /* Discard malformed/native diagnostic lines without logging credentials. */ }
  }

  fail(item, message) {
    if (item.disposed || (item.code && !item.accountKey)) return;
    item.nativeOnline = false;
    item.phase = 'error'; item.message = message; item.image = ''; item.canRequest = false;
    clearTimeout(item.startTimer);
    this.stopChild(item);
  }

  create(owner, options = {}) {
    if (typeof owner !== 'string' || !owner.includes(':') || !owner.split(':')[1]) throw new QqScanError('请先登录管理面板', 401);
    const rawUserId = owner.split(':')[0];
    const userId = Number(rawUserId);
    if (!/^[1-9]\d*$/.test(rawUserId) || !require('../models/user-id').isUserId(userId)) throw new QqScanError('用户身份无效', 403);
    if (options.targetUserId !== undefined && options.targetUserId !== null) require('../models/user-id').assertUserId(options.targetUserId);
    if (this.retiredUsers.has(userId) || this.retiredUsers.has(options.targetUserId)
      || this.suspendedUsers.has(userId) || this.suspendedUsers.has(options.targetUserId)) throw new QqScanError('用户已停用', 403);
    if (this.closed || this.environment.QQ_LOGIN_ENABLED === '0') throw new QqScanError('QQ 扫码服务未启用', 503);
    this.sweep();
    if ([...this.sessions.values()].filter(item => !item.accountKey).length >= this.maxSessions) throw new QqScanError('QQ 扫码正在被使用，请稍后重试', 429);
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
    item.owner = owner; item.userId = userId; item.expiresAt = this.now() + this.ttlMs;
    fs.writeFileSync(path.join(item.directory, 'owner.json'), JSON.stringify({ userId, targetUserId: options.targetUserId ?? null }), { mode: 0o600 });
    this.sessions.set(item.id, item);
    return this.snapshot(item);
  }

  owned(owner, id) {
    const item = this.sessions.get(String(id || ''));
    if (!item || item.owner !== owner) throw new QqScanError('扫码会话不存在或已过期，请重新生成', 404);
    if (item.expiresAt <= this.now()) { this.releaseScan(item); throw new QqScanError('扫码会话已过期，请重新生成', 410); }
    return item;
  }

  snapshot(item) {
    return { sessionId: item.id, status: item.phase, message: item.message, image: item.image, code: item.code,
      expiresAt: item.expiresAt, qrVersion: item.version };
  }
  get(owner, id) { return this.snapshot(this.owned(owner, id)); }
  refreshCode(owner, id) { return this.requestCode(this.owned(owner, id)); }
  async requestCode(item, signal) {
    if (!item.child || item.stopping || item.disposed) throw new QqScanError('QQ 取码会话已结束，请重新扫码');
    if (item.codeResolve) throw new QqScanError('正在获取新 Code，请稍后重试', 429);
    if (signal?.aborted) throw new QqScanError('QQ 取码已取消', 410);
    if (item.nativeOnline === false) throw new QqScanError('QQ 会话连接已断开，稍后自动重试', 503, 'temporary');
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      let settled = false;
      item.code = ''; item.codeRequestId = requestId;
      const abort = () => { done(new QqScanError('QQ 取码已取消', 410)); this.dispose(item); };
      const timer = setTimeout(() => { done(new QqScanError('获取新 Code 超时，稍后自动重试', 504)); this.dispose(item); }, this.codeTimeoutMs);
      const done = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); item.codeResolve = null; item.codeReject = null; item.codeRequestId = null;
        if (error) reject(error); else resolve(code);
      };
      item.codeResolve = code => done(null, code);
      item.codeReject = error => done(error);
      signal?.addEventListener('abort', abort, { once: true });
      item.child.stdin.write(`${JSON.stringify({ command: 'request_code', requestId })}\n`, error => { if (error) done(new QqScanError('QQ 取码会话已结束，稍后自动重试', 503, 'temporary')); });
    });
  }
  releaseScan(item) {
    this.sessions.delete(item.id);
    if (!item.accountKey) this.dispose(item);
  }
  cancel(owner, id) { this.releaseScan(this.owned(owner, id)); }
  sweep() {
    for (const item of this.sessions.values()) if (item.expiresAt <= this.now()) this.releaseScan(item);
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
    if (path.resolve(path.dirname(directory)) !== path.resolve(this.dataDir, 'profiles') || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(path.basename(directory))) return;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  dispose(item) {
    item.disposed = true; item.image = ''; item.code = ''; clearTimeout(item.startTimer);
    item.nativeOnline = false;
    if (this.accountSessions.get(item.accountKey) === item) this.accountSessions.delete(item.accountKey);
    item.abortController?.abort();
    item.codeReject?.(new QqScanError('扫码会话已取消或过期', 410));
    if (item.importPromise && !item.waitingImport) {
      item.waitingImport = true;
      const settled = () => { item.waitingImport = false; this.releaseItem(item); };
      Promise.resolve(item.importPromise).then(settled, settled);
    }
    this.stopChild(item); this.sessions.delete(item.id);
    if (this.warm === item) this.warm = null;
    if (!item.retainDirectory && item.child?.exitCode !== null) this.cleanDirectory(item.directory);
    this.releaseItem(item);
  }
  releaseItem(item) {
    if (item.disposed && item.exited && !item.waitingImport) this.trackedItems.delete(item);
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

  async saveProfile(item, userId) {
    require('../models/user-id').assertUserId(userId);
    if (this.retiredUsers.has(userId) || this.suspendedUsers.has(userId)) throw new QqScanError('用户已停用', 403);
    if (!item.uin || item.identityChanged || item.nativePhase === 'offline') throw new QqScanError('QQ 登录态不可用，请重新扫码更新', 409);
    if (item.disposed || item.stopping || item.exited) throw new QqScanError('QQ 登录进程已结束，请重新扫码更新', 503, 'temporary');
    if (!fs.existsSync(path.join(item.directory, 'qq-data'))) throw new QqScanError('QQ 未生成可恢复的登录态，请重新扫码更新', 409);
    const identityFile = path.join(item.directory, 'identity.json');
    fs.writeFileSync(identityFile, JSON.stringify({ userId, uin: item.uin }), { mode: 0o600 });
    item.retainDirectory = true;
    return item.profileId;
  }

  async discardProfile(id) {
    if (!id) return;
    const item = this.activeProfiles.get(id);
    if (item) { this.dispose(item); await this.shutdownForProfile(item); }
    fs.rmSync(this.profilePath(id), { recursive: true, force: true });
  }

  accountKey(account) {
    require('../models/user-id').assertUserId(account.userId);
    if (!account.id || !/^\d{5,20}$/.test(String(account.uin || account.qq || ''))) throw new QqScanError('QQ 账号身份无效', 409, 'rescan');
    return `${account.userId}:${account.id}`;
  }

  sessionIdentity(account) {
    return JSON.stringify([account.userId, String(account.id), String(account.uin || account.qq), account.qqLoginProfile,
      account.proxyMode || 'direct', account.proxyProfileId || null]);
  }

  getAccountState(account) {
    const key = this.accountKey(account);
    const item = this.accountSessions.get(key);
    if (!item || item.disposed || item.exited || item.sessionIdentity !== this.sessionIdentity(account)) return { state: 'stopped', connected: false };
    const connected = item.nativeOnline === true && !item.stopping && !item.identityChanged;
    const state = item.stopping ? 'stopping' : connected ? 'online' : ['waiting_scan', 'expired', 'login_failed'].includes(item.phase) ? 'needs_rescan' : item.phase === 'starting' ? 'starting' : 'offline';
    return { state, connected };
  }

  async retainAccountSession(item, account) {
    const key = this.accountKey(account);
    const identity = JSON.parse(fs.readFileSync(path.join(this.profilePath(account.qqLoginProfile), 'identity.json'), 'utf8'));
    if (item.profileId !== account.qqLoginProfile || identity.userId !== account.userId || identity.uin !== String(account.uin || account.qq)
      || item.uin !== identity.uin || item.identityChanged) throw new QqScanError('QQ 登录态身份不符，请重新扫码更新', 409, 'rescan');
    if (this.closed || item.disposed || item.stopping || item.exited || this.retiredUsers.has(account.userId) || this.suspendedUsers.has(account.userId)) throw new QqScanError('QQ 登录进程已取消', 410);
    const generation = (this.accountGenerations.get(key) || 0) + 1;
    this.accountGenerations.set(key, generation);
    const previous = this.accountSessions.get(key);
    if (previous && previous !== item) { this.dispose(previous); await this.shutdownForProfile(previous); }
    if (this.closed || item.disposed || item.stopping || item.exited || this.retiredUsers.has(account.userId)
      || this.suspendedUsers.has(account.userId) || this.accountGenerations.get(key) !== generation) {
      this.dispose(item);
      throw new QqScanError('QQ 登录进程已取消', 410);
    }
    Object.assign(item, { accountKey: key, accountUserId: account.userId, targetAccountId: String(account.id),
      sessionIdentity: this.sessionIdentity(account), retainDirectory: true });
    this.accountSessions.set(key, item);
  }

  async stopAccount(account) {
    const key = this.accountKey(account);
    this.accountGenerations.set(key, (this.accountGenerations.get(key) || 0) + 1);
    const item = this.accountSessions.get(key);
    if (item) { this.dispose(item); await this.shutdownForProfile(item); }
  }

  async purgeAccount(account) {
    const profile = account.qqLoginProfile ? this.profilePath(account.qqLoginProfile) : null;
    const uin = String(account.uin || account.qq || '');
    const items = [...this.trackedItems].filter(item =>
      (String(item.targetAccountId || '') === String(account.id) && (item.accountUserId ?? item.targetUserId ?? item.userId) === account.userId)
      || (item.userId === account.userId && ((uin && String(item.uin || item.restoreUin || '') === uin)
        || (profile && item.profileDirectory === profile))));
    const imports = items.map(item => item.importPromise).filter(Boolean);
    for (const item of items) this.dispose(item);
    await Promise.all(items.map(item => this.shutdownForProfile(item)));
    await Promise.allSettled(imports);
    for (const item of items) {
      item.retainDirectory = false;
      this.cleanDirectory(item.directory);
      if (item.savedProfile) await this.discardProfile(item.savedProfile);
    }
    if (account.qqLoginProfile) await this.discardProfile(account.qqLoginProfile);
  }

  async purgeUser(userId) {
    this.retiredUsers.add(userId);
    const items = [...this.trackedItems].filter(item => item.accountKey ? item.accountUserId === userId : item.userId === userId || item.targetUserId === userId);
    const imports = items.map(item => item.importPromise).filter(Boolean);
    for (const item of items) {
      item.retainDirectory = true;
      this.dispose(item);
      await this.shutdownForProfile(item);
      const target = path.resolve(item.directory);
      if (!target.startsWith(`${path.resolve(this.dataDir)}${path.sep}`)) throw new Error('QQ 会话目录越界');
      fs.rmSync(target, { recursive: true, force: true });
    }
    await Promise.allSettled(imports);
    if (fs.existsSync(this.dataDir)) {
      for (const boot of fs.readdirSync(this.dataDir, { withFileTypes: true })) {
        if (!boot.isDirectory() || !boot.name.startsWith('boot-')) continue;
        const bootPath = path.join(this.dataDir, boot.name);
        for (const entry of fs.readdirSync(bootPath, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith('session-')) throw new Error('QQ 会话目录格式无效');
          const target = path.join(bootPath, entry.name);
          const ownerFile = path.join(target, 'owner.json');
          if (!fs.existsSync(ownerFile)) continue; // Unclaimed prewarm contains no user's login.
          const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
          if (owner.userId === userId || owner.targetUserId === userId) fs.rmSync(target, { recursive: true, force: true });
        }
      }
    }
    const directory = path.join(this.dataDir, 'profiles');
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f-]{27}(?:\.(?:new|old)-[0-9a-f-]{36})?$/i.test(entry.name)) throw new Error('QQ 登录态目录格式无效');
      const target = path.join(directory, entry.name);
      const identityFile = path.join(target, 'identity.json');
      const ownerFile = path.join(target, 'owner.json');
      const identity = fs.existsSync(identityFile) ? JSON.parse(fs.readFileSync(identityFile, 'utf8')) : null;
      const owner = fs.existsSync(ownerFile) ? JSON.parse(fs.readFileSync(ownerFile, 'utf8')) : null;
      if (identity ? identity.userId === userId : owner?.userId === userId || owner?.targetUserId === userId) fs.rmSync(target, { recursive: true, force: true });
    }
  }

  async suspendUser(userId) {
    this.suspendedUsers.add(userId);
    const items = [...this.trackedItems].filter(item => item.accountKey ? item.accountUserId === userId : item.userId === userId || item.targetUserId === userId);
    const imports = items.map(item => item.importPromise).filter(Boolean);
    for (const item of items) this.dispose(item);
    await Promise.all(items.map(item => this.shutdownForProfile(item)));
    await Promise.allSettled(imports);
  }

  resumeUser(userId) { this.suspendedUsers.delete(userId); }

  async invalidateProxyProfile(profileId) {
    const items = [...this.trackedItems].filter(item => item.proxyMode === 'static' && item.proxyProfileId === profileId);
    const imports = items.map(item => item.importPromise).filter(Boolean);
    for (const item of items) this.dispose(item);
    await Promise.all(items.map(item => this.shutdownForProfile(item)));
    await Promise.allSettled(imports);
  }

  async refreshAccountCode(account, { signal, mark = () => {} } = {}) {
    if (signal?.aborted) throw new QqScanError('QQ 取码已取消', 410);
    const key = this.accountKey(account);
    const identity = this.sessionIdentity(account);
    const generation = this.accountGenerations.get(key) || 0;
    const existing = this.accountRequests.get(key);
    if (existing) {
      if (existing.identity === identity && existing.generation === generation && !existing.signal?.aborted) return existing.operation;
      await existing.operation.catch(() => {});
      if (signal?.aborted || (this.accountGenerations.get(key) || 0) !== generation) throw new QqScanError('QQ 取码已取消', 410);
      return this.refreshAccountCode(account, { signal, mark });
    }
    const operation = Promise.resolve().then(() => {
      mark('requesting');
      return this.restoreAccountCode(account, signal, generation);
    }).finally(() => { if (this.accountRequests.get(key)?.operation === operation) this.accountRequests.delete(key); });
    this.accountRequests.set(key, { identity, generation, signal, operation });
    return operation;
  }

  async restoreAccountCode(account, signal, generation) {
    const key = this.accountKey(account);
    const sessionIdentity = this.sessionIdentity(account);
    const cancelled = () => signal?.aborted || this.closed || (this.accountGenerations.get(key) || 0) !== generation;
    if (this.retiredUsers.has(account.userId) || this.suspendedUsers.has(account.userId)) throw new QqScanError('用户已停用', 403);
    if (this.closed || this.environment.QQ_LOGIN_ENABLED === '0') throw new QqScanError('QQ 登录态服务已停用', 503, 'configuration');
    if (cancelled()) throw new QqScanError('QQ 取码已取消', 410);
    const directory = this.profilePath(account.qqLoginProfile);
    let identity;
    try { identity = JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8')); }
    catch { throw new QqScanError('QQ 登录态不存在，请使用 QQ 扫码更新一次', 409, 'rescan'); }
    if (identity.userId !== account.userId || identity.uin !== String(account.uin || account.qq || '')) {
      throw new QqScanError('QQ 登录态身份不符，请重新扫码更新', 409, 'rescan');
    }
    this.sweep();
    const { proxySetting, resolveProxyURL, createSocksBridge } = require('./account-proxy');
    const setting = proxySetting(account);
    let item = this.accountSessions.get(key);
    let completed = false;
    let proxyBridge;
    let source = 'resident';
    const startedAt = Date.now();
    const diagnostic = outcome => {
      this.lastRecovery = { outcome, source, nativePhase: item?.nativePhase || item?.phase || '', durationMs: Date.now() - startedAt, hasCode: !!item?.code,
        hasIdentity: !!item?.uin, identityType: item?.identityShape?.type || 'undefined',
        identityLength: item?.identityShape?.length || 0,
        matchesSaved: item?.uin ? item.uin === identity.uin && !item.identityChanged : null };
    };
    try {
      if (cancelled()) throw new QqScanError('QQ 取码已取消', 410);
      if (this.retiredUsers.has(account.userId) || this.suspendedUsers.has(account.userId)) throw new QqScanError('用户已停用', 403);
      if (item && (item.disposed || item.exited || item.stopping || item.sessionIdentity !== sessionIdentity || !item.nativeOnline)) {
        this.dispose(item); await this.shutdownForProfile(item); item = null;
      }
      let code;
      if (item) {
        if (item.identityChanged || item.uin !== identity.uin) throw new QqScanError('QQ 登录身份变化，请重新扫码更新', 409, 'rescan');
        code = await this.requestCode(item, signal);
      } else {
        source = 'restored';
        let proxyURL;
        try {
          proxyURL = await (this.resolveProxy || resolveProxyURL)(setting, { userId: account.userId });
          proxyBridge = proxyURL ? await (this.bridgeProxy || createSocksBridge)(proxyURL) : null;
        } catch { throw new QqScanError('QQ 账号代理不可用，请检查所选代理配置', 503, 'proxy'); }
        if (cancelled()) throw new QqScanError('QQ 取码已取消', 410);
        if (this.retiredUsers.has(account.userId) || this.suspendedUsers.has(account.userId)) throw new QqScanError('用户已停用', 403);
        if (this.warm) { this.dispose(this.warm); this.warm = null; }
        item = this.launch({ ...setting, userId: account.userId, accountUserId: account.userId, accountKey: key,
          targetAccountId: String(account.id), sessionIdentity, restoring: true,
          proxyURL, proxyBridge, nativeProxyURL: proxyBridge?.url || '', profileDirectory: directory, restoreUin: identity.uin });
        this.accountSessions.set(key, item);
        const deadline = Date.now() + 65000;
        let identityDeadline;
        while (!item.code || !item.uin) {
          if (cancelled() || item.disposed) throw new QqScanError('QQ 取码已取消', 410);
          if (item.identityChanged || (item.uin && item.uin !== identity.uin)) throw new QqScanError('QQ 登录身份变化，请重新扫码更新', 409, 'rescan');
          if (item.code && !item.uin) identityDeadline ??= Date.now() + this.identityWaitMs;
          if (item.identityPending || (identityDeadline && Date.now() >= identityDeadline)) throw new QqScanError('QQ 身份尚未就绪，稍后自动重试', 503, 'temporary');
          if (['waiting_scan', 'expired', 'login_failed'].includes(item.phase)) throw new QqScanError('QQ 登录态需要重新验证，请使用 QQ 扫码更新', 409, 'rescan');
          if (['offline', 'error'].includes(item.phase) || item.exited) throw new QqScanError('QQ 登录连接中断或取码失败，请检查网络后重试', 503, item.proxyMode === 'static' ? 'proxy' : 'temporary');
          if (Date.now() >= deadline) throw new QqScanError('QQ 登录态恢复超时，稍后自动重试', 504);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        item.restoring = false;
        code = item.code;
      }
      if (cancelled() || item.disposed || this.accountSessions.get(key) !== item) throw new QqScanError('QQ 取码已取消', 410);
      if (item.nativePhase === 'offline' || item.exited || !item.nativeOnline) throw new QqScanError('QQ 登录连接已断开，稍后自动重试', 503, 'temporary');
      if (item.identityChanged || item.uin !== identity.uin) throw new QqScanError('QQ 登录身份变化，请重新扫码更新', 409, 'rescan');
      if (!fs.existsSync(path.join(directory, 'identity.json'))) throw new QqScanError('QQ 登录态已删除或替换，请重新扫码更新', 409, 'rescan');
      completed = true;
      diagnostic('success');
      return code;
    } catch (error) {
      // An authorization error does not itself terminate an otherwise healthy
      // QQ connection. A timeout, cancellation or identity change does.
      if (source === 'resident' && ['temporary', 'busy'].includes(error.kind) && item?.nativeOnline
        && !item.disposed && !item.exited && !item.identityChanged && !cancelled() && this.accountSessions.get(key) === item) completed = true;
      diagnostic(error.kind || 'temporary');
      throw error;
    } finally {
      if (!completed) {
        if (item) this.dispose(item); else proxyBridge?.close();
      }
    }
  }

  close() {
    this.closed = true; clearInterval(this.timer);
    if (this.warm) this.dispose(this.warm);
    for (const item of this.trackedItems) this.dispose(item);
  }
}

let sharedService;
function getQqLoginService() { return sharedService ||= new QqLoginService(); }
module.exports = { QqLoginService, QqScanError, nativeLaunch, helperEnvironment, validCode, getQqLoginService };
