const { CONFIG, DEFAULT_CLIENT_VERSION, DEFAULT_WX_CLIENT_VERSION } = require('../config/config');

function isWechatPlatform(platform = CONFIG.platform) {
    return ['wx', 'wechat'].includes(String(platform || '').trim().toLowerCase());
}

// Capture once per session: later settings broadcasts only affect a new login.
function createClientProfile(deviceProtocol) {
    const wechat = isWechatPlatform();
    const device = deviceProtocol?.enabled ? deviceProtocol : {};
    const clientVersion = String(wechat ? CONFIG.wxClientVersion : CONFIG.clientVersion).trim()
        || (wechat ? DEFAULT_WX_CLIENT_VERSION : DEFAULT_CLIENT_VERSION);
    const deviceInfo = { client_version: clientVersion, sys_software: String(CONFIG.os || 'Windows') };
    if (wechat) {
        if (device.network) deviceInfo.network = String(device.network);
        if (device.deviceId) deviceInfo.device_id = String(device.deviceId);
        const memory = Number(device.memory);
        if (Number.isSafeInteger(memory) && memory > 0) deviceInfo.memory = memory;
    }
    return Object.freeze({
        platform: wechat ? 'wx' : 'qq', clientVersion,
        serverUrl: CONFIG.serverUrl, os: CONFIG.os,
        tsdkAceEnabled: CONFIG.tsdkAceEnabled, tsdkGameId: CONFIG.tsdkGameId, tsdkAppKey: CONFIG.tsdkAppKey,
        deviceInfo: Object.freeze(deviceInfo),
    });
}

function usesPlayerSceneLogin(clientVersion) {
    const version = /^(\d+)\.(\d+)/.exec(clientVersion);
    return !!version && (Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 15));
}

module.exports = { createClientProfile, isWechatPlatform, usesPlayerSceneLogin };
