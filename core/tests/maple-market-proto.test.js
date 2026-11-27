const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const protobuf = require('protobufjs');
const { fixtures } = require('./fixtures/maple-market-official.json');
const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/maple-market.proto'), { keepCase: true });

test('maple protocol matches independently captured official package 87 encoder vectors', () => {
    for (const fixture of fixtures) {
        const type = root.lookupType('gamepb.maplepb.' + fixture.type);
        const expected = type.fromObject(fixture.data);
        assert.equal(Buffer.from(type.encode(expected).finish()).toString('hex'), fixture.hex);
        const actual = type.decode(Buffer.from(fixture.hex, 'hex'));
        assert.deepEqual(type.toObject(actual, { longs: String }), type.toObject(expected, { longs: String }));
    }
});

test('new activity seed is plantable and activity currency stays conditional during the event', () => {
    const { getPlantBySeedId, getItemById, getEffectiveSellInfo, getItemImageById } = require('../dist/config/gameConfig');
    const plant = getPlantBySeedId(20307);
    assert.equal(plant.id, 1020307); assert.equal(plant.fruit.id, 40307);
    const active = { nowSec: 150, activityWindowsLoaded: true, activityWindows: new Map([['2026111708', { beginTime: 100, endTime: 200 }]]) };
    for (const id of [1032, 1033, 20307]) {
        assert.ok(getItemById(id));
        assert.equal(getEffectiveSellInfo(id, active).sellable, false);
        assert.ok(getItemImageById(id).endsWith(`/${id}.png`));
    }
    assert.equal(getEffectiveSellInfo(1032, { ...active, nowSec: 201 }).sellable, true);
});
