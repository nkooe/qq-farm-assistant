const { createScheduler } = require('./scheduler');
const { createActivityAutomation } = require('./activity-automation');
const { runExclusiveAutomationTask } = require('./automation-lock');
const automation = createActivityAutomation({
  scheduler: createScheduler('muge'),
  runningMessage: '自动领奖中',
  execute: (allowed, onStarted) => runExclusiveAutomationTask('muge_rewards',
    () => onStarted() ? require('../modern/services/muge-activity').runMugeAutomation(allowed)
      : { status: 'paused', message: '账号已暂停', completed: [] }, { detached: true }),
  onResult: result => require('../utils/utils').log('牧歌', result.message, {
    module: 'activity', event: '牧歌自动领奖', result: 'ok', count: result.completed.length,
  }),
  onError: result => require('../utils/utils').log('牧歌', result.message, {
    module: 'activity', event: '牧歌自动领奖', result: 'error', count: result.completed.length,
  }),
});
module.exports = { automation };
