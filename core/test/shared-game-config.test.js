const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-shared-config-'));
process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const legacy = require('../src/config/gameConfig');
const modern = require('../src/modern/config/gameConfig');
const shared = require('../src/config/shared-game-tables');
const { reloadGameConfig } = require('../src/config/reload-game-config');
const EXTRA_IDS = [20113, 20265, 20266, 40113, 40265, 40266];

test('两套实际加载器读取同一公共源，modern 专属表继续可用', () => {
  const tables = shared.loadSharedGameTables();
  assert.equal(tables.ItemInfo.length, 971);
  for (const item of tables.ItemInfo) {
    assert.equal(legacy.getItemById(item.id).name, item.name);
    assert.equal(modern.getItemById(item.id).name, item.name);
    assert.equal(modern.getItemById(item.id).type, legacy.getItemById(item.id).type);
  }
  assert.deepEqual(modern.getAllPlants(), legacy.getAllPlants());
  assert.deepEqual(modern.getLevelExpTable(), legacy.getLevelExpTable());
  for (const id of EXTRA_IDS) assert.ok(modern.getItemById(id), `modern 应识别物品 ${id}`);
  assert.equal(modern.getAllLandConfigs().length, 24);
  assert.ok(modern.getIllustratedTypeByParam(40002));
});

test('公共表重载后，已经绑定函数的真实仓库门面及策略列表立即识别新种子', async t => {
  const proto = require('../src/modern/utils/proto');
  await proto.loadProto();
  const network = require('../src/modern/utils/network');
  const marker = 298765;
  const rows = [{ id: marker, count: 2, uid: 1 }, { id: marker, count: 50, uid: 2, locked: true }];
  t.mock.method(network, 'sendMsgAsync', async (_service, method) => {
    assert.equal(method, 'Bag');
    return { body: proto.types.BagReply.encode({ item_bag: { items: rows } }).finish() };
  });
  const warehouseId = require.resolve('../src/modern/services/warehouse');
  delete require.cache[warehouseId];
  t.after(() => { delete require.cache[warehouseId]; });
  const facade = require('../src/services/warehouse');
  assert.equal((await facade.getBagSeeds()).length, 0, '同步前不存在该物品');
  const tables = shared.loadSharedGameTables();
  tables.ItemInfo.push({ id: marker, name: '同步测试种子', type: 5, level: 1, interaction_type: 'plant' });
  tables.Plant.push({ ...tables.Plant[0], id: 1929999, seed_id: marker, name: '同步测试', size: 1 });
  const mock = t.mock.method(shared, 'loadSharedGameTables', () => structuredClone(tables));
  const result = reloadGameConfig();
  assert.equal(result.ok, true);
  const seeds = await facade.getBagSeeds();
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].seedId, marker);
  assert.equal(seeds[0].count, 2, '锁定种子不能混入可种库存');
  assert.equal(seeds[0].name, '同步测试');
  const api = require('../src/services/farm-api');
  const mainNetwork = require('../src/utils/network');
  t.mock.method(api, 'getSeedShopId', async () => 2);
  t.mock.method(api, 'getShopInfo', async () => ({ goods_list: [{ id: 987, item_id: marker, unlocked: true }] }));
  t.mock.method(mainNetwork, 'getUserState', () => ({ level: 200 }));
  const plantingId = require.resolve('../src/services/planting-service');
  delete require.cache[plantingId];
  t.after(() => { delete require.cache[plantingId]; });
  assert.ok((await require(plantingId).getAvailableSeeds()).some(seed => seed.seedId === marker));
  mock.mock.restore();
  assert.equal(reloadGameConfig().ok, true);
  assert.ok(!modern.getItemById(marker), '已删除条目不会残留在 Map');
});

