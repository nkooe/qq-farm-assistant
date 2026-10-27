const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');

function sanitizeRefreshText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|wxid|code)\s*[=:]\s*)[^&\s,;]+/gi, '$1[已隐藏]');
}

// Persist progress only: never serialize account objects, Code, tokens or wxid.
function snapshot(job) {
  const account = value => value ? { id: String(value.id), name: String(value.name || value.id) } : null;
  return {
    id: job.id, username: job.username, requestKey: job.requestKey,
    state: job.state, total: job.total, completed: job.completed,
    success: job.success, failed: job.failed, skipped: job.skipped,
    targets: (job.targets || []).map(account),
    currentAccount: account(job.currentAccount), uncertainAccount: account(job.uncertainAccount),
    results: job.results.map(result => ({
      accountId: String(result.accountId), name: String(result.name), ok: result.ok === true,
      source: result.source || '', error: sanitizeRefreshText(result.error),
    })),
    error: sanitizeRefreshText(job.error), createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

function createRefreshJobStore({ filePath = getDataFile('refresh-code-jobs.json') } = {}) {
  return {
    load() {
      if (!filePath || !fs.existsSync(filePath)) return [];
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error('刷新任务文件格式无效');
      return data.jobs.map((raw) => {
        if (!raw.id || typeof raw.username !== 'string' || !Array.isArray(raw.targets)
          || !Array.isArray(raw.results) || !['queued', 'running', 'completed', 'failed', 'interrupted'].includes(raw.state)) {
          throw new Error('刷新任务记录无效');
        }
        const job = snapshot(raw);
        if (job.state === 'queued' || job.state === 'running') {
          job.state = 'interrupted';
          job.uncertainAccount = job.currentAccount;
          job.currentAccount = null;
          job.error = job.uncertainAccount
            ? `服务重启，${job.uncertainAccount.name} 的刷新结果未确认；请先核对该账号状态。其余失败或未执行账号可单独重试。`
            : '服务重启，任务已中断；可重试失败或未执行账号。';
          job.updatedAt = Date.now();
        }
        return job;
      });
    },
    save(jobs) {
      if (!filePath) return;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryFile = `${filePath}.${process.pid}.tmp`;
      try {
        const descriptor = fs.openSync(temporaryFile, 'w', 0o600);
        try {
          fs.writeFileSync(descriptor, JSON.stringify({ version: 1, jobs: jobs.map(snapshot) }), 'utf8');
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        fs.renameSync(temporaryFile, filePath);
      } finally {
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      }
    },
  };
}

module.exports = { createRefreshJobStore, sanitizeRefreshText };
