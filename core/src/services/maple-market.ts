import catalog from '../activity-data/maple-market-20261125.json';
export {};
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getDataDir } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec } = require('../utils/utils');
const { getBag, getBagItems, isItemLocked } = require('./warehouse');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const GROUP = '2026111707';
const ACTIVITY = '2026111708';
const SERVICE = 'gamepb.activitypb.ActivityService';
const CONFIG = catalog.MapleMarketActivityConfig[0];
const OPERATIONS: Record<string, [number, string]> = {
    claimSeed: [91, 'maple_market_claim_seed'], shop: [92, 'maple_market_get_shop'],
    sell: [93, 'maple_market_sell'], boostLog: [94, 'maple_market_get_boost_log'],
    records: [95, 'maple_market_get_purchase_log'], exchange: [96, 'maple_market_exchange'],
    goods: [97, 'maple_market_get_goods_list'], claimCommission: [99, 'maple_market_claim_commission'],
};
let tail: Promise<any> = Promise.resolve();
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
function qty(value: any): string {
    const text = String(value ?? '0');
    if (!/^\d+$/.test(text)) fail('MAPLE_INVALID_REPLY', '活动回包包含无效数量，请刷新');
    return text;
}
function positive(value: any, label: string): string {
    const text = String(value ?? '').trim();
    if (!/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) fail('MAPLE_INVALID_INPUT', `${label}无效`);
    return text;
}
function item(value: any): any {
    const id = Number(value.id);
    const meta = catalog.items.find(row => row.id === id) || getItemById(id);
    return { id, count: qty(value.count), name: meta?.name || `物品 ${id}`, image: getItemImageById(id) || '', description: meta?.desc || '' };
}
function journal() {
    const accountId = String(process.env.FARM_ACCOUNT_ID || '');
    if (!accountId) fail('MAPLE_ACCOUNT_REQUIRED', '活动操作缺少账号标识');
    const file = path.join(getDataDir(), 'maple-market-operations', createHash('sha256').update(accountId).digest('hex') + '.json');
    const read = (): any[] => {
        if (!fs.existsSync(file)) return [];
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(rows) || rows.some(row => !row.id || !row.action || !['pending', 'done'].includes(row.status))) fail('MAPLE_JOURNAL_INVALID', '活动操作记录无法读取，请检查数据');
        return rows;
    };
    return { read, save: (rows: any[]) => writeJsonFileAtomic(file, rows) };
}
async function rpc(action: string, params: any = {}, onSent?: () => void): Promise<any> {
    const op = OPERATIONS[action];
    if (!op) fail('MAPLE_UNKNOWN_ACTION', '未知活动操作');
    const body = types.MapleOperateRequest.encode({ id: ACTIVITY, cmd: op[0], [op[1]]: params }).finish();
    const response = await sendMsgAsync(SERVICE, 'Operate', body, onSent ? { onSent } : {});
    const reply = types.MapleOperateReply.decode(response.body);
    if (String(reply.id) !== ACTIVITY || Number(reply.cmd) !== op[0] || !Object.hasOwn(reply, op[1])) fail('MAPLE_RESULT_UNKNOWN', '活动回包无法确认，请到游戏中核对，勿重复操作');
    return reply[op[1]];
}
async function baseState(): Promise<any> {
    const response = await sendMsgAsync(SERVICE, 'GetGroup', types.GetGroupRequest.encode({ group_id: GROUP }).finish());
    const group = types.MapleGetGroupReply.decode(response.body).group;
    if (String(group?.head?.id) !== GROUP) fail('MAPLE_UNAVAILABLE', '以薯换福活动暂不可用，请在游戏内确认');
    const activity = group.children.find((entry: any) => String(entry.head?.id) === ACTIVITY);
    if (!activity?.maple_market) fail('MAPLE_UNAVAILABLE', '以薯换福活动状态缺失');
    const head = activity.head;
    const now = getServerTimeSec();
    const start = Number(head.start_time); const end = Number(head.end_time); const settle = Number(head.settle_start_time);
    if (!start || !end || end <= start) fail('MAPLE_INVALID_REPLY', '活动时间无效，请刷新');
    const active = head.status === 1 && now >= start && now < end && !(settle > 0 && now >= settle);
    const settling = now >= start && now < end && (head.status === 3 || (head.status === 1 && settle > 0 && now >= settle));
    const bag = getBagItems(await getBag({ fresh: true }));
    const crop = bag.filter((row: any) => Number(row.id) === CONFIG.crop_item_id && !isItemLocked(row))
        .reduce((sum: bigint, row: any) => sum + BigInt(qty(row.count)), 0n).toString();
    let rules: string[] = [];
    try {
        const extra = JSON.parse(head.desc || '{}');
        rules = (extra.tips?.txt || []).filter((line: any) => typeof line === 'string').map((line: string) => line.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ''));
    } catch { rules = String(head.desc || '').split('\n').filter(Boolean); }
    return { activityId: ACTIVITY, groupId: GROUP, title: '以薯换福', now, start, end, settling, active,
        body: activity.maple_market, crop, rules, selfGid: positive(getUserState().gid, '当前账号 GID') };
}
function goodDto(row: any, state: any): any {
    const cfg = catalog.MapleMarketGoodsConfig.find(v => String(v.goods_id) === String(row.goods_id) && String(v.activity_id) === ACTIVITY);
    if (!cfg) return null;
    const type = Number(row.limit_type); const limit = BigInt(qty(row.limit_times));
    const used = type === 1 ? BigInt(qty(row.purchased_daily)) : BigInt(qty(row.purchased_total));
    const remaining = type === 0 ? null : (limit > used ? limit - used : 0n).toString();
    const price = qty(row.activity_coin_price);
    const day = Math.floor((state.now - state.start) / 86400) + 1;
    const items = cfg.maple_market_item_list.split(';').map(pair => { const [id, count] = pair.split(':'); return item({ id, count }); });
    return { id: String(row.goods_id), name: cfg.name, price, remaining, limitType: type, openDay: cfg.open_day,
        available: row.exchangeable === true && day >= cfg.open_day && (remaining === null || BigInt(remaining) > 0n), items };
}
async function readState(input: any = {}): Promise<any> {
    const state = await baseState();
    const targetGid = input.targetGid ? positive(input.targetGid, '目标 GID') : state.selfGid;
    const shop = (await rpc('shop', { target_gid: targetGid }));
    if (!shop.shop || (shop.shop.owner?.gid && String(shop.shop.owner.gid) !== targetGid)) fail('MAPLE_SHOP_MISMATCH', '小铺所属账号不匹配，请刷新');
    const goodsReply = await rpc('goods');
    const currency = qty(goodsReply.activity_coin);
    const goods = (goodsReply.goods || []).map((row: any) => goodDto(row, state)).filter(Boolean);
    let records: any[] | null = null;
    if (input.records === true || input.records === 'true') {
        records = (await rpc('records')).logs.map((row: any) => ({ time: qty(row.sell_time), name: row.seller_name || String(row.seller_gid),
            gid: qty(row.seller_gid), count: qty(row.sold_count), income: qty(row.activity_coin_income), commission: qty(row.owner_commission_activity_coin) }));
    }
    const basePrice = qty(shop.shop.base_price); const boost = qty(shop.shop.boost_value);
    const price = (BigInt(basePrice) + BigInt(boost)).toString();
    const self = targetGid === state.selfGid;
    const quota = qty(shop.shop.remain_quota);
    const maxSell = self ? state.crop : (BigInt(state.crop) < BigInt(quota) ? state.crop : quota);
    return { ...state, body: undefined, currency, goods, records, targetGid,
        cropItem: item({ id: CONFIG.crop_item_id, count: state.crop }), currencyItem: item({ id: CONFIG.activity_coin_item_id, count: currency }),
        seedItem: item({ id: CONFIG.seed_item_id, count: CONFIG.base_seed_count }), seedClaimed: state.body.daily_state?.seed_claimed === true,
        commission: qty(state.body.pending_commission_activity_coin), commissionCount: qty(state.body.pending_commission_count),
        shop: { self, owner: shop.shop.owner?.name || targetGid, price, basePrice, boost, quota, maxSell, canSell: state.active && shop.can_sell === true },
        pending: journal().read().filter(row => row.status === 'pending').map(({ id, action, createdAt, message }) => ({ id, action, createdAt, message })) };
}
async function perform(action: string, input: any): Promise<any> {
    const record = journal();
    if (action === 'acknowledge') {
        if (input.confirmed !== true) fail('MAPLE_CONFIRM_REQUIRED', '请先在游戏内核对结果');
        const rows = record.read(); const row = rows.find(v => v.id === input.operationId && v.status === 'pending');
        if (!row) fail('MAPLE_STATE_CHANGED', '待核对记录已变化');
        record.save(rows.filter(v => v.id !== row.id));
        return { activity: await readState(input), rewards: [], acknowledged: true };
    }
    if (!['claimSeed', 'sell', 'exchange', 'claimCommission'].includes(action)) fail('MAPLE_UNKNOWN_ACTION', '未知活动操作');
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(String(input.operationId || ''))) fail('MAPLE_INVALID_INPUT', '操作标识无效，请刷新');
    const rows = record.read();
    const repeated = rows.find(row => row.id === input.operationId);
    if (repeated && (repeated.action !== action || repeated.signature !== JSON.stringify([action, input.targetGid || '', input.count || '', input.goodsId || '']))) fail('MAPLE_DUPLICATE_CHANGED', '同一操作标识不能用于其他操作');
    if (repeated?.status === 'done') return { activity: await readState(input), rewards: repeated.rewards || [], replayed: true };
    if (rows.some(row => row.status === 'pending')) fail('MAPLE_PENDING', '存在结果待核对的活动操作，请先在游戏内核对');
    const state = await readState(input);
    if (!(state.active || (state.settling && action === 'exchange'))) fail('MAPLE_ENDED', '当前阶段不支持此操作');
    let params: any = {};
    if (action === 'claimSeed' && state.seedClaimed) fail('MAPLE_ALREADY_CLAIMED', '今日种子已经领取');
    if (action === 'claimCommission' && BigInt(state.commissionCount) === 0n) fail('MAPLE_NOT_CLAIMABLE', '当前没有待领取佣金');
    if (action === 'sell') {
        const count = positive(input.count, '出售数量');
        if (input.confirmed !== true || !state.shop.canSell || BigInt(count) > BigInt(state.shop.maxSell)) fail('MAPLE_SELL_UNAVAILABLE', '可出售数量或目标额度已变化，请刷新');
        if (qty(input.expectedPrice) !== state.shop.price) fail('MAPLE_PRICE_CHANGED', '收购价已变化，请重新确认');
        params = { target_gid: state.targetGid, sell_count: count };
    }
    if (action === 'exchange') {
        const count = positive(input.count, '兑换数量');
        const good = state.goods.find((row: any) => row.id === String(input.goodsId));
        if (input.confirmed !== true || !good?.available || (good.remaining !== null && BigInt(count) > BigInt(good.remaining))) fail('MAPLE_EXCHANGE_UNAVAILABLE', '商品未解锁、限购已满或剩余数量变化');
        if (qty(input.expectedPrice) !== good.price) fail('MAPLE_PRICE_CHANGED', '兑换价格已变化，请重新确认');
        if (BigInt(good.price) * BigInt(count) > BigInt(state.currency)) fail('MAPLE_BALANCE', '福气币不足');
        params = { goods_id: good.id, exchange_count: count };
    }
    const row = { id: input.operationId, action, status: 'pending', createdAt: Date.now(),
        signature: JSON.stringify([action, input.targetGid || '', input.count || '', input.goodsId || '']), message: '操作已提交，等待确认' };
    record.save([...rows.filter(v => v.status === 'pending'), ...rows.filter(v => v.status === 'done').slice(-30), row]);
    let sent = false;
    let rewards: any[] = [];
    try {
        const result = await rpc(action, params, () => { sent = true; });
        if (action === 'claimSeed') {
            if (Number(result.seed?.id) !== CONFIG.seed_item_id || BigInt(qty(result.seed?.count)) <= 0n) fail('MAPLE_RESULT_UNKNOWN', '领取种子结果无法确认');
            rewards = [item(result.seed)];
        } else if (action === 'sell') {
            if (BigInt(qty(result.sold_count)) > BigInt(params.sell_count)) fail('MAPLE_RESULT_UNKNOWN', '售出数量异常，请核对');
            rewards = [item({ id: CONFIG.activity_coin_item_id, count: result.activity_coin_income })];
        } else if (action === 'exchange') {
            if (!(result.items || []).length) fail('MAPLE_RESULT_UNKNOWN', '兑换奖励无法确认，请核对');
            rewards = result.items.map(item);
        } else rewards = [item({ id: CONFIG.activity_coin_item_id, count: result.activity_coin })];
        record.save(record.read().map(v => v.id === row.id ? { ...v, status: 'done', rewards } : v));
    } catch (error: any) {
        const rejected = !sent || (error.name === 'GatewayError' && error.serviceName === SERVICE && error.methodName === 'Operate');
        if (rejected) record.save(record.read().filter(v => v.id !== row.id));
        else error.outcomeUnknown = true;
        throw error;
    }
    try { return { activity: await readState(input), rewards }; }
    catch { return { activity: null, rewards, refreshRequired: true }; }
}
function operateMapleMarket(action: string, input: any = {}) {
    const pending = tail.then(() => perform(action, input)); tail = pending.catch(() => {}); return pending;
}
module.exports = { getMapleMarket: readState, operateMapleMarket };
