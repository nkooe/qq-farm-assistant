// 背包优先列表失败时停止本轮，不自动切换到列表外种子。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');
const os = require('node:os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-bag-fallback-'));
process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const root = path.join(__dirname, '..');
process.chdir(root);

// 优先列表内不可种种子（20167）与背包中可种种子（20022）
const PRIORITY_SEED = 20167;
const OTHER_BAG_SEED = 20022;

function setupEnv() {
  const proto = require(path.join(root, 'src/utils/proto'));
  const network = require(path.join(root, 'src/utils/network'));
  const utils = require(path.join(root, 'src/utils/utils'));
  const warehouse = require(path.join(root, 'src/services/warehouse'));
  const store = require(path.join(root, 'src/models/store'));
  return { proto, network, utils, warehouse, store };
}

test('plantFromBagSeeds: 优先种子失败时停止，禁止切换其他背包种子', async () => {
  const { proto, network, utils, warehouse, store } = setupEnv();
  await proto.loadProto();

  // 背包：两颗 1x1 种子
  const originalGetBagSeeds = warehouse.getBagSeeds;
  warehouse.getBagSeeds = async () => [
    { seedId: PRIORITY_SEED, name: '欢乐糖果', count: 10, requiredLevel: 21, plantSize: 1 },
    { seedId: OTHER_BAG_SEED, name: '鳄梨', count: 10, requiredLevel: 138, plantSize: 1 },
  ];
  const originalGetPriority = store.getBagSeedPriority;
  store.getBagSeedPriority = () => [PRIORITY_SEED];
  const originalGetFallback = store.getBagSeedFallbackStrategy;
  store.getBagSeedFallbackStrategy = () => 'level';

  // 网络：PRIORITY_SEED 一律失败，OTHER_BAG_SEED 前 2 块成功
  const originalSend = network.sendMsgAsync;
  const plantedSeeds = [];
  network.sendMsgAsync = async (service, method, body) => {
    if (method !== 'Plant')
      return originalSend(service, method, body);
    const decoded = proto.types.PlantRequest.decode(body);
    const seedId = Number(decoded.items[0].seed_id);
    plantedSeeds.push(seedId);
    if (seedId === PRIORITY_SEED) {
      const err = new Error('gamepb.plantpb.PlantService.Plant 错误: code=1003005 格子已锁定');
      err.code = 1003005;
      throw err;
    }
    const PlantReply = proto.types.PlantReply;
    return {
      body: PlantReply.encode(PlantReply.create({
        land: [{ id: Number(decoded.items[0].land_ids[0]), plant: { seed_id: seedId } }],
      })).finish(),
    };
  };

  const warnLogs = [];
  const originalWarn = utils.logWarn;
  const originalSleep = utils.sleep;
  utils.logWarn = (tag, msg, meta) => { warnLogs.push({ msg: String(msg), meta }); };
  utils.sleep = async () => {};

  try {
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
    const planting = require(path.join(root, 'src/services/planting-service'));

    const landIds = Array.from({ length: 6 }, (_, i) => i + 1);
    const result = await planting.plantFromBagSeeds(landIds, '1');

    assert.ok(plantedSeeds.every(id => id === PRIORITY_SEED));
    assert.strictEqual(result.totalPlanted, 0);
    assert.strictEqual(result.fallbackAllowed, false);
    assert.ok(warnLogs.some(w => w.meta?.result === 'seed_rejected'));
  } finally {
    warehouse.getBagSeeds = originalGetBagSeeds;
    store.getBagSeedPriority = originalGetPriority;
    store.getBagSeedFallbackStrategy = originalGetFallback;
    network.sendMsgAsync = originalSend;
    utils.logWarn = originalWarn;
    utils.sleep = originalSleep;
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
  }
});

test('plantFromBagSeeds: 优先列表内种子能种时不触碰其他背包种子', async () => {
  const { proto, network, utils, warehouse, store } = setupEnv();
  await proto.loadProto();

  const originalGetBagSeeds = warehouse.getBagSeeds;
  warehouse.getBagSeeds = async () => [
    { seedId: PRIORITY_SEED, name: '欢乐糖果', count: 10, requiredLevel: 21, plantSize: 1 },
    { seedId: OTHER_BAG_SEED, name: '鳄梨', count: 10, requiredLevel: 138, plantSize: 1 },
  ];
  const originalGetPriority = store.getBagSeedPriority;
  store.getBagSeedPriority = () => [PRIORITY_SEED];
  const originalGetFallback = store.getBagSeedFallbackStrategy;
  store.getBagSeedFallbackStrategy = () => 'level';

  const originalSend = network.sendMsgAsync;
  const plantedSeeds = [];
  network.sendMsgAsync = async (service, method, body) => {
    if (method !== 'Plant')
      return originalSend(service, method, body);
    const decoded = proto.types.PlantRequest.decode(body);
    const seedId = Number(decoded.items[0].seed_id);
    plantedSeeds.push(seedId);
    const PlantReply = proto.types.PlantReply;
    return {
      body: PlantReply.encode(PlantReply.create({
        land: [{ id: Number(decoded.items[0].land_ids[0]), plant: { seed_id: seedId } }],
      })).finish(),
    };
  };

  const originalWarn = utils.logWarn;
  const originalSleep = utils.sleep;
  utils.logWarn = () => {};
  utils.sleep = async () => {};

  try {
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
    const planting = require(path.join(root, 'src/services/planting-service'));

    const landIds = [1, 2];
    const result = await planting.plantFromBagSeeds(landIds, '1');

    assert.ok(plantedSeeds.every(id => id === PRIORITY_SEED),
      `只应种植优先列表内种子（实际种子序列 ${plantedSeeds.join(',')}）`);
    assert.strictEqual(result.totalPlanted, 2, '两块地都应种上优先种子');
  } finally {
    warehouse.getBagSeeds = originalGetBagSeeds;
    store.getBagSeedPriority = originalGetPriority;
    store.getBagSeedFallbackStrategy = originalGetFallback;
    network.sendMsgAsync = originalSend;
    utils.logWarn = originalWarn;
    utils.sleep = originalSleep;
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
  }
});
