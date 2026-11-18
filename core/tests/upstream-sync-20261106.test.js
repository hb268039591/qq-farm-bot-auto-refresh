const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadProto, types } = require('../dist/utils/proto');
const { buildLandUpgradeDetail } = require('../dist/services/farm/land-upgrade');
const config = require('../dist/config/config');
const { TSDK_BUILDS } = require('../dist/utils/tsdk-runtime');

test('20261118 update keeps both protocol versions and audited WASM files aligned', () => {
    assert.equal(config.DEFAULT_CLIENT_VERSION, '1.17.0.4_20261117');
    assert.equal(config.DEFAULT_WX_CLIENT_VERSION, '1.17.0.4_20261117');
    const hashes = {
        qq: 'ab6eb0f0ee86ce8984b0c37a481ff51e7722961ff0b50a9f91e2fa9ff351ce74',
        wx: 'd14a4f5d59c8a27128019dbad25fe3cd3d5243dfc389eb9bcbb345efb1cebc9a',
    };
    for (const [platform, expected] of Object.entries(hashes)) {
        const build = TSDK_BUILDS[platform];
        const wasm = fs.readFileSync(path.join(__dirname, '../src/utils', build.file));
        assert.equal(crypto.createHash('sha256').update(wasm).digest('hex'), expected);
        assert.equal(build.sha256, expected);
    }
});

test('new land condition wire fields reach upgrade detail without losing required level or prices', async () => {
    await loadProto();
    const input = {
        id: 21, unlocked: true, level: 4, max_level: 6, could_upgrade: true,
        upgrade_condition: {
            preceeding_lands_count_need: 2, level_need: 150,
            items_need: [{ id: 1001, count: '450000000' }, { id: 1005, count: '18670' }],
        },
    };
    const wire = types.AllLandsReply.encode(types.AllLandsReply.create({ lands: [input] })).finish();
    const decoded = types.AllLandsReply.decode(wire).lands[0];
    const lands = new Map([[21, decoded], [22, { unlocked: true, level: 5 }]]);
    const detail = buildLandUpgradeDetail(decoded, lands);
    assert.equal(detail.needLevel, 150);
    assert.deepEqual(detail.costs.map(item => [item.id, item.count]), [['1001', '450000000'], ['1005', '18670']]);
    assert.equal(detail.precedingLands.required, 2);
    assert.equal(detail.precedingLands.owned, 2);
    assert.equal(detail.precedingLands.met, true);
    assert.equal(detail.unknown, false);
    assert.equal(detail.serverAllowed, true);
});

test('blue crystal land has its own level-six image and missing sibling conditions stay unconfirmed', () => {
    const detail = buildLandUpgradeDetail({
        id: 21, unlocked: true, level: 5, max_level: 6,
        upgrade_condition: { preceeding_lands_count_need: 24, level_need: 160, items_need: [] },
    });
    assert.equal(detail.next.level, 6);
    assert.equal(detail.next.image, '/land-assets/6.png');
    assert.equal(detail.precedingLands.met, null);
    assert.equal(detail.unknown, true);
    assert.ok(fs.existsSync(path.join(__dirname, '../../web/public/land-assets/6.png')));
});

test('ranch and muge protocol definitions load alongside the farm and retain large account ids', async () => {
    await loadProto();
    const enter = types.RanchEnterHomesteadRequest;
    const wire = enter.encode(enter.fromObject({ host_gid: '9007199254740993', reason: 2 })).finish();
    assert.equal(enter.decode(wire).host_gid.toString(), '9007199254740993');
    for (const name of ['RanchRanchDetail', 'MugeListReply', 'MugeOperateRequest', 'MugeOperateReply']) {
        assert.equal(typeof types[name]?.decode, 'function', name);
    }
    const { animalMap, facilityMap, itemMap } = require('../dist/services/ranch/model');
    assert.ok(animalMap.size > 0);
    assert.ok(facilityMap.size > 0);
    assert.ok(itemMap.size > 0);
});
