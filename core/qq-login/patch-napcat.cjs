// Apply only to the pinned 4.18.41 program copy, never to a user's QQ profile.
function patchHost(text) {
  function replace(old, value) {
    if (text.split(old).length !== 2) throw new Error(`Unrecognized NapCat build at: ${  old.slice(0,70)}`);
    text = text.replace(old, value);
  }
  if (!text.includes('process.env.NAPCAT_TEST_QQ_DATA')) {
    replace('function YAe(t) {', `function YAe(t) {
  if (process.env.NAPCAT_TEST_QQ_DATA) {
    const isolated = xe.resolve(process.env.NAPCAT_TEST_QQ_DATA);
    const global = Sn.platform() === "linux" ? xe.join(isolated, "global") : xe.join(isolated, "nt_qq", "global");
    fe.mkdirSync(global, {recursive: true});
    return [isolated, global];
  }`);
  }
  replace('await r.init(n.getFullQQVersion(), s.o3HookMode === 1);', '/* Packet hooks disabled. */');
  replace('S0e(e, t, l5, zAe).then().catch((W) => e.logError(W));', 'Promise.resolve(); /* WebUI disabled. */');
  replace('async function e2e(t, e, n, r, i) {', 'async function e2e(t, e, n, r, i) {\n globalThis.__qqFarmLogin.setLogin(t);');
  replace('c.onQRCodeGetPicture = ({ pngBase64QrcodeData: u, qrcodeUrl: l }) => {', `c.onQRCodeGetPicture = (event) => {
    globalThis.__qqFarmLogin.qr(event);
    return; // QR and credentials are delivered over the parent pipe only.
    const {pngBase64QrcodeData: u, qrcodeUrl: l} = event;`);
  for (const [key, call] of [
    ['c.onQRCodeSessionUserScaned = () => {', 'globalThis.__qqFarmLogin.phase("scanned");'],
    ['c.onQRCodeLoginSucceed = async (u) => {', 'globalThis.__qqFarmLogin.phase("initializing");'],
    ['c.onQRCodeSessionFailed = (u, l) => {', 'globalThis.__qqFarmLogin.loginFailed(u, l);'],
    ['c.onLoginFailed = (...u) => {', 'globalThis.__qqFarmLogin.phase("login_failed");'],
    ['c.onLoginDisConnected = () => {', 'globalThis.__qqFarmLogin.phase("offline");'],
    ['c.onLogoutSucceed = () => {', 'globalThis.__qqFarmLogin.phase("offline");'],
  ]) replace(key, `${key  }\n ${  call}`);
  replace('await n2e(d, U, f);', 'await n2e(d, U, f);\n await globalThis.__qqFarmLogin.ready(d, S); return;');
  replace('setFileLogEnabled(e) {', 'setFileLogEnabled(e) { e = false;');
  replace('setConsoleLogEnabled(e) {', 'setConsoleLogEnabled(e) { e = false;');
  return text;
}
module.exports = { patchHost };
if (require.main === module) {
  const fs = require('node:fs');
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node patch-napcat.cjs source.mjs destination.mjs');
  fs.writeFileSync(destination, patchHost(fs.readFileSync(source,'utf8')));
}
