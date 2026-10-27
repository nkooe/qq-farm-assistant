const utils = require('../../utils/utils');
module.exports = {
  ...utils,
  getSystemDateKey: () => new Date((utils.getServerTimeSec() + 28800) * 1000).toISOString().slice(0, 10),
};
