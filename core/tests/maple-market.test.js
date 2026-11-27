const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protobuf = require('protobufjs');
const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/maple-market.proto'), { keepCase: true });
const types = Object.fromEntries(['MapleGetGroupReply', 'MapleOperateRequest', 'MapleOperateReply'].map(name => [name, root.lookupType(`gamepb.maplepb.${name}`)]));
types.GetGroupRequest = new protobuf.Type('GetGroupRequest').add(new protobuf.Field('group_id', 1, 'int64'));
const encode = (type, data) => Buffer.from(type.encode(type.fromObject(data)).finish());
const fields = { 91: 'maple_market_claim_seed', 92: 'maple_market_get_shop', 93: 'maple_market_sell', 95: 'maple_market_get_purchase_log', 96: 'maple_market_exchange', 97: 'maple_market_get_goods_list', 99: 'maple_market_claim_commission' };
const self = '9007199254740993';

function harness(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maple-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const previous = process.env.FARM_ACCOUNT_ID;
    process.env.FARM_ACCOUNT_ID = 'maple-test-account';
    t.after(() => { if (previous === undefined) delete process.env.FARM_ACCOUNT_ID; else process.env.FARM_ACCOUNT_ID = previous; });
    const h = { now: 100500, writes: [], fail: '', diskFail: false,
        head: { id: '2026111708', start_time: 100000, end_time: 200000, settle_start_time: 190000, status: 1 },
        body: { daily_state: { seed_claimed: false }, pending_commission_activity_coin: 20, pending_commission_count: 1 },
        bag: [{ id: 1032, count: 100 }, { id: 1032, count: 20, locked: true }],
        good: { goods_id: 1, activity_coin_price: 100, limit_type: 1, limit_times: 3, purchased_daily: 1, purchased_total: 99, exchangeable: true },
        currency: '90071992547409930', price: 161, boost: 11, quota: 4 };
    const mock = (name, exports) => { const id = require.resolve(`../dist/${name}`); require.cache[id] = { id, filename: id, loaded: true, exports }; };
    mock('utils/proto', { types });
    mock('utils/utils', { getServerTimeSec: () => h.now });
    mock('config/runtime-paths', { getDataDir: () => dir });
    const atomic = require('../dist/services/json-db').writeJsonFileAtomic;
    mock('services/json-db', { writeJsonFileAtomic: (...args) => { if (h.diskFail) throw new Error('disk full'); return atomic(...args); } });
    mock('config/gameConfig', { getItemById: () => null, getItemImageById: () => '' });
    mock('services/warehouse', { getBag: async () => ({ items: h.bag }), getBagItems: v => v.items, isItemLocked: v => !!v.locked });
    mock('utils/network', { getUserState: () => ({ gid: self }), sendMsgAsync: async (_service, method, bytes, options) => {
        if (method === 'GetGroup') {
            assert.equal(String(types.GetGroupRequest.decode(bytes).group_id), '2026111707');
            if (h.fail === 'refresh' && h.writes.length) throw new Error('refresh offline');
            return { body: encode(types.MapleGetGroupReply, { group: { head: { id: '2026111707' }, children: [{ head: h.head, maple_market: h.body }] } }) };
        }
        const req = types.MapleOperateRequest.toObject(types.MapleOperateRequest.decode(bytes), { longs: String });
        assert.equal(req.id, '2026111708');
        const cmd = Number(req.cmd); let result;
        if (cmd === 92) result = { shop: { owner: { gid: req[fields[cmd]].target_gid, name: '测试小铺' }, base_price: h.price, boost_value: h.boost, remain_quota: h.quota }, can_sell: true };
        else if (cmd === 97) result = { goods: [h.good], activity_coin: h.currency };
        else if (cmd === 95) result = { logs: [{ seller_gid: self, sold_count: 2, sell_time: 100300, activity_coin_income: 344 }] };
        else {
            if (h.fail === 'before') throw new Error('not connected');
            options.onSent(); h.writes.push(req);
            if (h.fail === 'timeout') throw new Error('response timeout');
            if (h.fail === 'malformed') return { body: Buffer.from([0xff]) };
            if (cmd === 91) { h.body.daily_state.seed_claimed = true; result = { seed: { id: 20307, count: 28 } }; }
            if (cmd === 93) result = { sold_count: req[fields[cmd]].sell_count, final_price: 172, activity_coin_income: 1720 };
            if (cmd === 96) result = { items: [{ id: 204013, count: 1 }], activity_coin_cost: 100 };
            if (cmd === 99) result = { activity_coin: 20, claim_count: 1 };
        }
        return { body: encode(types.MapleOperateReply, { id: req.id, cmd, [fields[cmd]]: result }) };
    } });
    h.reload = () => { const id = require.resolve('../dist/services/maple-market'); delete require.cache[id]; h.service = require(id); };
    h.reload();
    h.input = (more = {}) => ({ operationId: 'maple-operation-0001', confirmed: true, ...more });
    h.op = (action, input) => h.service.operateMapleMarket(action, h.input(input));
    return h;
}

