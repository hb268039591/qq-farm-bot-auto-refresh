const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoCodeRefreshService } = require('../dist/runtime/auto-code-refresh');

function fixture(options = {}) {
    let accounts = [{ id: '1', name: 'farm', platform: 'wx', wxid: 'openid',
        code: 'scan-code', loginBuffer: 'buffer-0', refreshtoken: 'refresh-0', accesstoken: 'access-0' }];
    const tasks = new Map();
    const events = [];
    const starts = [];
    const restarts = [];
    const writes = [];
    const cfg = { enabled: true, intervalMinutes: 60 };
    let running = false;
    let seq = 0;
    const scheduler = {
        clear: name => tasks.delete(name), clearAll: () => tasks.clear(),
        setIntervalTask: (name, ms, fn) => tasks.set(name, { ms, fn, kind: 'interval' }),
        setTimeoutTask: (name, ms, fn) => tasks.set(name, { ms, fn, kind: 'timeout' }),
    };
    const store = {
        getAccounts: () => ({ accounts: accounts.map(a => ({ ...a })) }),
        getConfigSnapshot: () => ({ autoCodeRefresh: { ...cfg } }),
        addOrUpdateAccount: patch => {
            writes.push({ ...patch });
            accounts = accounts.map(a => a.id === patch.id ? { ...a, ...patch } : a);
        },
    };
    const wxLogin = {
        refreshLoginBuffer: async session => {
            events.push(['renew', session.refreshtoken]);
            const n = ++seq;
            return { loginBuffer: `buffer-${n}`, refreshtoken: `refresh-${n}`, accesstoken: `access-${n}` };
        },
        issueCode: async session => { events.push(['code', session.loginBuffer]); return `code-${seq}`; },
        ...options.wxLogin,
    };
    const service = createAutoCodeRefreshService({ store, scheduler, wxLogin,
        log: () => {}, addAccountLog: (...args) => events.push(['log', ...args]),
        resolveWorkerControls: () => ({
            isRunning: () => running,
            startWorker: account => { running = true; starts.push({ ...account }); return true; },
            stopWorker: () => { running = false; },
            restartWorker: (account, shouldRestart) => { if (shouldRestart()) { running = true; restarts.push({ ...account }); } },
        }),
    });
    return { service, tasks, cfg, events, starts, restarts, writes, store, wxLogin,
        get account() { return accounts[0]; },
        setRunning: value => { running = value; },
        remove: () => { accounts = []; },
        run: async name => {
            const task = tasks.get(name);
            assert.ok(task, `missing task: ${name}`);
            if (task.kind === 'timeout') tasks.delete(name);
            return task.fn();
        },
    };
}

test('scan code is used once, credentials renew every 30 minutes and next refresh uses rolled tokens', async () => {
    const f = fixture();
    assert.equal(await f.service.startAccount(f.account, true), true);
    assert.equal(f.starts[0].code, 'scan-code');
    assert.equal(f.tasks.get('keepalive_1').ms, 30 * 60_000);
    assert.equal(f.tasks.get('refresh_1').ms, 60 * 60_000);
    await f.run('keepalive_1');
    await f.run('refresh_1');
    assert.deepEqual(f.events.filter(e => e[0] === 'renew'), [['renew', 'refresh-0'], ['renew', 'refresh-1']]);
    assert.equal(f.account.refreshtoken, 'refresh-2');
    assert.equal(f.restarts[0].refreshtoken, 'refresh-2');
    assert.equal(f.restarts[0].code, 'code-2');
});

test('kickout schedules one recovery after one minute and fetches a fresh code', async () => {
    const f = fixture();
    await f.service.startAccount(f.account, true);
    f.setRunning(false);
    assert.equal(f.service.scheduleRelogin('1', 'kickout:manual-login'), true);
    const task = f.tasks.get('relogin_1');
    f.service.scheduleRelogin('1', 'disconnect:duplicate');
    assert.equal(f.tasks.get('relogin_1'), task);
    assert.equal(task.ms, 60_000);
    await f.run('relogin_1');
    assert.equal(f.restarts.length, 1);
    assert.equal(f.restarts[0].code, 'code-1');
});

test('stopping a disconnected account cancels every automatic task', async () => {
    const f = fixture();
    await f.service.startAccount(f.account, true);
    f.service.scheduleRelogin('1', 'kickout:test');
    f.service.stopAccount('1');
    assert.equal(f.tasks.size, 0);
    assert.equal(f.service.scheduleRelogin('1'), false);
    assert.equal(await f.service.refreshAccountCode('1'), false);
    assert.equal(f.restarts.length, 0);
});

test('stop during network renewal preserves rolled credentials without restarting', async () => {
    const f = fixture();
    await f.service.startAccount(f.account, true);
    let finish;
    f.wxLogin.refreshLoginBuffer = () => new Promise(resolve => { finish = resolve; });
    const pending = f.service.refreshAccountCode('1');
    await new Promise(resolve => setImmediate(resolve));
    f.service.stopAccount('1');
    finish({ loginBuffer: 'new-buffer', refreshtoken: 'new-refresh', accesstoken: 'new-access' });
    assert.equal(await pending, false);
    assert.equal(f.account.refreshtoken, 'new-refresh');
    assert.equal(f.restarts.length, 0);
});

