const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAdminFarmOperationRoutes } = require('../src/controllers/admin-farm-operation-routes');

function setup({ accountId = 'account-A', allowed = true } = {}) {
    const routes = new Map(); const calls = [];
    registerAdminFarmOperationRoutes({ app: { post: (path, handler) => routes.set(path, handler) },
        getAccountIdFromRequest: () => accountId, canAccessAccount: () => allowed,
        provider: { operateSelectedLands: async (...args) => { calls.push(args); return { successLandIds: [1] }; } },
        sendProviderError: (res, err) => res.status(500).json({ ok: false, error: err.message }) });
    return { calls, async post(body) {
        const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await routes.get('/api/farm/selected')({ body }, res); return res;
    } };
}
test('selection API strictly validates input before forwarding exact account, action and unique IDs', async () => {
    const h = setup();
    for (const body of [null, {}, { action: 'all', landIds: [1] }, { action: 'remove', landIds: [] }, { action: 'remove', landIds: ['1'] }]) {
        assert.equal((await h.post(body)).statusCode, 400);
    }
    assert.deepEqual(h.calls, []);
    assert.equal((await h.post({ action: 'remove', landIds: [1, 3, 1] })).body.ok, true);
    assert.deepEqual(h.calls, [['account-A', 'remove', [1, 3]]]);
});
test('selection API preserves account access controls', async () => {
    for (const [options, code] of [[{ accountId: '' }, 400], [{ allowed: false }, 403]]) {
        const h = setup(options);
        assert.equal((await h.post({ action: 'remove', landIds: [1] })).statusCode, code);
        assert.deepEqual(h.calls, []);
    }
});