test('公共表缺失/损坏/含无效 ID 时拒绝重载并保留已有字典', t => {
  const original = modern.getItemById(20113);
  const originalLegacy = legacy.getItemById(20113);
  t.mock.method(shared, 'loadSharedGameTables', () => { throw new Error('ItemInfo.json 损坏'); });
  const result = reloadGameConfig();
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(modern.getItemById(20113), original);
  assert.deepEqual(legacy.getItemById(20113), originalLegacy);
});

test('公共源读盘失败和无效结构不会被静态副本掩盖', t => {
  const helper = require('../src/config/shared-game-tables');
  const read = fs.readFileSync;
  for (const value of ['{invalid', '{}', '[]', '[{}]', '[{"level":1},{"level":1}]']) {
    const mock = t.mock.method(fs, 'readFileSync', (filename, ...args) => String(filename).endsWith('RoleLevel.json') ? value : read(filename, ...args));
    assert.throws(() => helper.loadSharedGameTables());
    mock.mock.restore();
  }
});

test('热加载其中一套失败时仍尝试另一套，并报告失败', t => {
  t.mock.method(legacy, 'loadConfigs', () => { throw new Error('test failure'); });
  const loadModern = t.mock.method(modern, 'loadConfigs', () => true);
  const result = reloadGameConfig();
  assert.equal(result.ok, false);
  assert.equal(loadModern.mock.callCount(), 1);
  assert.match(result.errors[0], /test failure/);
});

test('运行时独立广播只发送游戏资源刷新，单个 Worker 失败不影响其他 Worker', () => {
  const { createRuntimeEngine } = require('../src/runtime/runtime-engine');
  const engine = createRuntimeEngine();
  const sent = [];
  engine.workers.a = { process: { send: msg => sent.push(msg) } };
  engine.workers.b = { process: { send: () => { throw new Error('closed'); } } };
  engine.workers.c = { process: { send: msg => sent.push(msg) } };
  assert.deepEqual(engine.broadcastGameConfigReload(), { sent: 2, failed: 1 });
  assert.deepEqual(sent, [{ type: 'game_config_reload' }, { type: 'game_config_reload' }]);
  assert.equal(Object.hasOwn(sent[0], 'config'), false, '不发送账号策略快照');
});

test('真实 Worker IPC 刷新两套缓存并确认，无需重启种植任务', { timeout: 15000 }, async t => {
  const root = path.join(__dirname, '../src');
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const path = require('node:path');
    const root = ${JSON.stringify(root)};
    const network = require(path.join(root, 'utils/network'));
    network.sendMsgAsync = async () => { throw new Error('测试禁止真实游戏请求'); };
    require(path.join(root, 'core/worker'));
    const shared = require(path.join(root, 'config/shared-game-tables'));
    const tables = shared.loadSharedGameTables();
    tables.ItemInfo.push({ id: 298764, type: 5, name: 'IPC种子' });
    shared.loadSharedGameTables = () => structuredClone(tables);
    parentPort.on('message', msg => {
      if (msg.type === 'probe') parentPort.postMessage({ type: 'probe',
        names: ['config/gameConfig', 'modern/config/gameConfig'].map(p => require(path.join(root, p)).getItemById(298764)?.name) });
    });
    parentPort.postMessage({ type: 'ready' });
  `, { eval: true, env: { ...process.env, FARM_DATA_DIR: dataDir, FARM_ACCOUNT_ID: 'ipc-test' }, stdout: true, stderr: true });
  t.after(() => worker.terminate());
  const messages = [];
  worker.on('message', msg => messages.push(msg));
  async function receive(type) {
    for (;;) {
      const old = messages.find(msg => msg.type === type);
      if (old) return old;
      await once(worker, 'message');
    }
  }
  await receive('ready');
  worker.postMessage({ type: 'game_config_reload' });
  assert.equal((await receive('game_config_reloaded')).ok, true);
  worker.postMessage({ type: 'probe' });
  assert.deepEqual((await receive('probe')).names, ['IPC种子', 'IPC种子']);
  assert.equal(messages.some(msg => msg.type === 'status_sync'), false, '游戏资源刷新不触发策略重排/状态同步');
});
