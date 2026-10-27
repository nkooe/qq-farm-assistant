function createReloginReminderService(deps) {
  const {
    store,
    sendPushooMessage,
    sendSmtpEmail,
    log,
    getAccounts,
  } = deps;

  function getOfflineAutoDeleteMs(username = '') {
    const cfg = store.getOfflineReminder ? store.getOfflineReminder(username) : null;
    const seconds = Math.max(0, Number.parseInt(cfg && cfg.offlineDeleteSec, 10) || 0);
    return seconds === 0 ? Infinity : seconds * 1000;
  }

  function findAccount(accountId) {
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    return accounts.find(acc => String(acc.id) === String(accountId));
  }

  function resolveUsername(accountId, fallback = '') {
    if (fallback) return String(fallback).trim();
    try {
      const account = findAccount(accountId);
      return account && account.username ? String(account.username).trim() : '';
    } catch (err) {
      log('错误', `查找账号用户名失败: ${  err.message}`);
      return '';
    }
  }

  async function sendSmtpReminder(cfg, accountId, accountName, reason, offlineMs) {
    const smtpHost = String(cfg.smtpHost || '').trim();
    const smtpPort = Number(cfg.smtpPort) || 465;
    const smtpUser = String(cfg.smtpUser || '').trim();
    const smtpPass = String(cfg.smtpPass || '').trim();
    const senderName = String(cfg.senderName || '').trim();
    const recipientEmail = String(cfg.recipientEmail || '').trim();
    const emailContent = String(cfg.emailContent || cfg.msg || '').trim();

    if (!smtpHost || !smtpUser || !smtpPass || !recipientEmail) {
      log('系统',
        `下线提醒SMTP配置不完整: ` +
        `host=${  smtpHost ? '已设置' : '未设置'
        }, user=${  smtpUser ? '已设置' : '未设置'
        }, pass=${  smtpPass ? '已设置' : '未设置'
        }, recipient=${  recipientEmail ? '已设置' : '未设置'}`);
      return { ok: false, status: 'unconfigured' };
    }

    const minutes = Math.floor((Number(offlineMs) || 0) / 60000);
    const title = String(cfg.title || '账号下线提醒').trim();
    let content = accountName ? `${accountName  }\n${  emailContent}` : emailContent;
    if (reason) content += `\n原因: ${  reason}`;
    if (minutes > 0) content += `\n离线时长: ${  minutes  } 分钟`;

    const ret = await sendSmtpEmail({
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      senderName,
      recipientEmail,
      subject: accountName ? `${title  } ${  accountName}` : title,
      content,
    });
    if (ret && ret.ok) log('系统', `下线提醒邮件发送成功: ${  accountName || accountId}`);
    else log('错误', `下线提醒邮件发送失败: ${  ret && ret.msg ? ret.msg : 'unknown'}`);
    return { ok: !!ret?.ok, status: ret?.ok ? 'sent' : 'failed' };
  }

  async function sendPushooReminder(cfg, accountId, accountName, reason, offlineMs) {
    const channel = String(cfg.channel || '').trim().toLowerCase();
    const endpoint = String(cfg.endpoint || '').trim();
    const token = String(cfg.token || '').trim();
    const baseTitle = String(cfg.title || '账号下线提醒').trim();
    const title = accountName ? `${baseTitle  } ${  accountName}` : baseTitle;
    let content = String(cfg.msg || '账号下线').trim();

    if (!channel || !title || !content) {
      log('错误', `下线提醒配置不完整: channel=${  channel  }, title=${  title  }, content=${  content}`);
      return { ok: false, status: 'unconfigured' };
    }
    if (channel !== 'webhook' && !token) {
      log('错误', '下线提醒配置不完整: token=未设置');
      return { ok: false, status: 'unconfigured' };
    }
    if (channel === 'webhook' && !endpoint) {
      log('错误', 'Webhook 渠道未设置接口地址');
      return { ok: false, status: 'unconfigured' };
    }

    const minutes = Math.floor((Number(offlineMs) || 0) / 60000);
    if (reason) content += `\n原因: ${  reason}`;
    if (minutes > 0) content += `\n离线时长: ${  minutes  } 分钟`;

    const ret = await sendPushooMessage({ channel, endpoint, token, title, content });
    if (ret && ret.ok) log('系统', `下线提醒发送成功: ${  accountName || accountId}`);
    else log('错误', `下线提醒发送失败: ${  ret && ret.msg ? ret.msg : 'unknown'}`);
    return { ok: !!ret?.ok, status: ret?.ok ? 'sent' : 'failed' };
  }

  async function triggerOfflineReminder(params = {}) {
    try {
      const accountId = String(params.accountId || '').trim();
      const accountName = String(params.accountName || '').trim();
      const reason = String(params.reason || 'unknown');
      const offlineMs = Number(params.offlineMs) || 0;
      const username = resolveUsername(accountId, params.username);

      log('系统',
        `触发下线提醒: 账号=${  accountName || accountId  }, 原因=${  reason}`,
        { accountId, accountName, reason, username });

      const cfg = store.getOfflineReminder ? store.getOfflineReminder(username) : null;
      if (cfg?.enabled === false) return { ok: false, status: 'disabled' };
      if (!cfg) {
        log('错误', `未找到下线提醒配置: 用户=${  username || '(空)'}`);
        return { ok: false, status: 'unconfigured' };
      }

      const channel = String(cfg.channel || 'smtp').trim().toLowerCase();
      log('系统', `下线提醒配置: 渠道=${  channel  }, 标题=${  cfg.title || '账号下线提醒'}`, {
        channel,
        username,
      });

      if (channel === 'smtp') {
        return await sendSmtpReminder(cfg, accountId, accountName, reason, offlineMs);
      } else {
        return await sendPushooReminder(cfg, accountId, accountName, reason, offlineMs);
      }
    } catch (err) {
      log('错误', `下线提醒发送异常: ${  err.message}`);
      return { ok: false, status: 'failed' };
    }
  }

  return {
    getOfflineAutoDeleteMs,
    triggerOfflineReminder,
  };
}

module.exports = { createReloginReminderService };
