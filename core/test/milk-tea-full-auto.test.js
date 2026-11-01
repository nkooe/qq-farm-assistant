const test = require('node:test');
const assert = require('node:assert/strict');
const { runAutomaticMilkTea, affordable } = require('../src/modern/services/milk-tea-auto');

function harness() {
    let time = 1000;
    let connected = true;
    const calls = [];
    const reads = [];
    const head = { begin_time: 100, end_time: 100000, settle_start_time: 90000 };
    const summary = { shop_open_at: 500, level: 1, can_upgrade: false, hire_disabled: false };
    const shop = { level: 1, slots: [], pending_rewards: [], sales_item_id: 1042, boost_cups_per_use: 40 };
    const bag = [];
    const fund = { unlocked: true, tiers: [] };
    const goods = [];
    const work = {};
    const employees = [];
    const state = { head, summary, shop, bag, fund, goods, work, employees, fail: null, upgradeTo: 1,
        rejectedGid: '',
        beforeRead: () => {}, afterRead: () => {}, afterWrite: () => {}, lock: task => task() };
    const group = async () => [
        { head: { ...head, activity_id: '2026110101' }, milk_tea: { summary: { ...summary } } },
        { head: { ...head, activity_id: '2026110102' }, shop: { goods: structuredClone(goods) } },
        { head: { ...head, activity_id: '2026110103' }, growth_fund: structuredClone(fund) },
    ];
    const rpc = async (action, params = {}) => {
        if (['shop', 'work', 'workshop', 'hireList'].includes(action)) {
            reads.push(action);
            await state.beforeRead(action);
            const result = action === 'shop' ? { shop: structuredClone(shop) }
                : action === 'work' ? structuredClone(work)
                    : action === 'workshop' ? { recipes: [{ recipe_id: 2, unlocked: true }, { recipe_id: 3, unlocked: false }] }
                        : { duration_id: params.duration_id, wage_total: 40, min_remain_biz_sec: 600, friends: structuredClone(employees) };
            await state.afterRead(action);
            return result;
        }
        calls.push({ action, params });
        let reply = {};
        if (action === 'create') summary.shop_open_at = time;
        if (action === 'claim') shop.pending_rewards = [];
        if (action === 'wages') for (const value of work.slips) value.wage_status = 2;
        if (action === 'upgrade' && state.upgradeTo > summary.level) {
            summary.level++;
            shop.level = summary.level;
            summary.can_upgrade = summary.level < state.upgradeTo;
        }
        if (action === 'hireSetting') summary.hire_disabled = params.hire_disabled;
        if (action === 'craft') for (const value of bag) if (params.fruit_uids.includes(String(value.uid))) value.count = 0;
        if (action === 'boost') bag.find(value => value.id === 1042).count -= params.count;
        if (action === 'hire') {
            const hire = params.hires[0];
            const success = hire.target_gid !== state.rejectedGid;
            if (success) {
                shop.slots.push({ slot_index: hire.slot_index, end_at: time + 14400, employee: { gid: hire.target_gid } });
                bag.find(value => value.id === 1041).count -= 40;
            }
            reply = { results: [{ ...hire, success }] };
        }
        if (action === 'interact') work.interact_done = true;
        if (action === 'unlock') fund.unlocked = true;
        if (action === 'fundClaim') for (const value of fund.tiers) if (value.state === 2) value.state = 3;
        if (action === 'exchange') {
            const value = goods.find(row => String(row.id) === params.goods_id);
            value.purchased_count = (value.purchased_count || 0) + params.count;
            for (const cost of value.cost) bag.find(item => item.id === cost.id).count -= cost.count * params.count;
        }
        await state.afterWrite(action);
        if (state.fail === action) { state.fail = null; throw new Error('lost reply'); }
        return reply;
    };
    const inventory = async () => {
        const balances = {};
        for (const value of bag) if (!value.locked) balances[value.id] = (balances[value.id] || 0) + value.count;
        return { bag: structuredClone(bag), balances };
    };
    return { ...state, state, calls, reads,
        time: value => time = value, disconnect: () => connected = false,
        run: () => runAutomaticMilkTea({ group, rpc, inventory, now: () => time,
            allowed: () => connected, isItemLocked: value => !!value.locked, serializeInventory: task => state.lock(task) }) };
}

