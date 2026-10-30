const { createRefreshJobStore, sanitizeRefreshText } = require('../models/refresh-job-store');
const editableAccountFields = new Set([
  'id', 'name', 'code', 'platform', 'loginType', 'provider', 'thirdparty',
  'wxid', 'uin', 'qq', 'yybOpenid', 'proxyMode', 'proxyProfileId',
  'qqAutoReconnect', 'autoStart', 'userId',
]);

function createLogQuery(query) {
  return {
    limit: Number.parseInt(query.limit) || 100,
    tag: query.tag || "",
    module: query.module || "",
    event: query.event || "",
    keyword: query.keyword || "",
    isWarn: query.isWarn,
    timeFrom: query.timeFrom || "",
    timeTo: query.timeTo || "",
  };
}

function isAdminUser(user) {
  return user && user.role === "admin";
}

function hasWxRefreshIdentity(account) {
  if (!account) return false;
  const hasYybIdentity = account.loginType === "yyb"
    && !!String(account.yybOpenid || "").trim();
  if (account.platform === 'qq' && !hasYybIdentity) return false;
  return hasYybIdentity || !!String(account.wxid || "").trim();
}

function publicAccountData(data, user) {
  if (!data || !Array.isArray(data.accounts)) return data;
  return { accounts: data.accounts.filter(account => user?.role === 'admin' || (user?.id && account.userId === user.id)).map(account => {
    const row = { ...account, qqAutoCodeAvailable: !!account.qqLoginProfile };
    delete row.qqLoginProfile;
    if (row.thirdparty?.apiToken) row.thirdparty = { ...row.thirdparty, apiToken: '***' };
    return row;
  }) };
}

