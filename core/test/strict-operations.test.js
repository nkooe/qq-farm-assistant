const test = require('node:test');
const assert = require('node:assert/strict');
const protobuf = require('protobufjs/minimal');
const proto = require('../src/utils/proto');
const network = require('../src/utils/network');

async function activityHarness(t) {
  await proto.loadProto();
  t.mock.method(network, 'isConnected', () => true);
  const id = require.resolve('../src/services/activity');
  delete require.cache[id];
  t.after(() => { delete require.cache[id]; });
  return () => require(id);
}

test('activity group failure is reported without trying other UIDs or fabricated data', async t => {
  const load = await activityHarness(t);
  const requests = [];
  t.mock.method(network, 'sendMsgAsync', async (_service, method, payload) => {
    requests.push({ method, request: proto.types.ActivityGetGroupRequest.decode(payload) });
    throw new Error('fixture upstream failure');
  });
  await assert.rejects(load().getQingmeiActivity(), /fixture upstream failure/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.uid, load().QINGMEI_ACTIVITY_UID);
});

test('wine preview failure stops the workflow before brew or sell mutations', async t => {
  const load = await activityHarness(t);
  const warehouse = require('../src/services/warehouse');
  t.mock.method(warehouse, 'getBag', async () => ({ fixture: true }));
  t.mock.method(warehouse, 'getBagItems', () => [{ id: 41221, uid: 123, count: 3 }]);
  const commands = [];
  t.mock.method(network, 'sendMsgAsync', async (_service, method, payload) => {
    assert.equal(method, 'Operate');
    commands.push(proto.types.ActivityOperateRequest.decode(payload).cmd);
    throw new Error('fixture preview failure');
  });
  await assert.rejects(load().brewAndSellQingmeiWine(), /fixture preview failure/);
  assert.deepEqual(commands.map(Number), [14]);
});

test('failed batch mutations are never replayed per land', async t => {
  await proto.loadProto();
  const id = require.resolve('../src/services/friend-operation-limits');
  delete require.cache[id]; t.after(() => { delete require.cache[id]; });
  const calls = [];
  t.mock.method(network, 'sendMsgAsync', async (_service, method) => {
    calls.push(method); throw new Error('fixture mutation failure');
  });
  const operations = require(id);
  await assert.rejects(operations.putWeeds(42, [1, 2, 3]), /fixture mutation failure/);
  await assert.rejects(operations.putInsectsDetailed(42, [1, 2, 3]), /fixture mutation failure/);
  assert.deepEqual(calls, ['PutWeeds', 'PutInsects']);
});

test('constellation decoder reads the documented group envelope and rejects truncated data', async t => {
  const load = await activityHarness(t);
  const info = protobuf.Writer.create().uint32(8).uint64(load().GUANXING_ACTIVITY_ID).uint32(34).string('观星礼录').finish();
  const constellation = protobuf.Writer.create().uint32(8).uint32(4).finish();
  const node = protobuf.Writer.create().uint32(10).bytes(info).uint32((110 << 3) | 2).bytes(constellation).finish();
  const root = protobuf.Writer.create().uint32(18).bytes(node).finish();
  const reply = protobuf.Writer.create().uint32(10).bytes(root).finish();
  const operation = protobuf.Writer.create().uint32(26).bytes(node).finish();
  assert.equal(load().normalizeGuanxingActivity(reply).currentDay, 4);
  assert.equal(load().normalizeGuanxingActivity(operation, true).currentDay, 4);
  assert.throws(() => load().normalizeGuanxingActivity(reply.subarray(0, reply.length - 1)));
  assert.throws(() => load().normalizeGuanxingActivity(Buffer.alloc(0)), /group/);
});