test('a rescan supersedes in-flight old credentials', async () => {
    const f = fixture();
    await f.service.startAccount(f.account, true);
    let finish;
    f.wxLogin.refreshLoginBuffer = () => new Promise(resolve => { finish = resolve; });
    const pending = f.service.refreshAccountCode('1');
    await new Promise(resolve => setImmediate(resolve));
    f.store.addOrUpdateAccount({ id: '1', loginBuffer: 'scan-2-buffer', refreshtoken: 'scan-2-refresh' });
    finish({ loginBuffer: 'stale-buffer', refreshtoken: 'stale-refresh', accesstoken: 'stale-access' });
    assert.equal(await pending, false);
    assert.equal(f.account.refreshtoken, 'scan-2-refresh');
    assert.equal(f.restarts.length, 0);
});

test('refresh and keepalive serialize credential access, duplicate refresh requests share a result', async () => {
    const f = fixture();
    await f.service.startAccount(f.account, true);
    let finish;
    const original = f.wxLogin.refreshLoginBuffer;
    let calls = 0;
    f.wxLogin.refreshLoginBuffer = async session => {
        calls++;
        if (calls === 1) await new Promise(resolve => { finish = resolve; });
        return original(session);
    };
    const first = f.service.refreshAccountCode('1');
    const second = f.service.refreshAccountCode('1');
    assert.equal(first, second);
    const keepalive = f.run('keepalive_1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    finish();
    await Promise.all([first, second, keepalive]);
    assert.deepEqual(f.events.filter(e => e[0] === 'renew'), [['renew', 'refresh-0'], ['renew', 'refresh-1']]);
    assert.equal(f.restarts.length, 1);
});

test('rotated tokens survive a failed login-buffer request', async () => {
    const f = fixture({ wxLogin: { refreshLoginBuffer: async () => {
        throw Object.assign(new Error('buffer request failed'), { refreshtoken: 'rotated-refresh', accesstoken: 'rotated-access' });
    } } });
    await f.service.startAccount(f.account, true);
    assert.equal(await f.service.refreshAccountCode('1'), false);
    assert.equal(f.account.refreshtoken, 'rotated-refresh');
    assert.equal(f.account.accesstoken, 'rotated-access');
    assert.equal(f.restarts.length, 0);
});

test('three failed recovery attempts stop retries including the periodic timer', async () => {
    const f = fixture({ wxLogin: { refreshLoginBuffer: async () => { throw new Error('offline'); } } });
    await f.service.startAccount(f.account, true);
    f.setRunning(false);
    f.service.scheduleRelogin('1', 'kickout:test');
    for (let n = 0; n < 3; n++) await f.run('relogin_1');
    assert.equal(f.tasks.has('relogin_1'), false);
    const writes = f.writes.length;
    assert.equal(await f.run('refresh_1'), false);
    assert.equal(f.writes.length, writes);
    assert.equal(f.restarts.length, 0);
});

test('daily recovery limit counts successful recoveries and stops the ninth', async () => {
    const f = fixture();
    await f.service.startAccount(f.account, true);
    for (let n = 0; n < 8; n++) {
        f.setRunning(false);
        assert.equal(f.service.scheduleRelogin('1', 'kickout:test'), true);
        assert.equal(await f.run('relogin_1'), true);
    }
    f.setRunning(false);
    assert.equal(f.service.scheduleRelogin('1', 'kickout:test'), false);
    assert.equal(await f.run('refresh_1'), false);
    assert.equal(f.restarts.length, 8);
});

test('disabling refresh removes recovery and refresh timers but preserves credential keepalive', async () => {
    const f = fixture();
    await f.service.startAccount(f.account, true);
    f.service.scheduleRelogin('1', 'kickout:test');
    f.cfg.enabled = false;
    f.service.rescheduleAccount('1');
    assert.equal(f.tasks.has('refresh_1'), false);
    assert.equal(f.tasks.has('relogin_1'), false);
    assert.equal(f.tasks.has('keepalive_1'), true);
    assert.equal(f.service.scheduleRelogin('1'), false);
});

test('plain QQ/code accounts never make WeChat refresh calls', async () => {
    const f = fixture();
    f.store.addOrUpdateAccount({ id: '1', platform: 'qq' });
    assert.equal(await f.service.startAccount(f.account), true);
    assert.equal(f.tasks.size, 0);
    assert.equal(f.service.scheduleRelogin('1'), false);
    assert.equal(await f.service.refreshAccountCode('1'), false);
    assert.equal(f.events.some(e => e[0] === 'renew'), false);
});

test('enabling auto refresh recovers an active offline account, while stopped accounts stay stopped', async () => {
    const f = fixture();
    await f.service.startAccount(f.account, true);
    f.cfg.enabled = false;
    f.service.rescheduleAccount('1');
    f.setRunning(false);
    f.cfg.enabled = true;
    f.service.rescheduleAccount('1');
    assert.equal(f.tasks.has('relogin_1'), true);
    await f.run('relogin_1');
    assert.equal(f.restarts.length, 1);
    f.service.stopAccount('1');
    f.service.rescheduleAccount('1');
    assert.equal(f.tasks.size, 0);
});

test('deleting during renewal cannot recreate the account', async () => {
    const f = fixture();
    await f.service.startAccount(f.account, true);
    let finish;
    f.wxLogin.refreshLoginBuffer = () => new Promise(resolve => { finish = resolve; });
    const pending = f.service.refreshAccountCode('1');
    await new Promise(resolve => setImmediate(resolve));
    f.service.stopAccount('1');
    f.remove();
    finish({ loginBuffer: 'new-buffer', refreshtoken: 'new-refresh' });
    assert.equal(await pending, false);
    assert.equal(f.account, undefined);
    assert.equal(f.writes.length, 0);
    assert.equal(f.restarts.length, 0);
});
