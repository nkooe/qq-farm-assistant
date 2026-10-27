const { createScheduler } = require('./scheduler');

// One worker owns one account. Timers never depend on an open browser page.
function createMilkTeaAutomation({ scheduler, getEnabled, execute, now = Date.now, onResult = () => {}, onError = () => {} }) {
  let generation = 0;
  let started = false;
  let running = false;
  let ready = () => false;
  let paused = () => false;
  let state = { status: 'paused', message: '等待账号连接', lastRunAt: 0, nextRunAt: 0, completed: [] };
  const allowed = token => started && token === generation && getEnabled() && ready() && !paused();
  function schedule(delay) {
    if (!started || !getEnabled()) return;
    state.nextRunAt = now() + delay;
    scheduler.setTimeoutTask('check', delay, tick);
  }
  async function tick() {
    const token = generation;
    if (!allowed(token) || running) {
      schedule(60000);
      return;
    }
    running = true;
    state = { ...state, status: 'running', message: '正在检查可领取收益', completed: [], nextRunAt: 0 };
    let delay = 300000;
    try {
      const result = await execute(() => allowed(token));
      if (token !== generation) return;
      state = { ...state, ...result, lastRunAt: now() };
      // Closed / unopened activities need fewer requests.
      if (['inactive', 'unopened'].includes(result.status)) delay = 1800000;
      if (result.completed?.length) onResult(result);
    } catch (error) {
      if (token === generation) {
        const completed = Array.isArray(error.completed) ? error.completed : [];
        state = { ...state, status: 'error', completed, message: `${completed.length ? `已领取${completed.join('、')}；` : ''}检查未完成，稍后重新读取进度再处理`, lastRunAt: now() };
        onError(state);
      }
    } finally {
      running = false;
      if (token === generation) schedule(delay);
    }
  }
  return {
    wake() { if (started && !running) schedule(15000); },
    start(options = {}) {
      generation++;
      scheduler.clear('check');
      ready = options.ready || ready;
      paused = options.paused || paused;
      started = true;
      state = { ...state, status: 'waiting', message: '等待检查', nextRunAt: 0 };
      schedule(15000);
    },
    stop() {
      generation++;
      started = false;
      scheduler.clear('check');
      state = { ...state, status: 'paused', message: '账号已暂停', nextRunAt: 0 };
    },
    snapshot() {
      const enabled = getEnabled();
      if (!enabled) return { ...state, enabled, status: 'disabled', message: '自动领取已关闭', nextRunAt: 0 };
      if (!started || !ready()) return { ...state, enabled, status: 'paused', message: '等待账号连接', nextRunAt: 0 };
      if (paused()) return { ...state, enabled, status: 'paused', message: '账号同步中，暂缓处理' };
      return { ...state, enabled };
    },
  };
}

const automation = createMilkTeaAutomation({
  scheduler: createScheduler('milk-tea'),
  getEnabled: () => !!require('../models/store').getAutomation().milk_tea,
  execute: allowed => require('../modern/services/milk-tea').runMilkTeaAutomation(allowed),
  onResult: result => require('../utils/utils').log('奶茶', result.message, { module: 'activity', event: '奶茶自动领取', result: 'ok', count: result.completed.length }),
  onError: result => require('../utils/utils').log('奶茶', result.message, { module: 'activity', event: '奶茶自动领取', result: 'error', count: result.completed.length }),
});
module.exports = { createMilkTeaAutomation, automation };