test('a fresh shop automatically opens, upgrades multiple levels, crafts, fills slots, works, boosts and unlocks funds', async () => {
    const h = harness();
    h.summary.shop_open_at = 0;
    h.summary.can_upgrade = true;
    h.summary.hire_disabled = true;
    h.state.upgradeTo = 3;
    h.bag.push({ id: 1041, count: 100 }, { id: 1004, count: 360 }, { id: 1042, count: 3 },
        { id: 40525, uid: '9007199254740993', count: 7 }, { id: 40525, uid: '20', count: 5, locked: true },
        { id: 40526, uid: '30', count: 9 });
    h.employees.push({ friend: { gid: '9007199254740994' } }, { friend: { gid: '22' } });
    h.work.my_shift = { shift_id: '9007199254740995', employer: { gid: '9007199254740996' }, end_at: 2000, interact_count: 0, interact_limit: 1 };
    h.fund.unlocked = false;
    h.fund.unlock_cost = [{ id: 1004, count: 360 }];
    h.fund.tiers = [{ state: 2 }];
    const result = await h.run();
    assert.equal(result.status, 'idle');
    assert.equal(h.summary.level, 3);
    assert.equal(h.summary.hire_disabled, false);
    assert.equal(h.shop.slots.length, 2);
    assert.equal(h.bag[0].count, 20);
    assert.equal(h.bag[2].count, 0);
    assert.deepEqual(h.calls.find(value => value.action === 'craft').params, { fruit_uids: ['9007199254740993'] });
    assert.deepEqual(h.calls.find(value => value.action === 'interact').params, { target_gid: '9007199254740996', interaction_type: 2 });
    assert.deepEqual(h.calls.filter(value => value.action === 'upgrade').length, 2);
    assert.equal(h.fund.tiers[0].state, 3);
    const previous = h.calls.length;
    await h.run();
    assert.equal(h.calls.length, previous, 'completed operations are not repeated');
});

test('unchanged upgrade progress stops the chain but does not block crafting or wages', async () => {
    const h = harness();
    h.summary.can_upgrade = true;
    h.bag.push({ id: 40525, uid: '8', count: 5 }, { id: 1042, count: 1 });
    h.work.slips = [{ wage_status: 1 }];
    const result = await h.run();
    assert.equal(result.status, 'error');
    assert.equal(h.calls.filter(value => value.action === 'upgrade').length, 1);
    assert.ok(result.completed.includes('制作奶茶'));
    assert.ok(result.completed.includes('工作工资'));
});

test('a lost upgrade reply is not replayed after boosting, and the next cycle reads the changed level', async () => {
    const h = harness();
    h.summary.can_upgrade = true;
    h.state.upgradeTo = 3;
    h.state.fail = 'upgrade';
    h.bag.push({ id: 1042, count: 1 });
    assert.equal((await h.run()).status, 'error');
    assert.equal(h.summary.level, 2);
    assert.equal(h.calls.filter(value => value.action === 'upgrade').length, 1);
    await h.run();
    assert.equal(h.summary.level, 3);
    assert.equal(h.calls.filter(value => value.action === 'upgrade').length, 2);
});

test('settlement permits cash, wages, upgrades, fund rewards and non-seed exchange only', async () => {
    const h = harness();
    h.time(90000);
    h.summary.can_upgrade = true;
    h.summary.hire_disabled = true;
    h.state.upgradeTo = 2;
    h.shop.pending_rewards = [{ count: 5 }];
    h.work.slips = [{ wage_status: 1 }];
    h.work.my_shift = { shift_id: '8', employer: { gid: '9' }, end_at: 95000, interact_limit: 1 };
    h.bag.push({ id: 1041, count: 10 }, { id: 1042, count: 1 }, { id: 40525, uid: '7', count: 5 });
    h.fund.tiers = [{ state: 2 }];
    h.goods.push({ id: 1, item: [{ id: 80011, count: 1 }], cost: [{ id: 1041, count: 1 }], purchase_limit: 1 },
        { id: 2, category_tag: 'seed', item: [{ id: 20525, count: 1 }], cost: [{ id: 1041, count: 1 }], purchase_limit: 1 });
    await h.run();
    assert.deepEqual(h.calls.map(value => value.action), ['claim', 'wages', 'upgrade', 'fundClaim', 'exchange']);
    assert.equal(h.calls.at(-1).params.goods_id, '1');
});

