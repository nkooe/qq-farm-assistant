// Isolated login only: no scene, bot tasks, mailbox, or account writes.
const { parentPort, workerData } = require('node:worker_threads');
process.stdout.write = () => true;
process.stderr.write = () => true;
const { CONFIG, updateRuntimeConfig } = require('../src/config/config');
const { loadProto } = require('../src/utils/proto');
const { connect, stopNetwork, networkEvents } = require('../src/utils/network');
CONFIG.platform = 'qq';
updateRuntimeConfig({ ...workerData.runtimeConfig, platform: 'qq' });
if (workerData.deviceProtocol) require('../src/models/store').setDeviceProtocol(workerData.deviceProtocol);
let finished = false;
function finish(value) {
  if (finished) return;
  finished = true;
  stopNetwork('身份核验结束');
  parentPort.postMessage(value);
}
networkEvents.on('reconnect_failed', () => finish({ error: '农场身份核验失败，请重新扫码' }));
void loadProto().then(() => connect(workerData.code, identity => finish({ identity }), {
  identityOnly: true, proxyURL: workerData.proxyURL,
})).catch(() => finish({ error: '农场身份核验失败，请重新扫码' }));
