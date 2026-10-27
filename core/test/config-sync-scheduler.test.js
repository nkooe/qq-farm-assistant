/**
 * 单元测试：config-sync-scheduler（官方配置自动同步调度器）
 *
 * 覆盖：
 * - start/stop 生命周期（幂等、定时器清理）
 * - runOnce 并发保护（busy 跳过）
 * - runOnce 结果分类日志（upToDate / 同步成功 / 无缓存 / 异常）
 *
 * 测试通过 mock scripts/sync-game-config.js 的 autoSync 注入各类结果，
 * 不实际联网。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-config-scheduler-'));
process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const SCHED_PATH = path.join(__dirname, '..', 'src', 'services', 'config-sync-scheduler.js');
const TOOL_PATH = path.join(__dirname, '..', '..', 'scripts', 'sync-game-config.js');

/** 临时替换 require 缓存中的 sync 工具，跑完恢复 */
async function withMockedTool(mock, fn) {
  const original = require.cache[require.resolve(TOOL_PATH)];
  require.cache[require.resolve(TOOL_PATH)] = {
    id: TOOL_PATH,
    filename: TOOL_PATH,
    loaded: true,
    exports: mock,
  };
  // 重新加载调度器以使用新缓存
  delete require.cache[require.resolve(SCHED_PATH)];
  try {
    return await fn(require(SCHED_PATH));
  } finally {
    require(SCHED_PATH).stop();
    if (original) require.cache[require.resolve(TOOL_PATH)] = original;
    else delete require.cache[require.resolve(TOOL_PATH)];
    delete require.cache[require.resolve(SCHED_PATH)];
  }
}

test('runOnce: upToDate 结果（版本未变）', async () => {
  const calls = [];
  await withMockedTool({
    autoSync: async () => { calls.push('autoSync'); return { ok: true, upToDate: true, bundleVers: { mainscene: 'x' } }; },
  }, async (sched) => {
    const r = await sched.runOnce();
    assert.strictEqual(r.upToDate, true);
    assert.strictEqual(calls.length, 1);
    assert.ok(r.at, '结果应带时间戳');
  });
});

test('runOnce: 检测到更新并同步成功', async () => {
  await withMockedTool({
    autoSync: async () => ({
      ok: true,
      upToDate: false,
      rcSync: 0,
      rcIcons: 0,
      bundleVers: { mainscene: 'new123' },
    }),
  }, async (sched) => {
    const r = await sched.runOnce();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.upToDate, false);
    assert.strictEqual(r.bundleVers.mainscene, 'new123');
    assert.strictEqual(r.reloaded, true);
  });
});

test('runOnce: 无游戏缓存时静默跳过（ok=false, reason=no-game-cache）', async () => {
  await withMockedTool({
    autoSync: async () => ({ ok: false, reason: 'no-game-cache' }),
  }, async (sched) => {
    const r = await sched.runOnce();
    assert.strictEqual(r.reason, 'no-game-cache');
  });
});

test('runOnce: autoSync 抛异常时被捕获，返回 ok=false', async () => {
  await withMockedTool({
    autoSync: async () => { throw new Error('网络不可达'); },
  }, async (sched) => {
    const r = await sched.runOnce();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /网络不可达/);
  });
});

test('runOnce: 并发保护（上一轮未结束则跳过）', async () => {
  const resolvers = [];
  let started = 0;
  await withMockedTool({
    autoSync: () => {
      started++;
      return new Promise((resolve) => { resolvers.push(resolve); });
    },
  }, async (sched) => {
    const p1 = sched.runOnce();       // 第一轮：挂起
    const p2 = await sched.runOnce(); // 第二轮：应被跳过
    assert.strictEqual(p2.skipped, 'busy', '并发时应返回 busy');
    assert.strictEqual(started, 1, 'autoSync 只应被调用一次');
    resolvers[0]({ ok: true, upToDate: true });
    await p1;
  });
});