test('crossing settlement during a read prevents crafting with the just-read materials', async () => {
    const h = harness();
    h.bag.push({ id: 40525, uid: '7', count: 5 });
    h.state.afterRead = action => { if (action === 'workshop') h.time(90000); };
    await h.run();
    assert.equal(h.calls.length, 0);
});

test('disconnect, expiry and inventory queue cancellation stop the next write', async () => {
    for (const mode of ['disconnect', 'expiry', 'inventory']) {
        const h = harness();
        h.bag.push({ id: 40525, uid: '7', count: 5 });
        if (mode === 'inventory') h.state.lock = task => { h.disconnect(); return task(); };
        else h.state.afterRead = action => {
            if (action === 'workshop') { if (mode === 'disconnect') h.disconnect(); else h.time(100000); }
        };
        await assert.rejects(h.run(), error => error.cancelled === true);
        assert.equal(h.calls.length, 0);
    }
});

test('crafting batches whole unlocked UID stacks without crossing the 200-stack protocol limit', async () => {
    const h = harness();
    for (let index = 1; index <= 410; index++) h.bag.push({ id: 40525, uid: String(index), count: 1 });
    h.bag.push({ id: 40525, uid: '500', count: 1, locked: true }, { id: 40525, uid: '501', count: 1, expire_time: 900 });
    const result = await h.run();
    assert.equal(result.status, 'idle');
    assert.deepEqual(h.calls.filter(value => value.action === 'craft').map(value => value.params.fruit_uids.length), [200, 200, 10]);
    assert.equal(h.bag.at(-2).count, 1);
    assert.equal(h.bag.at(-1).count, 1);
});

test('automatic crafting uses the warehouse expiry rules for permanent stacks and second/millisecond timestamps', async () => {
    const h = harness();
    h.bag.push({ id: 40525, uid: '1', count: 1, expire_time: -1 },
        { id: 40525, uid: '2', count: 1, expire_time: 0 },
        { id: 40525, uid: '3', count: 1, expire_time: 900 },
        { id: 40525, uid: '4', count: 1, expire_time: 1100 },
        { id: 40525, uid: '5', count: 1, expire_time: 1793532000000 },
        { id: 40525, uid: '6', count: 1, expire_time: 1793532200000 },
        { id: 40525, uid: '7', count: 1, expireTime: -1 });
    h.time(1793532100);
    h.head.end_time = 1800000000;
    h.head.settle_start_time = 1794671999;
    const result = await h.run();
    assert.equal(result.status, 'idle');
    assert.deepEqual(h.calls.find(value => value.action === 'craft').params.fruit_uids, ['1', '2', '6', '7']);
    assert.equal(h.bag[2].count, 1);
    assert.equal(h.bag[3].count, 1);
    assert.equal(h.bag[4].count, 1);
});

test('exchange obeys current conditions, remaining limits, aggregate costs and available balance', async () => {
    const h = harness();
    h.bag.push({ id: 1041, count: 10 });
    h.goods.push({ id: 1, item: [{ id: 80011, count: 1 }], cost: [{ id: 1041, count: 2 }], purchase_limit: 5, purchased_count: 4 },
        { id: 2, item: [{ id: 80011, count: 1 }], cost: [{ id: 1041, count: 2 }, { id: 1041, count: 2 }], purchase_limit: 10 },
        { id: 3, item: [{ id: 80011, count: 1 }], cost: [], purchase_limit: 1, cond_hints: [{ satisfied: false }] },
        { id: 4, item: [{ id: 80011, count: 1 }], cost: [], purchase_limit: 1, purchased_count: 1 },
        { id: 5, item: [{ id: 80011, count: 1 }], cost: [] });
    await h.run();
    assert.deepEqual(h.calls.filter(value => value.action === 'exchange').map(value => value.params), [{ goods_id: '1', count: 1 }, { goods_id: '2', count: 2 }]);
    assert.equal(h.bag[0].count, 0);
});