function registerAdminAccountRoutes({
  app,
  provider,
  broadcastLogSnapshot,
  addOrUpdateAccount,
  findAccountByRef,
  getAccountsForUser,
  getAccountIdFromRequest,
  resolveAccountReference,
  canAccessAccount,
  getAccessibleAccountIdsFromRequest,
  userStore,
  sendProviderError,
  refreshJobStore = createRefreshJobStore(),
}) {
  const refreshJobs = new Map();
  const refreshJobsByRequest = new Map();
  const activeRefreshJobByUser = new Map();
  const refreshJobRetentionMs = 24 * 60 * 60 * 1000;
  const maxRefreshJobs = 100;
  for (const job of refreshJobStore.load()) {
    refreshJobs.set(job.id, job);
    if (job.requestKey) refreshJobsByRequest.set(job.requestKey, job.id);
  }
  persistRefreshJobs();

  function persistRefreshJobs() {
    refreshJobStore.save([...refreshJobs.values()]);
  }

  function removeRefreshJob(job) {
    refreshJobs.delete(job.id);
    if (job.requestKey) refreshJobsByRequest.delete(job.requestKey);
    if (activeRefreshJobByUser.get(job.userId) === job.id) {
      activeRefreshJobByUser.delete(job.userId);
    }
  }

  function cleanupRefreshJobs(reserveSlot = false) {
    const now = Date.now();
    const previousSize = refreshJobs.size;
    for (const job of refreshJobs.values()) {
      if (job.state !== "queued" && job.state !== "running" && now - job.updatedAt > refreshJobRetentionMs) {
        removeRefreshJob(job);
      }
    }
    if (reserveSlot && refreshJobs.size >= maxRefreshJobs) {
      for (const job of refreshJobs.values()) {
        if (job.state !== "queued" && job.state !== "running") removeRefreshJob(job);
        if (refreshJobs.size < maxRefreshJobs) break;
      }
    }
    if (refreshJobs.size !== previousSize) persistRefreshJobs();
  }

  function retryableAccounts(job) {
    const successful = new Set(job.results.filter(result => result.ok).map(result => result.accountId));
    return (job.targets || []).filter(account => !successful.has(account.id)
      && account.id !== job.uncertainAccount?.id);
  }

  function refreshJobSnapshot(job) {
    return {
      jobId: job.id,
      state: job.state,
      total: job.total,
      completed: job.completed,
      success: job.success,
      failed: job.failed,
      skipped: job.skipped,
      currentAccount: job.currentAccount,
      results: job.results.map(result => ({ ...result, error: sanitizeRefreshText(result.error) })),
      error: sanitizeRefreshText(job.error),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      uncertainAccount: job.uncertainAccount || null,
      retryableAccountIds: retryableAccounts(job).map(account => account.id),
    };
  }

  async function runRefreshJob(job, targetAccounts) {
    job.state = "running";
    job.updatedAt = Date.now();
    persistRefreshJobs();
    for (const account of targetAccounts) {
      if (job.cancelled) return;
      const name = account.name || account.nick || account.id;
      job.currentAccount = { id: String(account.id), name };
      job.updatedAt = Date.now();
      // Save the intent before changing credentials. A restart must not replay it blindly.
      persistRefreshJobs();
      let result;
      try {
        result = await provider.refreshAccountCode(account.id);
      } catch (error) {
        result = { ok: false, error: sanitizeRefreshText(error && error.message ? error.message : "刷新失败") };
      }

      if (job.cancelled) return;
      const ok = result?.ok === true;
      job.results.push({
        accountId: String(account.id),
        name,
        ok,
        source: result && result.source ? result.source : "",
        error: ok ? "" : sanitizeRefreshText((result && result.error) || "刷新失败"),
      });
      job.completed += 1;
      if (ok) job.success += 1;
      else job.failed += 1;
      job.updatedAt = Date.now();
      job.currentAccount = null;
      persistRefreshJobs();
    }
    job.currentAccount = null;
    job.state = "completed";
    job.updatedAt = Date.now();
    persistRefreshJobs();
  }

  function enqueueRefreshJob(job, targetAccounts) {
    job.operation = new Promise(resolve => setImmediate(resolve)).then(() => {
      if (job.cancelled) return;
      return runRefreshJob(job, targetAccounts);
    }).catch(error => {
      if (job.cancelled) return;
      job.currentAccount = null;
      job.state = 'failed';
      job.error = sanitizeRefreshText(error.message);
      job.updatedAt = Date.now();
      persistRefreshJobs();
    });
  }

  app.get("/api/accounts", (req, res) => {
    try {
      const currentUser = req.currentUser;
      let data;
      if (currentUser) {
        const accounts = provider.getAccounts();
        data =
          currentUser.role === "admin"
            ? accounts
            : {
                ...accounts,
                accounts: accounts.accounts.filter(
                  (account) => account.userId === currentUser.id,
                ),
              };
      } else {
        data = { accounts: [], nextId: 1 };
      }
      // Native profile references and third-party credentials stay server-side.
      res.json({ ok: true, data: publicAccountData(data, currentUser) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/refresh-wx-codes", (req, res) => {
    try {
      const currentUser = req.currentUser;
      if (!currentUser) {
        return res.status(401).json({ ok: false, error: "未登录" });
      }
      if (!provider || typeof provider.refreshAccountCode !== "function") {
        return res.status(500).json({ ok: false, error: "自动刷新服务不可用" });
      }

      cleanupRefreshJobs();
      const userId = currentUser.id;
      const requestId = String((req.body || {}).requestId || '').trim().slice(0, 128);
      const requestKey = requestId ? `${userId}:${requestId}` : '';
      const priorJobId = requestKey ? refreshJobsByRequest.get(requestKey) : '';
      const priorJob = priorJobId ? refreshJobs.get(priorJobId) : null;
      if (priorJob) {
        return res.status(202).json({ ok: true, data: refreshJobSnapshot(priorJob) });
      }
      const activeJob = refreshJobs.get(activeRefreshJobByUser.get(userId));
      if (activeJob && (activeJob.state === 'queued' || activeJob.state === 'running')) {
        return res.status(202).json({ ok: true, data: refreshJobSnapshot(activeJob) });
      }

      const allAccounts = getAccountsForUser();
      const accessibleAccounts = isAdminUser(currentUser)
        ? allAccounts
        : allAccounts.filter(
            (account) => account && account.userId === currentUser.id,
          );
      let selectedAccounts = accessibleAccounts;
      const retryJobId = String(req.body?.retryJobId || '');
      if (retryJobId) {
        const previousJob = refreshJobs.get(retryJobId);
        if (!previousJob || previousJob.userId !== userId) {
          return res.status(404).json({ ok: false, error: '原刷新任务不存在或已过期' });
        }
        const retryIds = new Set(retryableAccounts(previousJob).map(account => account.id));
        selectedAccounts = accessibleAccounts.filter(account => retryIds.has(String(account.id)));
      }
      const targetAccounts = selectedAccounts.filter(hasWxRefreshIdentity);

      if (targetAccounts.length === 0) {
        return res.json({
          ok: false,
          error: retryJobId ? '没有可重试的失败或未执行账号' : '没有可刷新的微信账号',
          data: { total: 0, success: 0, failed: 0, skipped: accessibleAccounts.length },
        });
      }

      // Evict history only for a new job, after checking request-id deduplication.
      cleanupRefreshJobs(true);
      if (refreshJobs.size >= maxRefreshJobs) {
        return res.status(503).json({ ok: false, error: "刷新任务繁忙，请稍后重试" });
      }

      const now = Date.now();
      const job = {
        id: require("node:crypto").randomUUID(),
        requestKey,
        userId,
        state: "queued",
        total: targetAccounts.length,
        completed: 0,
        success: 0,
        failed: 0,
        skipped: selectedAccounts.length - targetAccounts.length,
        targets: targetAccounts.map(account => ({ id: String(account.id), name: account.name || account.nick || String(account.id) })),
        uncertainAccount: null,
        currentAccount: null,
        results: [],
        error: "",
        createdAt: now,
        updatedAt: now,
      };
      refreshJobs.set(job.id, job);
      if (requestKey) refreshJobsByRequest.set(requestKey, job.id);
      activeRefreshJobByUser.set(userId, job.id);
      try {
        persistRefreshJobs();
      } catch (error) {
        removeRefreshJob(job);
        throw error;
      }
      enqueueRefreshJob(job, targetAccounts);
      res.status(202).json({ ok: true, data: refreshJobSnapshot(job) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/accounts/refresh-wx-codes/:jobId", (req, res) => {
    const currentUser = req.currentUser;
    if (!currentUser) return res.status(401).json({ ok: false, error: "未登录" });
    const job = refreshJobs.get(String(req.params && req.params.jobId || ""));
    if (!job || job.userId !== currentUser.id) {
      return res.status(404).json({ ok: false, error: "刷新任务不存在或已过期" });
    }
    res.json({ ok: true, data: refreshJobSnapshot(job) });
  });

  app.post("/api/account/remark", (req, res) => {
    try {
      const currentUser = req.currentUser;
      if (!currentUser) return res.status(401).json({ ok: false, error: "未登录" });
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const accountRef =
        body.id || body.accountId || body.uin || req.headers["x-account-id"];
      const visibleAccounts = currentUser.role === 'admin'
        ? getAccountsForUser()
        : getAccountsForUser(currentUser.id);
      const account = findAccountByRef(visibleAccounts, accountRef);
      if (!account || !account.id) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }
      if (!canAccessAccount(req, String(account.id))) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      const remark = String(
        body.remark !== undefined ? body.remark : body.name || "",
      ).trim();
      if (!remark) {
        return res.status(400).json({ ok: false, error: "Missing remark" });
      }

      const accountId = String(account.id);
      const data = addOrUpdateAccount({ id: accountId, name: remark });
      if (provider && typeof provider.setRuntimeAccountName === "function") {
        provider.setRuntimeAccountName(accountId, remark);
      }
      if (provider && provider.addAccountLog) {
        provider.addAccountLog("update", `更新账号备注: ${  remark}`, accountId, remark);
      }
      res.json({ ok: true, data: publicAccountData(data, currentUser) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts", (req, res) => {
    try {
      const currentUser = req.currentUser;
      const isAdmin = isAdminUser(currentUser);
      if (!currentUser) return res.status(401).json({ ok: false, error: '未登录' });
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ ok: false, error: '账号参数必须是对象' });
      const body = { ...req.body };
      const invalidFields = Object.keys(body).filter(field => !editableAccountFields.has(field));
      if (invalidFields.length) return res.status(400).json({ ok: false, error: '包含禁止修改的账号字段' });
      const isUpdate = !!body.id;
      // An ordinary user must not transfer ownership through an account edit.
      if (Object.hasOwn(body, 'username') || (body.userId !== undefined && body.userId !== currentUser.id)) return res.status(400).json({ ok: false, error: '禁止修改账号归属' });
      delete body.userId;

      if (isUpdate && currentUser && !isAdmin) {
        if (!canAccessAccount(req, resolveAccountReference(body.id))) {
          return res.status(403).json({ ok: false, error: "无权访问此账号" });
        }
      }

      if (!isUpdate && currentUser && !isAdmin) {
        const accountCount = getAccountsForUser(currentUser.id).length;
        const accountLimit =
          currentUser.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2;
        if (accountCount >= accountLimit) {
          return res.status(403).json({
            ok: false,
            error: `账号数量已达上限（${  accountLimit  }个），请购买额度卡密增加额度`,
          });
        }
      }

      const resolvedId = isUpdate ? resolveAccountReference(body.id) : "";
      const nextAccount = isUpdate
        ? { ...body, id: resolvedId || String(body.id) }
        : body;

      // Keep one main-program account per YYB identity and prevent stale clients
      // from replacing the identity of the record currently being edited.
      const nextYybOpenid = String(nextAccount.yybOpenid || "").trim();
      if (nextYybOpenid) {
        const accounts = provider.getAccounts().accounts || [];
        const nextProvider = nextAccount.provider === "thirdparty"
          ? "thirdparty"
          : "builtin";
        const identityOwner = accounts.find((account) => {
          const accountProvider = account.provider === "thirdparty"
            ? "thirdparty"
            : "builtin";
          return account.userId === (isUpdate ? accounts.find(item => item.id === nextAccount.id)?.userId : currentUser.id)
            && accountProvider === nextProvider
            && String(account.yybOpenid || "").trim() === nextYybOpenid;
        });
        if (identityOwner && String(identityOwner.id) !== String(nextAccount.id || "")) {
          return res.status(409).json({
            ok: false,
            error: "该应用宝微信已添加，请直接使用现有账号",
          });
        }
        const existing = isUpdate
          ? accounts.find((account) => String(account.id) === String(nextAccount.id))
          : null;
        if (existing && existing.yybOpenid
          && String(existing.yybOpenid).trim() !== nextYybOpenid) {
          return res.status(409).json({
            ok: false,
            error: "扫码微信与原账号不一致，请添加为新账号；原账号已保留",
          });
        }
      }

      let wasRunning = false;
      if (isUpdate && provider.isAccountRunning) {
        wasRunning = provider.isAccountRunning(nextAccount.id);
      }

      let onlyRenaming = false;
      if (isUpdate) {
        const accounts = provider.getAccounts();
        const existing = accounts.accounts.find(
          (account) => account.id === nextAccount.id,
        );
        if (existing) {
          const keys = Object.keys(nextAccount);
          onlyRenaming =
            keys.length === 2 && keys.includes("id") && keys.includes("name");
        }
      }

      if (!isUpdate && currentUser) nextAccount.userId = currentUser.id;
      const data = addOrUpdateAccount(nextAccount);
      if (provider.addAccountLog) {
        const accountId = isUpdate
          ? String(nextAccount.id)
          : String((data.accounts.at(-1) || {}).id || "");
        const name = nextAccount.name || "";
        provider.addAccountLog(
          isUpdate ? "update" : "add",
          (isUpdate ? "更新账号: " : "添加账号: ") + (name || accountId),
          accountId,
          name,
        );
      }

      if (!isUpdate) {
        const created = data.accounts.at(-1);
        if (created?.autoStart === true) provider.startAccount(created.id);
      } else if (nextAccount.autoStart === false) {
        provider.stopAccount(nextAccount.id);
      } else if (wasRunning && !onlyRenaming) {
        provider.restartAccount(nextAccount.id);
      } else if (nextAccount.autoStart === true) {
        provider.startAccount(nextAccount.id);
      }

      res.json({ ok: true, data: publicAccountData(data, currentUser) });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  // 更新账号 Code 并自动（重）连：被手机顶下线/离线重连时，
  // 更新登录 Code：在线则用新 Code 重启，离线则直接启动。
  app.post("/api/accounts/:id/update-code", (req, res) => {
    try {
      const accountId =
        resolveAccountReference(req.params.id) || String(req.params.id || "");
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }
      const rawCode = String((req.body && req.body.code) || "").trim();
      // 容忍粘贴带 query 的完整 URL：自动抽取 code 参数
      let code = rawCode;
      const codeMatch = rawCode.match(/[?&]code=([^&]+)/i);
      if (codeMatch && codeMatch[1]) {
        try {
          code = decodeURIComponent(codeMatch[1]);
        } catch {
          code = codeMatch[1];
        }
      }
      code = code.trim();
      if (!code) {
        return res.status(400).json({ ok: false, error: "请填写 Code" });
      }

      const accounts = provider.getAccounts();
      const existing = findAccountByRef(accounts.accounts || [], req.params.id);
      if (!existing) {
        return res.status(404).json({ ok: false, error: "账号不存在" });
      }

      const wasRunning = !!provider.isAccountRunning
        && provider.isAccountRunning(accountId);

      const nextAccount = {
        ...existing,
        id: accountId,
        code,
        loginType: existing.loginType || "manual",
      };
      addOrUpdateAccount(nextAccount);

      // 无论在线/离线都让新 code 生效：在线重启（断开旧连接用新 code 连），离线直接启动
      if (wasRunning) {
        provider.restartAccount(accountId, { skipQqRefresh: true });
      } else {
        provider.startAccount(accountId, { skipQqRefresh: true });
      }

      if (provider.addAccountLog) {
        provider.addAccountLog(
          "update_code",
          `更新 Code 并${wasRunning ? "重启" : "启动"}: ${existing.name || accountId}`,
          accountId,
          existing.name || "",
        );
      }

      res.json({ ok: true, restarted: wasRunning });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.delete("/api/accounts/:id", async (req, res) => {
    try {
      const accountId =
        resolveAccountReference(req.params.id) || String(req.params.id || "");
      if (!canAccessAccount(req, accountId)) {
        return res.status(403).json({ ok: false, error: "无权访问此账号" });
      }

      const accounts = provider.getAccounts();
      const account = findAccountByRef(accounts.accounts || [], req.params.id);
      if (!account) return res.status(404).json({ ok: false, error: '账号不存在' });
      if (req.query?.onlyStopped === '1') {
        const runtime = provider.getAccountRuntime?.(accountId);
        const state = runtime?.state || account.runtimeState;
        const refreshing = [...refreshJobs.values()].some(job =>
          ['queued', 'running'].includes(job.state) && job.targets.some(target => target.id === accountId));
        const reconnect = runtime?.reconnect || account.runtimeReconnect;
        const reconnectPending = ['scheduled', 'waiting_credentials'].includes(reconnect?.state);
        if (state !== 'stopped' || runtime?.running || runtime?.connected || account.running || account.connected || refreshing || reconnectPending) {
          return res.status(409).json({ ok: false, error: '账号状态已变化或正在刷新 Code，已跳过清理' });
        }
      }
      const data = await provider.deleteAccount(accountId);
      res.json({ ok: true, data: publicAccountData(data, req.currentUser) });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/account-logs", (req, res) => {
    try {
      const limit = Number.parseInt(req.query.limit) || 100;
      const currentUser = req.currentUser;
      const requestedAccountId = getAccountIdFromRequest(req);
      let logs = provider.getAccountLogs ? provider.getAccountLogs(limit) : [];
      if (!Array.isArray(logs)) logs = [];
      if (requestedAccountId) {
        if (!canAccessAccount(req, requestedAccountId)) {
          return res.status(403).json({ ok: false, error: "无权访问此账号" });
        }
        logs = logs.filter((log) => {
          const accountId = String(log.accountId || log.id || "");
          return accountId === requestedAccountId;
        });
      }
      if (currentUser) {
        const accessibleIds = getAccessibleAccountIdsFromRequest(req);
        logs = logs.filter((log) => {
          const accountId = log.accountId || log.id;
          return accessibleIds.includes(accountId);
        });
      }
      res.json(logs);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/logs", (req, res) => {
    const requestedAccountId = (req.query.accountId || "").toString().trim();
    const accountId = requestedAccountId
      ? requestedAccountId === "all"
        ? ""
        : resolveAccountReference(requestedAccountId)
      : getAccountIdFromRequest(req);
    const currentUser = req.currentUser;
    if (!currentUser) {
      return res.status(401).json({ ok: false, error: "未登录" });
    }
    if (accountId && !canAccessAccount(req, accountId)) {
      return res.status(403).json({ ok: false, error: "无权访问此账号" });
    }

    if (!accountId) {
      const accessibleIds = getAccessibleAccountIdsFromRequest(req);
      const mergedLogs = [];
      const query = createLogQuery(req.query);
      for (const accessibleId of accessibleIds) {
        const logs = provider.getLogs(accessibleId, query);
        if (Array.isArray(logs)) mergedLogs.push(...logs);
      }
      mergedLogs.sort((a, b) => (b.time || 0) - (a.time || 0));
      return res.json({ ok: true, data: mergedLogs.slice(0, query.limit) });
    }

    const query = createLogQuery(req.query);
    const logs = provider.getLogs(accountId, query);
    res.json({ ok: true, data: logs });
  });

  app.delete("/api/logs", (req, res) => {
    const accountId = getAccountIdFromRequest(req);
    if (!accountId) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing x-account-id" });
    }
    if (!canAccessAccount(req, accountId)) {
      return res.status(403).json({ ok: false, error: "无权访问此账号" });
    }

    try {
      const data = provider.clearLogs(accountId);
      broadcastLogSnapshot(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
  return {
    async cancelUserJobs(userId, accountIds) {
      const ids = new Set(accountIds.map(String));
      const jobs = [...refreshJobs.values()].filter(job => ['queued', 'running'].includes(job.state)
        && (job.userId === userId || job.targets.some(target => ids.has(String(target.id)))));
      for (const job of jobs) job.cancelled = true;
      await Promise.all(jobs.map(job => job.operation));
      for (const job of jobs) {
        job.state = 'interrupted';
        job.uncertainAccount = job.currentAccount;
        job.currentAccount = null;
        job.error = '用户权限已撤销，刷新任务已中断';
        job.updatedAt = Date.now();
        if (activeRefreshJobByUser.get(job.userId) === job.id) activeRefreshJobByUser.delete(job.userId);
      }
      persistRefreshJobs();
    },
    async purgeUserJobs(userId, accountIds) {
      const ids = new Set(accountIds.map(String));
      const jobs = [...refreshJobs.values()].filter(job => job.userId === userId || job.targets.some(target => ids.has(String(target.id))));
      for (const job of jobs) job.cancelled = true;
      await Promise.all(jobs.map(job => job.operation));
      for (const job of jobs) removeRefreshJob(job);
      persistRefreshJobs();
    },
  };

}

module.exports = { registerAdminAccountRoutes };
