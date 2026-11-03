const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-routes-'));
process.env.FARM_DATA_DIR = dataDir;

const express = require('express');
const store = require('../dist/models/store');
const { WxLoginService } = require('../dist/services/wx-login/service');
const { mountWxLoginRoutes } = require('../dist/controllers/admin/wx-login-routes');
const { mountAccountRoutes } = require('../dist/controllers/admin/account-routes');
const { createAuthRequired } = require('../dist/controllers/admin/middleware');
const { createDataProvider } = require('../dist/runtime/data-provider');

test('scan -> one-use credential ticket -> persisted account -> settings and redacted HTTP responses', async t => {
    const savedMethods = new Map();
    for (const method of ['createQrSession', 'poll', 'confirm', 'issueCode']) savedMethods.set(method, WxLoginService.prototype[method]);
    let issue = 0;
    WxLoginService.prototype.createQrSession = async () => ({ session: { cookies: new Map(), uuid: 'qr' }, qr: Buffer.from('qr') });
    WxLoginService.prototype.poll = async () => 'authorized';
    WxLoginService.prototype.confirm = async session => Object.assign(session, {
        openid: 'openid', nickname: 'nickname', loginBuffer: 'private-buffer',
        refreshtoken: 'private-refresh', accesstoken: 'private-access',
    });
    WxLoginService.prototype.issueCode = async () => `scan-code-${++issue}`;
    const starts = [];
    const restarts = [];
    const reschedules = [];
    const workers = {};
    let revision = 0;
    const provider = createDataProvider({
        workers, globalLogs: [], accountLogs: [], store, getAccounts: store.getAccounts,
        callWorkerApi: async () => ({}), buildDefaultStatus: () => ({}),
        normalizeStatusForPanel: value => value, filterLogs: value => value,
        addAccountLog: () => {}, nextConfigRevision: () => ++revision,
        broadcastConfigToWorkers: () => {}, buildConfigSnapshotForAccount: store.getConfigSnapshot,
        startWorker: async (account, useExistingCode) => { starts.push({ account, useExistingCode }); return true; },
        stopWorker: () => {}, restartWorker: async (account, useExistingCode) => { restarts.push({ account, useExistingCode }); return true; },
        rescheduleAutoCodeRefresh: id => reschedules.push(id),
    });
    const ctx = { tokens: new Set(['test-admin']), provider };
    const app = express();
    app.use(express.json());
    app.use('/api', createAuthRequired(ctx));
    mountWxLoginRoutes(app, ctx);
    mountAccountRoutes(app, ctx);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (url, body, method = body ? 'POST' : 'GET') => {
        const response = await fetch(`${base}${url}`, { method,
            headers: { 'x-admin-token': 'test-admin', 'x-account-id': '1', 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: response.status, ...(await response.json()) };
    };
    async function scan() {
        const created = await request('/api/wx-login/tasks', {});
        const id = created.data.task_id;
        await request(`/api/wx-login/tasks/${id}/status`);
        await request(`/api/wx-login/tasks/${id}/confirm`, {});
        const response = await request(`/api/wx-login/tasks/${id}/code`, {});
        assert.equal(response.ok, true);
        for (const key of ['loginBuffer', 'refreshtoken', 'accesstoken']) assert.equal(response.data[key], undefined);
        assert.equal((await request(`/api/wx-login/tasks/${id}/status`)).status, 404);
        return response.data;
    }
    try {
        await t.test('scan credentials survive task destruction and are only bound to the issued code', async () => {
            const qr = await scan();
            const mismatch = await request('/api/accounts', { name: 'wrong-code', platform: 'wx', code: 'other', wxCredentialTicket: qr.wxCredentialTicket });
            assert.equal(mismatch.ok, false);
            assert.equal(store.getAccounts().accounts.length, 0);
            const created = await request('/api/accounts', { name: 'farm', platform: 'wx', code: qr.code, wxCredentialTicket: qr.wxCredentialTicket });
            assert.equal(created.ok, true);
            const account = store.getAccounts().accounts[0];
            assert.equal(account.loginBuffer, 'private-buffer');
            assert.equal(account.refreshtoken, 'private-refresh');
            assert.equal(starts[0].useExistingCode, true);
            assert.equal(starts[0].account.code, qr.code);
            assert.equal(created.data.accounts[0].refreshtoken, undefined);
            const replay = await request('/api/accounts', { name: 'replay', platform: 'wx', code: qr.code, wxCredentialTicket: qr.wxCredentialTicket });
            assert.equal(replay.ok, false);
            assert.equal(store.getAccounts().accounts.length, 1);
        });
        await t.test('account list does not expose stored credential material', async () => {
            const response = await request('/api/accounts');
            assert.equal(response.data.accounts[0].wxAutoRefreshAvailable, true);
            assert.doesNotMatch(JSON.stringify(response), /private-(buffer|refresh|access)/);
        });
        await t.test('stopped-account rescan with the same remark restarts using the new one-use code', async () => {
            const qr = await scan();
            const result = await request('/api/accounts', { name: 'farm', platform: 'wx', code: qr.code, wxCredentialTicket: qr.wxCredentialTicket });
            assert.equal(result.ok, true);
            assert.equal(store.getAccounts().accounts.length, 1);
            assert.equal(restarts[0].useExistingCode, true);
            assert.equal(restarts[0].account.code, qr.code);
        });
        await t.test('settings save reaches persistence and reschedules the manager', async () => {
            const result = await request('/api/settings/save', { autoCodeRefresh: { enabled: false, intervalMinutes: 23 } });
            assert.equal(result.ok, true);
            assert.deepEqual(result.data.autoCodeRefresh, { enabled: false, intervalMinutes: 23 });
            assert.deepEqual(reschedules, ['1']);
            const fetched = await request('/api/settings');
            assert.deepEqual(fetched.data.autoCodeRefresh, { enabled: false, intervalMinutes: 23 });
        });
        await t.test('unauthenticated calls cannot consume login tickets or read credentials', async () => {
            const response = await fetch(`${base}/api/accounts`);
            assert.equal(response.status, 401);
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        for (const [method, fn] of savedMethods) WxLoginService.prototype[method] = fn;
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