test('insufficient or locked resources skip spending without disabling other tasks', async () => {
    const h = harness();
    h.bag.push({ id: 1041, count: 0 }, { id: 1042, count: 1, locked: true }, { id: 1004, count: 359 });
    h.fund.unlocked = false;
    h.fund.unlock_cost = [{ id: 1004, count: 360 }];
    h.employees.push({ friend: { gid: '8' } });
    h.shop.pending_rewards = [{ count: 1 }];
    const result = await h.run();
    assert.equal(result.status, 'idle');
    assert.deepEqual(h.calls.map(value => value.action), ['claim']);
});

test('separate account workers never share inventory or task progress', async () => {
    const first = harness();
    const second = harness();
    first.bag.push({ id: 40525, uid: '7', count: 1 });
    second.bag.push({ id: 1042, count: 2 });
    const results = await Promise.all([first.run(), second.run()]);
    assert.deepEqual(results.map(value => value.completed), [['制作奶茶'], ['爆单加速']]);
    assert.deepEqual(first.calls.map(value => value.action), ['craft']);
    assert.deepEqual(second.calls.map(value => value.action), ['boost']);
});

test('cost validation rejects negative, fractional and overflowing prices', () => {
    for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(affordable([{ id: 1041, count }], { 1041: 100 }), 0);
    assert.equal(affordable([{ id: 1041, count: 6 }, { id: 1041, count: 6 }], { 1041: 20 }), 1);
});

test('a rejected employee is skipped for other candidates without claiming success or replaying the same hire', async () => {
    const h = harness();
    h.summary.level = 3;
    h.shop.level = 3;
    h.bag.push({ id: 1041, count: 100 });
    h.state.rejectedGid = '11';
    h.employees.push({ friend: { gid: '11' } }, { friend: { gid: '21' } }, { friend: { gid: '22' } });
    const result = await h.run();
    assert.equal(result.status, 'idle');
    assert.deepEqual(h.shop.slots.map(value => value.employee.gid), ['21', '22']);
    assert.deepEqual(h.calls.filter(value => value.action === 'hire').map(value => value.params.hires[0].target_gid), ['11', '21', '22']);
    assert.equal(h.bag[0].count, 20);
});

test('a lost successful hire reply does not start another hire until a fresh cycle reads the occupied slot', async () => {
    const h = harness();
    h.bag.push({ id: 1041, count: 100 });
    h.employees.push({ friend: { gid: '21' } });
    h.state.fail = 'hire';
    const result = await h.run();
    assert.equal(result.status, 'error');
    assert.equal(result.completed.includes('好友雇佣'), false);
    await h.run();
    assert.equal(h.calls.filter(value => value.action === 'hire').length, 1);
    assert.equal(h.shop.slots.length, 1);
});

test('a lost exchange reply is not replayed, and other goods use the refreshed balance and purchase limits', async () => {
    const h = harness();
    h.bag.push({ id: 1041, count: 10 });
    h.goods.push({ id: 1, item: [{ id: 80011, count: 1 }], cost: [{ id: 1041, count: 4 }], purchase_limit: 1 },
        { id: 2, item: [{ id: 80011, count: 1 }], cost: [{ id: 1041, count: 4 }], purchase_limit: 1 });
    h.state.fail = 'exchange';
    const result = await h.run();
    assert.equal(result.status, 'error');
    assert.deepEqual(h.calls.filter(value => value.action === 'exchange').map(value => value.params), [{ goods_id: '1', count: 1 }, { goods_id: '2', count: 1 }]);
    assert.equal(h.bag[0].count, 2);
    await h.run();
    assert.equal(h.calls.filter(value => value.action === 'exchange').length, 2);
});
