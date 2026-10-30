const crypto = require('node:crypto');
const fs = require('node:fs');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');
const { toNum } = require('../utils/utils');

const PROTECT_DOG_ID = 90021;
function dateKey(time = Date.now()) {
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function cacheFile(accountId) {
    return getDataFile(`friend-pet-${crypto.createHash('sha256').update(String(accountId)).digest('hex')}.json`);
}
function createFriendPetCache({ now = Date.now, read = readJsonFile, write = writeJsonFileAtomic, file = cacheFile } = {}) {
    const accounts = new Map();
    function flush(accountId) {
        const state = accounts.get(String(accountId));
        if (!state) return;
        clearTimeout(state.timer);
        state.timer = null;
        write(file(accountId), { version: 1, date: state.date, entries: state.entries });
    }
    function schedule(accountId, state) {
        if (state.timer) return; // Bounded debounce: sustained visits still persist every two seconds.
        state.timer = setTimeout(() => flush(accountId), 2000);
        state.timer.unref?.();
    }
    function load(accountId) {
        const key = String(accountId || '');
        const today = dateKey(now());
        let state = accounts.get(key);
        if (!state) {
            const saved = read(file(key), null);
            state = { date: today, entries: {}, timer: null };
            if (saved?.version === 1 && saved.date === today && saved.entries && typeof saved.entries === 'object') {
                for (const [gid, entry] of Object.entries(saved.entries)) {
                    if (Number.isSafeInteger(Number(gid)) && Number(gid) > 0 && Number.isInteger(entry?.dogId) && entry.dogId >= 0
                        && Number.isFinite(entry.checkedAt) && entry.checkedAt > 0 && dateKey(entry.checkedAt) === today)
                        state.entries[gid] = { dogId: entry.dogId, checkedAt: entry.checkedAt };
                }
            } else if (saved && saved.version !== 1) {
                throw new Error('宠物缓存格式无效');
            }
            accounts.set(key, state);
        }
        if (state.date !== today) {
            state.date = today;
            state.entries = {};
            schedule(key, state);
        }
        return state;
    }
    function record(gid, dogId, accountId = process.env.FARM_ACCOUNT_ID || '') {
        if (dogId == null || !Number.isFinite(Number(dogId))) return;
        const id = toNum(gid), dog = toNum(dogId);
        if (!accountId || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(dog) || dog < 0) return;
        const state = load(accountId);
        const previous = state.entries[id];
        state.entries[id] = { dogId: dog, checkedAt: now() };
        if (!previous || previous.dogId !== dog) schedule(accountId, state);
    }
    function entries(accountId = process.env.FARM_ACCOUNT_ID || '') { return { ...load(accountId).entries }; }
    function getState(gid, accountId = process.env.FARM_ACCOUNT_ID || '') {
        const entry = load(accountId).entries[toNum(gid)];
        return !entry ? 'unknown' : entry.dogId === PROTECT_DOG_ID ? 'protect' : 'other';
    }
    function guards(accountId) {
        return Object.fromEntries(Object.entries(entries(accountId)).filter(([, e]) => e.dogId === PROTECT_DOG_ID)
            .map(([gid, e]) => [gid, { ...e, dogName: '护主犬' }]));
    }
    function forget(gid, accountId = process.env.FARM_ACCOUNT_ID || '') {
        const state = load(accountId);
        if (Object.hasOwn(state.entries, gid)) { delete state.entries[gid]; schedule(accountId, state); }
    }
    function clear(accountId) {
        const state = accounts.get(String(accountId));
        clearTimeout(state?.timer);
        accounts.delete(String(accountId));
        const target = file(accountId);
        if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    function flushAll() { for (const id of accounts.keys()) flush(id); }
    return { record, entries, getState, guards, forget, clear, flush, flushAll };
}
const cache = createFriendPetCache();
module.exports = { ...cache, createFriendPetCache, dateKey, PROTECT_DOG_ID, cacheFile };
