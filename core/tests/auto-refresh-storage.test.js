const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-refresh-storage-'));
process.env.FARM_DATA_DIR = dataDir;
const old = {
    id: '1', name: 'legacy', platform: 'wx', wxid: 'legacy-openid', code: 'old-code',
    loginBuffer: 'legacy-buffer', refreshtoken: 'legacy-refresh', accesstoken: 'legacy-access',
};
fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({ accounts: [old], nextId: 2 }));
fs.writeFileSync(path.join(dataDir, 'store.json'), JSON.stringify({
    accountConfigs: { '1': { automation: { farm: false }, autoCodeRefresh: { enabled: true, intervalMinutes: 17 } } },
}));
const store = require('../dist/models/store');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('old JS account credentials and auto-refresh config survive split-store migration', () => {
    const account = store.getAccounts().accounts[0];
    for (const key of ['wxid', 'loginBuffer', 'refreshtoken', 'accesstoken']) assert.equal(account[key], old[key]);
    assert.deepEqual(store.getConfigSnapshot('1').autoCodeRefresh, { enabled: true, intervalMinutes: 17 });
    assert.equal(store.getAutomation('1').farm, false);
    assert.ok(fs.existsSync(path.join(dataDir, 'account-configs', '.format.json')));
});

test('partial credential update never replaces a new token with a stale account copy', () => {
    store.addOrUpdateAccount({ id: '1', refreshtoken: 'renewed', accesstoken: 'renewed-access' });
    store.addOrUpdateAccount({ id: '1', code: 'fresh-game-code' });
    const account = store.getAccounts().accounts[0];
    assert.equal(account.refreshtoken, 'renewed');
    assert.equal(account.loginBuffer, 'legacy-buffer');
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    assert.equal(saved.accounts[0].refreshtoken, 'renewed');
});

test('auto-refresh settings persist, clamp invalid intervals, and retain false', () => {
    store.applyConfigSnapshot({ autoCodeRefresh: { enabled: false, intervalMinutes: 9999 } }, { accountId: '1' });
    assert.deepEqual(store.getConfigSnapshot('1').autoCodeRefresh, { enabled: false, intervalMinutes: 1440 });
    store.applyConfigSnapshot({ autoCodeRefresh: { enabled: false, intervalMinutes: 'not-a-number' } }, { accountId: '1' });
    const cfg = store.getConfigSnapshot('1').autoCodeRefresh;
    assert.equal(Number.isFinite(cfg.intervalMinutes), true);
    assert.equal(cfg.enabled, false);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'account-configs', '1.json'), 'utf8'));
    assert.deepEqual(saved.autoCodeRefresh, cfg);
});

test('new scanned accounts persist all credentials and default to automatic refresh', () => {
    const result = store.addOrUpdateAccount({ ...old, id: undefined, name: 'new' });
    const account = result.accounts.at(-1);
    assert.equal(account.refreshtoken, old.refreshtoken);
    assert.deepEqual(store.getConfigSnapshot(account.id).autoCodeRefresh, { enabled: true, intervalMinutes: 60 });
});
