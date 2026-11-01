const { createScheduler } = require('./scheduler');

// One worker owns one account. Timers never depend on an open browser page.
function createMilkTeaAutomation({ scheduler, execute, now = Date.now, onResult = () => {}, onError = () => {} }) {
  let generation = 0;
  let started = false;
  let running = false;
  let ready = () => false;
  let paused = () => false;
  let state = { status: 'paused', message: '等待账号连接', lastRunAt: 0, nextRunAt: 0, completed: [] };
  const allowed = token => started && token === generation && ready() && !paused();
  function schedule(delay) {
    if (!started) return;
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
    state = { ...state, status: 'running', message: '自动经营中', completed: [], nextRunAt: 0 };
    let delay = 300000;
    try {
      const result = await execute(() => allowed(token));
      if (token !== generation) return;
      state = { ...state, ...result, lastRunAt: now() };
      // Closed / unopened activities need fewer requests.
      if (result.status === 'inactive') delay = 1800000;
      if (result.status === 'error') onError(result);
      else if (result.completed?.length) onResult(result);
    } catch (error) {
      if (token === generation) {
        const completed = Array.isArray(error.completed) ? error.completed : [];
        state = { ...state, status: 'error', completed, message: `${completed.length ? `已完成${completed.join('、')}；` : ''}稍后重试`, lastRunAt: now() };
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
      if (!started || !ready()) return { ...state, status: 'paused', message: '等待账号连接', nextRunAt: 0 };
      if (paused()) return { ...state, status: 'paused', message: '账号同步中' };
      return { ...state };
    },
  };
}

const automation = createMilkTeaAutomation({
  scheduler: createScheduler('milk-tea'),
  execute: allowed => require('../modern/services/milk-tea').runMilkTeaAutomation(allowed),
  onResult: result => require('../utils/utils').log('奶茶', result.message, { module: 'activity', event: '奶茶自动经营', result: 'ok', count: result.completed.length }),
  onError: result => require('../utils/utils').log('奶茶', result.message, { module: 'activity', event: '奶茶自动经营', result: 'error', count: result.completed.length }),
});
module.exports = { createMilkTeaAutomation, automation };
