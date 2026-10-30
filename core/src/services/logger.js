const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { getProgramRoot } = require('../config/runtime-paths');

const winston = require('winston');

const LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ROTATED_LOG_RE = /^(?:combined|error)(?:-\d{4}-\d{2}-\d{2}-\d{2})?\.log$/;

let logCleanupTimer = null;

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function buildHourlyLogFilename(prefix, date = new Date()) {
  const hour = [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
    padDatePart(date.getHours())
  ].join('-');
  return `${prefix}-${hour}.log`;
}

function cleanupExpiredLogFiles(logDir, now = Date.now()) {
  if (!fs.existsSync(logDir)) return 0;
  const cutoff = now - LOG_RETENTION_MS;
  let removed = 0;
  for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile() || !ROTATED_LOG_RE.test(entry.name)) continue;
    const filePath = path.join(logDir, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        removed += 1;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return removed;
}

function startLogCleanup(logDir) {
  cleanupExpiredLogFiles(logDir);
  if (logCleanupTimer) return;
  logCleanupTimer = setInterval(() => {
    cleanupExpiredLogFiles(logDir);
  }, LOG_CLEANUP_INTERVAL_MS);
  logCleanupTimer.unref?.();
}

// 敏感字段正则：包含 code/token/password 等关键字的键名
const SENSITIVE_KEY_RE = /code|token|password|passwd|auth|ticket|cookie|session/i;

/** 对 URL 查询参数中的敏感值和 Bearer Token 进行脱敏 */
function redactString(raw) {
  let result = String(raw || '');
  // 替换 URL 查询参数中的敏感值 (如 ?code=xxx&token=yyy)
  result = result.replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]');
  // 替换 Bearer Token
  result = result.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
  return result;
}

/**
 * 递归脱敏元数据对象
 * @param {*} meta - 待脱敏对象
 * @param {number} depth - 当前递归深度，超过 4 层返回 [Truncated]
 */
function sanitizeMeta(meta, depth = 0) {
  if (depth > 4) return '[Truncated]';
  if (meta === null || meta === undefined) return meta;
  if (typeof meta === 'string') return redactString(meta);
  if (typeof meta !== 'object') return meta;
  if (Array.isArray(meta)) {
    return meta.map(item => sanitizeMeta(item, depth + 1));
  }
  const result = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEY_RE.test(String(key))) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeMeta(value, depth + 1);
    }
  }
  return result;
}

function resolveLogDir() {
  return process.env.FARM_LOG_DIR
    ? path.resolve(process.env.FARM_LOG_DIR)
    : path.join(getProgramRoot(), 'logs');
}

// ─── Winston Logger ───

let rootLogger = null;
const retiredLogOwners = new Set();
const retiredLogAccounts = new Set();

class HourlyFileTransport extends winston.Transport {
  constructor({ directory, prefix, ...options }) { super(options); this.directory = directory; this.prefix = prefix; }
  log(info, callback) {
    // Close every append before returning, so deletion can rewrite the log
    // atomically on Windows without racing an open rotation stream.
    fs.appendFileSync(path.join(this.directory, buildHourlyLogFilename(this.prefix)), `${info[Symbol.for('message')]}\n`, { mode: 0o600 });
    this.emit('logged', info); callback();
  }
}

function belongsToDeletedUser(value, key = '') {
  if (Array.isArray(value)) return value.some(item => belongsToDeletedUser(item, key));
  if (value && typeof value === 'object') return Object.entries(value).some(([name, item]) => belongsToDeletedUser(item, name));
  if (/^(?:userId|ownerUserId|owner_user_id|user|admin|deletedUsers)$/.test(key)) return retiredLogOwners.has(String(value));
  if (/^(?:accountId|account_id)$/.test(key)) return retiredLogAccounts.has(String(value));
  return false;
}

function writeLog(level, module, message, meta) {
  const entry = { module, message: redactString(message), ...(process.env.FARM_ACCOUNT_ID ? { accountId: process.env.FARM_ACCOUNT_ID } : {}), ...sanitizeMeta(meta) };
  if (belongsToDeletedUser(entry)) return;
  getRootLogger().log(level, entry);
}

async function purgeUserLogs(userId, accountIds) {
  retiredLogOwners.add(String(userId));
  accountIds.forEach(id => retiredLogAccounts.add(String(id)));
  const directory = resolveLogDir();
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !ROTATED_LOG_RE.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const remaining = lines.filter(line => !belongsToDeletedUser(JSON.parse(line)));
    require('./json-db').writeTextFileAtomic(file, remaining.length ? `${remaining.join('\n')}\n` : '');
  }
}

/** 获取/创建根 logger（Winston） */
function getRootLogger() {
  if (rootLogger) return rootLogger;

  const logDir = resolveLogDir();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  startLogCleanup(logDir);

  const level = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  const { combine, timestamp, errors, json, colorize, printf } = winston.format;

  rootLogger = winston.createLogger({
    level,
    defaultMeta: { app: 'qq-farm-bot' },
    transports: [
      // 控制台输出
      new winston.transports.Console({
        format: combine(
          colorize(),
          timestamp(),
          errors({ stack: true }),
          printf(info => {
            const moduleTag = info.module ? `[${info.module}] ` : '';
            const msg = redactString(info.message || '');
            const rest = { ...info };
            delete rest.level;
            delete rest.message;
            delete rest.timestamp;
            delete rest.app;
            delete rest.module;
            const meta = sanitizeMeta(rest);
            const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
            return `${info.timestamp} [${info.level}] ${moduleTag}${msg}${metaStr}`;
          })
        )
      }),
      // 合并日志文件
      new HourlyFileTransport({
        directory: logDir, prefix: 'combined',
        format: combine(timestamp(), errors({ stack: true }), json())
      }),
      // 错误日志文件
      new HourlyFileTransport({
        directory: logDir, prefix: 'error',
        level: 'error',
        format: combine(timestamp(), errors({ stack: true }), json())
      })
    ]
  });
  return rootLogger;
}

/**
 * 创建模块级别的 logger
 * @param {string} name - 模块名称，默认 'app'
 * @returns {{ info, warn, error, debug }} 日志方法
 */
function createModuleLogger(name = 'app') {
  const moduleName = String(name || 'app');
  return {
    info(message, meta = {}) {
      writeLog('info', moduleName, message, meta);
    },
    warn(message, meta = {}) {
      writeLog('warn', moduleName, message, meta);
    },
    error(message, meta = {}) {
      writeLog('error', moduleName, message, meta);
    },
    debug(message, meta = {}) {
      writeLog('debug', moduleName, message, meta);
    }
  };
}

module.exports = {
  createModuleLogger,
  sanitizeMeta,
  redactString,
  buildHourlyLogFilename,
  cleanupExpiredLogFiles,
  resolveLogDir,
  LOG_RETENTION_MS,
  purgeUserLogs
};
