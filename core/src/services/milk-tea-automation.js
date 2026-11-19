const { createScheduler } = require('./scheduler');

const { createActivityAutomation } = require('./activity-automation');
const createMilkTeaAutomation = options => createActivityAutomation({ ...options, runningMessage: '自动经营中' });

const automation = createMilkTeaAutomation({
  scheduler: createScheduler('milk-tea'),
  execute: allowed => require('./automation-lock').runExclusiveAutomationTask('milk_tea', () => allowed() && require('../modern/services/milk-tea').runMilkTeaAutomation(allowed), { detached: true }),
  onResult: result => require('../utils/utils').log('奶茶', result.message, { module: 'activity', event: '奶茶自动经营', result: 'ok', count: result.completed.length }),
  onError: result => require('../utils/utils').log('奶茶', result.message, { module: 'activity', event: '奶茶自动经营', result: 'error', count: result.completed.length }),
});
module.exports = { createMilkTeaAutomation, automation };
