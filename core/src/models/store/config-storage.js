const fs = require('node:fs');
const path = require('node:path');
const { readJsonFileStrict, writeTextFileAtomic, storageError } = require('../../services/json-db');
const { parseUserId } = require('../user-id');
const FORMAT_VERSION = 3;
const FORMAT_FILE = '.format.json';

function assertObject(value, file) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw storageError('读取', file, new Error('Expected a JSON object'));
    return value;
}
function accountFilename(id) {
    if (typeof id !== 'string' || !id || id !== id.trim()) throw new Error('Invalid account ID');
    const name = /^\d+$/.test(id) ? id : `id-${Buffer.from(id, 'utf8').toString('hex')}`;
    return `${name}.json`;
}
function accountIdFromFilename(filename) {
    const name = filename.slice(0, -5);
    const id = /^\d+$/.test(name) ? name
        : /^id-(?:[0-9a-f]{2})+$/.test(name) ? Buffer.from(name.slice(3), 'hex').toString('utf8') : '';
    if (accountFilename(id) !== filename) throw new Error('Invalid account filename');
    return id;
}
function createConfigStorage(storeFile) {
    const accountDir = path.join(path.dirname(storeFile), 'account-configs');
    const accountJson = new Map();
    let globalJson;
    function writeDocument(file, document) {
        try { const json = JSON.stringify(document, null, 2); writeTextFileAtomic(file, json); return json; }
        catch (error) { throw storageError('保存', file, error); }
    }
    function load() {
        try {
            if (!fs.existsSync(storeFile)) {
                if (fs.existsSync(accountDir) || process.env.FARM_ACCOUNT_ID) throw new Error('Incomplete config storage; initialize new test data');
                fs.mkdirSync(accountDir, { recursive: true });
                writeDocument(path.join(accountDir, FORMAT_FILE), { version: FORMAT_VERSION });
                writeDocument(storeFile, { accountConfigStorageVersion: FORMAT_VERSION });
            }
            const data = assertObject(readJsonFileStrict(storeFile), storeFile);
            if (data.accountConfigStorageVersion !== FORMAT_VERSION || ['accountConfigs', 'captureConfig', 'ui', 'offlineReminder', 'globalWxConfig', 'deviceProtocol', 'adminPasswordHash'].some(field => Object.hasOwn(data, field))) {
                throw new Error('Unsupported config format; initialize new test data');
            }
            for (const reminder of Object.values(data.userOfflineReminders || {})) {
                if (reminder && Object.hasOwn(reminder, 'reloginUrlMode')) throw new Error('Unsupported notification format');
            }
            for (const field of ['userOfflineReminders', 'userDeviceProtocols', 'userDefaultAccountPlans', 'announcementReadRecords', 'userUis', 'userWxConfigs']) {
                if (data[field] !== undefined) {
                    assertObject(data[field], storeFile);
                    Object.keys(data[field]).forEach(parseUserId);
                }
            }
            const formatFile = path.join(accountDir, FORMAT_FILE);
            if (readJsonFileStrict(formatFile)?.version !== FORMAT_VERSION) throw new Error('Unsupported account config format');
            const configs = Object.create(null);
            accountJson.clear();
            for (const entry of fs.readdirSync(accountDir, { withFileTypes: true })) {
                if (entry.name === FORMAT_FILE) continue;
                if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error(`Unexpected account document: ${entry.name}`);
                const id = accountIdFromFilename(entry.name);
                const file = path.join(accountDir, entry.name);
                configs[id] = assertObject(readJsonFileStrict(file), file);
                accountJson.set(id, JSON.stringify(configs[id], null, 2));
            }
            globalJson = JSON.stringify(data, null, 2);
            return { ...data, accountConfigs: configs };
        } catch (error) { throw storageError('读取', storeFile, error); }
    }
    function saveGlobal(data) {
        const { accountConfigs: _accounts, ...document } = data;
        document.accountConfigStorageVersion = FORMAT_VERSION;
        const json = JSON.stringify(document, null, 2);
        if (json !== globalJson) globalJson = writeDocument(storeFile, document);
    }
    function saveAccount(id, config) {
        const file = path.join(accountDir, accountFilename(id));
        assertObject(config, file);
        const json = JSON.stringify(config, null, 2);
        if (accountJson.get(id) !== json) accountJson.set(id, writeDocument(file, config));
    }
    function removeAccount(id) {
        const file = path.join(accountDir, accountFilename(id));
        if (fs.existsSync(file)) fs.unlinkSync(file);
        accountJson.delete(id);
    }
    return { load, saveGlobal, saveAccount, removeAccount };
}
module.exports = { createConfigStorage, FORMAT_VERSION };
