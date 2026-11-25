const test = require('node:test');
const assert = require('node:assert/strict');
const { readPushChannels } = require('../dist/config/push-channels');
const { normalizeNotificationTypes } = require('../dist/config/notification-types');

test('legacy offline reminder remains a configured channel after the multi-channel update', () => {
    const channels = readPushChannels({ channel: 'webhook', endpoint: 'https://example.invalid/hook', token: '', secret: '' });
    assert.equal(channels.length, 1);
    assert.equal(channels[0].channel, 'webhook');
    assert.equal(channels[0].enabled, true);
    assert.equal(normalizeNotificationTypes().offline, true);
});

test('new notification switches preserve disabled offline warnings while other channels remain independent', () => {
    const channels = readPushChannels({ channels: [
        { channel: 'webhook', endpoint: 'https://example.invalid/hook', enabled: true },
        { channel: 'pushplus', token: 'synthetic-token', enabled: false },
    ] });
    assert.equal(channels.length, 2);
    assert.equal(channels[1].enabled, false);
    assert.deepEqual(normalizeNotificationTypes({ offline: false, mysteryArrival: true, mysteryPurchase: false }), {
        offline: false, mysteryArrival: true, mysteryPurchase: false,
    });
});
