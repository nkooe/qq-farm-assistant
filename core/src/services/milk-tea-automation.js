const { createScheduler } = require('./scheduler');

const { createActivityAutomation } = require('./activity-automation');
const createMilkTeaAutomation = options => createActivityAutomation({ ...options, runningMessage: '自动经营中' });

const automation = createMilkTeaAutomation({
  scheduler: createScheduler('milk-tea'),
  execute: (allowed, onStarted) => require('./automation-lock').runExclusiveAutomationTask('milk_tea',
    () => onStarted() ? require('../modern/services/milk-tea').runMilkTeaAutomation(allowed)
      : { status: 'paused', message: '账号已暂停', completed: [] }, { detached: true }),
  onResult: result => require('../utils/utils').log('奶茶', result.message, { module: 'activity', event: '奶茶自动经营', result: 'ok', count: result.completed.length }),
  onError: result => require('../utils/utils').log('奶茶', result.message, { module: 'activity', event: '奶茶自动经营', result: 'error', count: result.completed.length }),
});
module.exports = { createMilkTeaAutomation, automation };