test('start/stop: 生命周期幂等，stop 后清理定时器', async () => {
  await withMockedTool({
    autoSync: async () => ({ ok: true, upToDate: true }),
  }, async (sched) => {
    // 用大延迟避免测试期间真的触发
    sched.start({ startupDelayMs: 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 });
    sched.start({ startupDelayMs: 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 }); // 幂等
    sched.stop();
    sched.stop(); // 幂等
    assert.ok(true, '重复 start/stop 不应抛异常');
  });
});

test('getLastResult: 初次为空，runOnce 后有值', async () => {
  await withMockedTool({
    autoSync: async () => ({ ok: true, upToDate: true, bundleVers: { plant: 'p1' } }),
  }, async (sched) => {
    assert.strictEqual(sched.getLastResult(), null);
    await sched.runOnce();
    const last = sched.getLastResult();
    assert.ok(last);
    assert.strictEqual(last.bundleVers.plant, 'p1');
  });
});

test('stop 取消启动检查，停止期间完成的同步不再广播', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  let notifyCount = 0;
  let resolveSync;
  await withMockedTool({ autoSync: () => { calls++; return new Promise(resolve => { resolveSync = resolve; }); } }, async sched => {
    sched.start({ startupDelayMs: 10, intervalMs: 1000, onSynced: () => notifyCount++ });
    sched.stop();
    t.mock.timers.tick(10);
    assert.equal(calls, 0);
    sched.start({ startupDelayMs: 10, intervalMs: 1000, onSynced: () => notifyCount++ });
    t.mock.timers.tick(10);
    assert.equal(calls, 1);
    sched.stop();
    resolveSync({ ok: true, upToDate: false });
    await new Promise(setImmediate);
    assert.equal(notifyCount, 0);
  });
});

test('只有同步及双字典加载成功才广播，失败/无缓存/无更新/并发跳过均不广播', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const response of [{ ok: false }, { ok: false, reason: 'no-game-cache' }, { ok: true, upToDate: true }, { ok: true, skipped: 'busy', upToDate: true }, { ok: true, upToDate: false }]) {
    let notices = 0;
    await withMockedTool({ autoSync: async () => response }, async sched => {
      sched.start({ startupDelayMs: 10, intervalMs: 1000, onSynced: () => notices++ });
      t.mock.timers.tick(10);
      await new Promise(setImmediate);
      assert.equal(notices, response.ok && !response.upToDate ? 1 : 0);
    });
  }
});

test('热加载失败有明确状态；版本未变的后续巡检仍会重试刷新', async t => {
  const config = require('../src/config/gameConfig');
  const mock = t.mock.method(config, 'loadConfigs', () => false);
  let first = true;
  await withMockedTool({ autoSync: async () => {
    const response = { ok: true, upToDate: !first };
    first = false;
    return response;
  } }, async sched => {
    const failed = await sched.runOnce();
    assert.equal(failed.reloaded, false);
    assert.ok(failed.reloadErrors.length);
    mock.mock.restore();
    const retried = await sched.runOnce();
    assert.equal(retried.upToDate, true);
    assert.equal(retried.reloaded, true);
  });
});

test('字典重载失败时不触发 onSynced', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const reload = require('../src/config/reload-game-config');
  t.mock.method(reload, 'reloadGameConfig', () => ({ ok: false, errors: ['test reload failed'] }));
  let notices = 0;
  await withMockedTool({ autoSync: async () => ({ ok: true, upToDate: false }) }, async sched => {
    sched.start({ startupDelayMs: 10, intervalMs: 1000, onSynced: () => notices++ });
    t.mock.timers.tick(10);
    await new Promise(setImmediate);
    assert.equal(notices, 0);
    assert.equal(sched.getLastResult().reloaded, false);
  });
});

test('图标失败不广播成功，后续版本未变仍刷新已写入的数据表', async () => {
  let first = true;
  await withMockedTool({ autoSync: async () => {
    const response = first ? { ok: false, rcSync: 0, rcIcons: 1 } : { ok: true, upToDate: true };
    first = false;
    return response;
  } }, async sched => {
    assert.equal((await sched.runOnce()).reloaded, false);
    assert.equal((await sched.runOnce()).reloaded, true);
  });
});
