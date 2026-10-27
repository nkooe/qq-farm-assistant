const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('all successful Enter paths record current pet truth; errors and malformed briefs never become no-dog', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-pet-enter-'));
    const oldDir = process.env.FARM_DATA_DIR, oldId = process.env.FARM_ACCOUNT_ID;
    process.env.FARM_DATA_DIR = dir; process.env.FARM_ACCOUNT_ID = 'pet-enter-account';
    const network = require('../src/utils/network'), original = network.sendMsgAsync;
    const { types, loadProto } = require('../src/utils/proto');
    await loadProto();
    let body = Buffer.alloc(0), failure = null;
    network.sendMsgAsync = async () => { if (failure) throw failure; return { body }; };
    delete require.cache[require.resolve('../src/services/friend-api')];
    const api = require('../src/services/friend-api'), cache = require('../src/services/friend-pet-cache');
    t.after(() => {
        cache.flushAll(); network.sendMsgAsync = original;
        if (oldDir == null) delete process.env.FARM_DATA_DIR; else process.env.FARM_DATA_DIR = oldDir;
        if (oldId == null) delete process.env.FARM_ACCOUNT_ID; else process.env.FARM_ACCOUNT_ID = oldId;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const withDog = id => types.VisitEnterReply.encode({ brief_dog_info: require('protobufjs/minimal').Writer.create().uint32(8).uint64(id).finish() }).finish();
    body = withDog(90021); await api.enterFriendFarm(9);
    assert.equal(cache.getState(9), 'protect');
    body = withDog(90002); await api.enterFriendFarm(9);
    assert.equal(cache.getState(9), 'other');
    body = withDog(90021); await api.enterFriendFarm(9);
    body = Buffer.alloc(0); await api.enterFriendFarm(9);
    assert.equal(cache.entries()['9'].dogId, 0);
    body = types.VisitEnterReply.encode({ brief_dog_info: Buffer.from([0x80]) }).finish();
    await api.enterFriendFarm(10); assert.equal(cache.getState(10), 'unknown');
    failure = new Error('timeout');
    await assert.rejects(api.enterFriendFarm(11), /timeout/);
    assert.equal(cache.getState(11), 'unknown');
    const unrelated = api.parseBriefDogInfoBytes(require('protobufjs/minimal').Writer.create().uint32(16).uint64(90021).finish());
    assert.equal(unrelated.valid, false); assert.equal(unrelated.dogId, 0);
});