test('dynamic quotes preserve int64 GIDs, exclude locked items and distinguish own quota', async t => {
    const h = harness(t); const own = await h.service.getMapleMarket({ records: true });
    assert.equal(own.shop.price, '172'); assert.equal(own.shop.maxSell, '100');
    assert.equal(own.currency, h.currency); assert.equal(own.records[0].gid, self);
    assert.equal(own.goods[0].remaining, '2');
    const friend = await h.service.getMapleMarket({ targetGid: '9007199254740995' });
    assert.equal(friend.targetGid, '9007199254740995'); assert.equal(friend.shop.maxSell, '4');
});

test('stale price, friend quota and claimed seed reject without sending mutations', async t => {
    const h = harness(t);
    await assert.rejects(h.op('sell', { count: '10', expectedPrice: '171' }), /收购价已变化/);
    await assert.rejects(h.op('sell', { count: '10', expectedPrice: '172', targetGid: '99' }), /数量或目标额度/);
    h.body.daily_state.seed_claimed = true;
    await assert.rejects(h.op('claimSeed'), /已经领取/);
    assert.equal(h.writes.length, 0);
});

test('exchange checks daily and permanent limits, balances and price', async t => {
    const h = harness(t);
    await assert.rejects(h.op('exchange', { goodsId: '1', count: '3', expectedPrice: '100' }), /限购/);
    h.good.limit_type = 2;
    await assert.rejects(h.op('exchange', { goodsId: '1', count: '1', expectedPrice: '100' }), /限购/);
    h.good.limit_type = 0; h.currency = '99';
    await assert.rejects(h.op('exchange', { goodsId: '1', count: '1', expectedPrice: '100' }), /不足/);
    h.currency = '100';
    await assert.rejects(h.op('exchange', { goodsId: '1', count: '1', expectedPrice: '99' }), /价格已变化/);
    assert.equal(h.writes.length, 0);
});

test('official status 3 permits settlement exchange; ended status 2 never permits mutation', async t => {
    const h = harness(t); h.head.status = 2; h.now = 195000;
    await assert.rejects(h.op('exchange', { goodsId: '1', count: '1', expectedPrice: '100' }), /当前阶段/);
    h.head.status = 3;
    await assert.rejects(h.op('sell', { count: '1', expectedPrice: '172' }), /当前阶段/);
    const result = await h.op('exchange', { goodsId: '1', count: '1', expectedPrice: '100' });
    assert.equal(result.rewards[0].id, 204013); assert.equal(h.writes.length, 1);
});

test('confirmed operation replay never repeats mutation and fails changed reuse', async t => {
    const h = harness(t); const input = { count: '10', expectedPrice: '172' };
    await h.op('sell', input); h.reload();
    assert.equal((await h.op('sell', input)).replayed, true);
    await assert.rejects(h.op('sell', { ...input, count: '11' }), /同一操作标识/);
    assert.equal(h.writes.length, 1);
});

test('timeout persists an uncertain operation across reload and requires explicit acknowledgement', async t => {
    const h = harness(t); h.fail = 'timeout';
    await assert.rejects(h.op('sell', { count: '10', expectedPrice: '172' }), { outcomeUnknown: true });
    h.fail = ''; h.reload();
    assert.equal((await h.service.getMapleMarket()).pending.length, 1);
    await assert.rejects(h.op('claimSeed', { operationId: 'another-operation-0001' }), /待核对/);
    await assert.rejects(h.op('acknowledge', { confirmed: false }), /请先/);
    await h.op('acknowledge');
    assert.equal((await h.service.getMapleMarket()).pending.length, 0);
    assert.equal(h.writes.length, 1);
});

test('malformed replies retain protection and pre-send failures can be retried', async t => {
    const h = harness(t); h.fail = 'before';
    await assert.rejects(h.op('claimSeed'), /not connected/);
    assert.equal((await h.service.getMapleMarket()).pending.length, 0);
    h.fail = 'malformed';
    await assert.rejects(h.op('claimSeed'), { outcomeUnknown: true });
    assert.equal((await h.service.getMapleMarket()).pending.length, 1);
});

test('disk failure blocks writes; post-success refresh failure retains success', async t => {
    const h = harness(t); h.diskFail = true;
    await assert.rejects(h.op('claimSeed'), /disk full/); assert.equal(h.writes.length, 0);
    h.diskFail = false; h.fail = 'refresh';
    const result = await h.op('claimSeed');
    assert.equal(result.refreshRequired, true); assert.equal(result.rewards[0].count, '28');
    assert.equal(h.writes.length, 1);
});

test('unknown actions and invalid target identifiers never send mutations', async t => {
    const h = harness(t);
    await assert.rejects(h.op('__proto__'), /未知/);
    await assert.rejects(h.service.getMapleMarket({ targetGid: '9223372036854775808' }), /无效/);
    assert.equal(h.writes.length, 0);
});
