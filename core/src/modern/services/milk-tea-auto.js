// Account-local automatic shop management. All writes share the manual queue.
'use strict';

const config = require('../activity-data/milk-tea-20261015.json');
const { toTimeSec } = require('../utils/utils');
const MILK = '2026110101';
const SHOP = '2026110102';
const FUND = '2026110103';
const number = value => Number(value?.toString?.() ?? value) || 0;
const positive = value => Number.isSafeInteger(number(value)) && number(value) > 0;
const validId = value => /^[1-9]\d{0,18}$/.test(String(value)) && BigInt(String(value)) <= 9223372036854775807n;

function affordable(costs, balances, maximum = 9999) {
    const totals = new Map();
    for (const cost of costs || []) {
        const id = number(cost.id);
        const count = number(cost.count);
        if (!positive(id) || !Number.isSafeInteger(count) || count < 0) return 0;
        totals.set(id, (totals.get(id) || 0) + count);
    }
    for (const [id, count] of totals) {
        if (!Number.isSafeInteger(count)) return 0;
        if (count > 0) maximum = Math.min(maximum, Math.floor((balances[id] || 0) / count));
    }
    return Math.max(0, maximum);
}

async function runAutomaticMilkTea({ group, rpc, inventory, serializeInventory, isItemLocked, now, allowed }) {
    const completed = [];
    const failures = new Set();
    const record = label => { if (label && !completed.includes(label)) completed.push(label); };
    let entries, head, summary;
    const isOpen = value => value && now() >= number(value.begin_time) && now() < number(value.end_time);
    const settling = () => number(head.settle_start_time) > 0 && now() >= number(head.settle_start_time);
    function check() {
        if (!allowed()) throw Object.assign(new Error('奶茶经营已暂停'), { cancelled: true });
        if (head && !isOpen(head)) throw Object.assign(new Error('活动已结束'), { cancelled: true });
    }
    async function refresh() {
        check();
        entries = await group();
        check();
        const milk = entries.find(value => String(value.head?.activity_id) === MILK);
        if (!milk?.head || !milk.milk_tea?.summary) throw new Error('奶茶进度未返回');
        head = milk.head;
        summary = milk.milk_tea.summary;
    }
    async function read(action, params) {
        check();
        const reply = await rpc(action, params);
        check();
        return reply;
    }
    async function write(action, label, params, businessOnly = false, target = head) {
        check();
        if (!isOpen(target) || (businessOnly && settling())) return null;
        const reply = await rpc(action, params);
        record(label);
        check();
        return reply;
    }
    async function step(label, task) {
        if (failures.has(label)) return;
        try { check(); await task(); }
        catch (error) {
            if (error.cancelled) throw error;
            // A lost write response is never replayed in this cycle. Other
            // independent tasks still read their own current server state.
            failures.add(label);
        }
    }
    const shopState = async () => {
        const shop = (await read('shop')).shop;
        if (!shop) throw new Error('店铺进度未返回');
        return shop;
    };
    const bagState = async diamonds => {
        check();
        const bag = await inventory(diamonds);
        check();
        return bag;
    };
    async function upgrade() {
        await refresh();
        for (let count = 0; summary.can_upgrade && count < config.MilkTeaStoreLevelConfig.length; count++) {
            const before = number(summary.level);
            const reply = await write('upgrade', null);
            if (!reply) return;
            await refresh();
            if (number(summary.level) <= before) throw new Error('升级进度未变化');
            record('店铺升级');
        }
    }
    try {
        await refresh();
        if (!isOpen(head)) return { status: 'inactive', message: '活动未开放', completed };
        if (!number(summary.shop_open_at)) {
            if (settling()) return { status: 'inactive', message: '活动结算中', completed };
            const name = config.MilkTeaActivityConfig[0].recommend_names.split(';')[0];
            await write('create', null, { shop_name: name }, true);
            await refresh();
            if (!number(summary.shop_open_at)) throw new Error('开业进度未确认');
            record('自动开业');
        }
        await step('营业收益', async () => {
            const shop = await shopState();
            if ((shop.pending_rewards || []).some(value => number(value.count) > 0)) await write('claim', '营业收益');
        });
        await step('工作工资', async () => {
            const work = await read('work');
            if ((work.slips || []).some(value => number(value.wage_status) === 1)) await write('wages', '工作工资');
        });
        await step('店铺升级', upgrade);
        await step('打工设置', async () => {
            if (summary.hire_disabled) await write('hireSetting', '允许雇佣', { hire_disabled: false }, true);
        });
        await step('制作奶茶', async () => {
            if (settling()) return;
            const recipes = (await read('workshop')).recipes || [];
            const fruitIds = new Set(recipes.filter(value => value.unlocked)
                .map(value => config.MilkTeaRecipeConfig.find(row => row.recipe_id === number(value.recipe_id)))
                .filter(Boolean).map(value => Number(value.fruit_item_id.split(':')[0])).filter(id => id > 0));
            // Coordinate with selling and locking, and re-read every UID batch.
            await serializeInventory(async () => {
                const used = new Set();
                for (let batch = 0; batch < 10; batch++) {
                    if (settling()) return;
                    const { bag } = await bagState(false);
                    const fruits = bag.filter(value => fruitIds.has(number(value.id)) && validId(value.uid)
                        && positive(value.count) && !isItemLocked(value) && !used.has(String(value.uid))
                        && (!toTimeSec(value.expire_time ?? value.expireTime)
                            || toTimeSec(value.expire_time ?? value.expireTime) > now())).slice(0, 200);
                    if (!fruits.length) return;
                    const uids = [...new Set(fruits.map(value => String(value.uid)))];
                    const reply = await write('craft', '制作奶茶', { fruit_uids: uids }, true);
                    if (!reply) return;
                    uids.forEach(uid => used.add(uid));
                }
            });
        });
        await step('好友雇佣', async () => {
            if (settling()) return;
            const durations = [...config.MilkTeaHireDurationConfig].sort((a, b) =>
                Number(a.duration_cost.split(':')[1]) / a.duration_sec - Number(b.duration_cost.split(':')[1]) / b.duration_sec);
            const attempted = new Set();
            // The shop's configured slots bound both requests and spending.
            const maxSlots = Math.max(...config.MilkTeaStoreLevelConfig.map(value => value.employee_slot_count));
            for (let hired = 0; hired < maxSlots; hired++) {
                const shop = await shopState();
                if (shop.is_settling || settling()) return;
                const slots = config.MilkTeaStoreLevelConfig.find(value => value.level === number(shop.level))?.employee_slot_count || 0;
                const slot = Array.from({ length: slots }, (_, index) => index).find(index =>
                    !(shop.slots || []).some(value => number(value.slot_index) === index && number(value.end_at) > now()));
                if (slot === undefined) return;
                let hiredSlot = false;
                let rejected = false;
                for (const duration of durations) {
                    const list = await read('hireList', { duration_id: duration.duration_id });
                    if (number(list.duration_id) !== duration.duration_id || !positive(list.wage_total)
                        || number(head.settle_start_time) - now() < Math.max(duration.min_remaining_business_sec, number(list.min_remain_biz_sec))) continue;
                    const candidates = [...(list.friends || []), ...(list.robots || [])].filter(value =>
                        validId(value.friend?.gid) && number(value.state) === 0 && number(value.rehire_available_at) <= now()
                        && !attempted.has(String(value.friend.gid))
                        && !(shop.slots || []).some(active => String(active.employee?.gid) === String(value.friend.gid) && number(active.end_at) > now()));
                    if (!candidates.length) continue;
                    for (const candidate of candidates) {
                        const { balances } = await bagState(false);
                        if (!affordable([{ id: 1041, count: number(list.wage_total) }], balances, 1)) break;
                        attempted.add(String(candidate.friend.gid));
                        const params = { hires: [{ slot_index: slot, duration_id: duration.duration_id, target_gid: String(candidate.friend.gid) }] };
                        const reply = await write('hire', null, params, true);
                        if (!reply) return;
                        if (!reply.results?.some(value => value.success && number(value.slot_index) === slot
                            && number(value.duration_id) === duration.duration_id && String(value.target_gid) === String(candidate.friend.gid))) {
                            rejected = true;
                            continue;
                        }
                        record('好友雇佣');
                        hiredSlot = true;
                        break;
                    }
                    if (hiredSlot) break;
                }
                if (!hiredSlot) {
                    if (rejected) throw new Error('雇佣未成功');
                    return;
                }
            }
        });
        await step('打工互动', async () => {
            if (settling()) return;
            const work = await read('work');
            const shift = work.my_shift;
            if (shift && validId(shift.shift_id) && validId(shift.employer?.gid) && !work.interact_done
                && number(shift.end_at) > now() && number(shift.interact_count) < number(shift.interact_limit)) {
                // Guaranteed bonus, no random wage penalty.
                await write('interact', '打工互动', { target_gid: String(shift.employer.gid), interaction_type: 2 }, true);
            }
        });
        await step('爆单加速', () => serializeInventory(async () => {
            if (settling()) return;
            const shop = await shopState();
            if (shop.is_settling || !positive(shop.sales_item_id) || !positive(shop.boost_cups_per_use)) return;
            const { balances } = await bagState(false);
            const count = Math.min(9999, Math.floor(balances[number(shop.sales_item_id)] || 0));
            if (count > 0) await write('boost', '爆单加速', { count }, true);
        }));
        if (completed.includes('爆单加速')) await step('店铺升级', upgrade);
        await step('成长基金', async () => {
            await refresh();
            let entry = entries.find(value => String(value.head?.activity_id) === FUND);
            if (!isOpen(entry?.head) || !entry?.growth_fund) return;
            if (!entry.growth_fund.unlocked) {
                const costs = entry.growth_fund.unlock_cost;
                if (!Array.isArray(costs) || !costs.length) return;
                const { balances } = await bagState(costs.some(value => number(value.id) === 1004));
                if (!affordable(costs, balances, 1)) return;
                await write('unlock', '基金解锁', {}, false, entry.head);
                await refresh();
                entry = entries.find(value => String(value.head?.activity_id) === FUND);
            }
            if (entry?.growth_fund?.unlocked && entry.growth_fund.tiers?.some(value => number(value.state) === 2))
                await write('fundClaim', '基金奖励', {}, false, entry.head);
        });
        await step('商店兑换', async () => {
            await refresh();
            const entry = entries.find(value => String(value.head?.activity_id) === SHOP);
            if (!isOpen(entry?.head) || !entry?.shop) return;
            // Limited rewards precede seeds and unlimited goods. Re-read prices,
            // conditions, limits and balances before each individual purchase.
            const goods = [...(entry.shop.goods || [])].sort((a, b) =>
                Number(a.category_tag === 'seed') - Number(b.category_tag === 'seed')
                || Number(number(a.purchase_limit) <= 0) - Number(number(b.purchase_limit) <= 0)
                || number(a.order) - number(b.order) || number(a.id) - number(b.id));
            const exchangeOne = async candidate => {
                await refresh();
                const current = entries.find(value => String(value.head?.activity_id) === SHOP);
                const value = current?.shop?.goods?.find(row => String(row.id) === String(candidate.id));
                if (!isOpen(current?.head) || !value || !positive(value.id) || !(value.item || []).some(reward => positive(reward.count))
                    || (value.cond_hints || []).some(condition => !condition.satisfied)
                    || (settling() && value.category_tag === 'seed')) return;
                const costs = value.cost || [];
                const remaining = number(value.purchase_limit) > 0 ? Math.max(0, number(value.purchase_limit) - number(value.purchased_count)) : 9999;
                // Unlimited free goods have no finite stopping condition.
                if (!number(value.purchase_limit) && !costs.some(cost => number(cost.count) > 0)) return;
                const { balances } = await bagState(costs.some(cost => number(cost.id) === 1004));
                const count = affordable(costs, balances, Math.min(9999, remaining));
                if (count > 0) await write('exchange', '商店兑换', { goods_id: String(value.id), count }, false, current.head);
            };
            for (const candidate of goods) {
                try { await exchangeOne(candidate); }
                catch (error) {
                    if (error.cancelled) throw error;
                    failures.add('商店兑换');
                }
            }
        });
        check();
        return { status: failures.size ? 'error' : 'idle', completed,
            message: failures.size ? `${[...failures].join('、')}待重试` : completed.length ? `已完成${completed.join('、')}` : '自动经营中' };
    } catch (error) {
        error.completed = completed;
        throw error;
    }
}

module.exports = { runAutomaticMilkTea, affordable };
