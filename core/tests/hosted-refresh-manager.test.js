const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function fixture() {
    const filename = path.resolve(__dirname, '../dist/runtime/worker-manager.js');
    const realRequire = createRequire(filename);
    let sessions = [];
    let finishList;
    let pauseList = false;
    const stopped = [];
    const timers = new Map();
    const account = { id: '1', name: 'test', platform: 'wx', createdAt: 100, code: 'new-code' };
    const key = JSON.stringify(['1', 100]);
    const ipc = {
        accountSessionKey: value => JSON.stringify([String(value.id), value.createdAt]),
        findAccountSession: (values, value) => values.find(s => s.accountKey === JSON.stringify([String(value.id), value.createdAt]) && s.platform === value.platform),
        listHostedSessions: async () => { if (pauseList) await new Promise(resolve => { finishList = resolve; }); return sessions; },
        stopHostedAccount: async (id, accountKey) => { stopped.push({ id, accountKey }); sessions = []; },
    };
    const context = {
        module: { exports: {} }, exports: {}, process, console, Buffer, setTimeout, clearTimeout,
        require: name => name === '../session/ipc' ? ipc : name === '../services/scheduler'
            ? { createScheduler: () => ({ clear: name => timers.delete(name), setTimeoutTask: (name, ms, fn) => timers.set(name, fn) }) }
            : realRequire(name),
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const children = [];
    class Child extends EventEmitter {
        messages = [];
        constructor() { super(); children.push(this); }
        postMessage(message) { this.messages.push(message); if (message.type === 'stop' || message.type === 'detach') queueMicrotask(() => this.emit('exit', 0)); }
        terminate() { this.emit('exit', 0); }
    }
    const workers = {};
    const recoveries = [];
    const manager = context.module.exports.createWorkerManager({
        WorkerThread: Child, processRef: { env: { FARM_SESSION_SOCKET: 'synthetic' } }, workerScriptPath: 'synthetic.js',
        workers, globalLogs: [], log() {}, addAccountLog() {},
        normalizeStatusForPanel: value => value, buildConfigSnapshotForAccount: () => ({}),
        triggerOfflineReminder() {}, getOfflineAutoDeleteMs: () => Infinity,
        addOrUpdateAccount() {}, deleteAccount() {},
        scheduleAutoRelogin: (id, reason) => { recoveries.push({ id, reason }); return true; },
    });
    return { manager, account, key, children, stopped, recoveries,
        hostSession: () => { sessions = [{ sessionId: 'existing-session', accountKey: key, platform: 'wx' }]; },
        pause: () => { pauseList = true; }, release: () => finishList(),
    };
}

test('managed resume attaches the matching hosted session and never supplies it as a boolean', async () => {
    const f = fixture();
    f.hostSession();
    assert.equal(await f.manager.resumeAccountWorker(f.account), true);
    const start = f.children[0].messages.find(m => m.type === 'start');
    assert.equal(start.config.sessionId, 'existing-session');
    assert.equal(start.config.accountKey, f.key);
    await f.manager.detachAllWorkers();
    assert.equal(f.stopped.length, 0);
    assert.equal(f.children[0].messages.at(-1).type, 'detach');
    assert.equal(f.recoveries.length, 0);
});

test('host lookup cancellation does not spawn a worker after the user stops', async () => {
    const f = fixture();
    f.hostSession(); f.pause();
    let active = true;
    const pending = f.manager.resumeAccountWorker(f.account, () => active);
    await new Promise(resolve => setImmediate(resolve));
    active = false; f.release();
    assert.equal(await pending, false);
    assert.equal(f.children.length, 0);
});

test('explicit managed stop closes the hosted account while backend detach keeps it alive', async () => {
    const f = fixture();
    f.hostSession();
    await f.manager.resumeAccountWorker(f.account);
    await f.manager.stopAccountWorker(f.account);
    assert.equal(f.stopped.length, 1);
    assert.equal(f.stopped[0].id, '1');
    assert.equal(f.stopped[0].accountKey, f.key);
    assert.equal(f.recoveries.length, 0);
});

test('managed fresh-code restart respects the stop guard after awaiting host closure', async () => {
    const f = fixture();
    f.hostSession();
    await f.manager.resumeAccountWorker(f.account);
    let active = true;
    const pending = f.manager.restartWorker(f.account, () => active);
    active = false;
    await pending;
    assert.equal(f.children.length, 1);
    assert.equal(f.stopped.length, 1);
});
