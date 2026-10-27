const network = require('../../utils/network');
// Existing workers own the connection; feature modules never open another login session.
network.networkEvents.on('disconnect', (...args) => network.networkEvents.emit('disconnected', ...args));
module.exports = {
  ...network,
};
