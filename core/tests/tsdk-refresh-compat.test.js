const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { TsdkRuntime } = require('../dist/utils/tsdk-runtime');

test('QQ host byte rollover accepts 255 to 0 while rejecting unrelated state changes', () => {
    const runtime = new TsdkRuntime({ platform: 'qq' });
    runtime.memory = new WebAssembly.Memory({ initial: 1 });
    const view = new Uint8Array(runtime.memory.buffer);
    const current = 17288;
    const reference = 17352;
    view[reference + 1] = 255;
    view[current + 1] = 0;
    assert.doesNotThrow(() => runtime.normalizeQqHostFeatureState());
    assert.equal(view[current + 1], 255);
    view[current + 2] = 1;
    assert.throws(() => runtime.normalizeQqHostFeatureState(), /布局/);
    runtime.destroy();
});

test('current QQ and WeChat WASM initialize and round-trip synthetic messages without game access', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-current-tsdk-'));
    const oldGet = https.get;
    const oldRequest = https.request;
    https.get = () => ({ on() { return this; } });
    https.request = () => ({ on() { return this; }, end() {} });
    try {
        for (const platform of ['qq', 'wx']) {
            const runtime = new TsdkRuntime({ platform, accountId: 'synthetic', dataDir: path.join(root, platform) });
            try {
                await runtime.init();
                runtime.bindUser('synthetic-compatibility-openid');
                assert.ok(runtime.getEncryptedInitInfo().length > 0);
                const data = Buffer.from('current-tsdk-compatible-with-code-refresh');
                const encrypted = runtime.transform(data, false);
                assert.notDeepEqual(encrypted, data);
                assert.deepEqual(runtime.transform(encrypted, true), data);
            } finally { runtime.destroy(); }
        }
    } finally {
        https.get = oldGet;
        https.request = oldRequest;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
