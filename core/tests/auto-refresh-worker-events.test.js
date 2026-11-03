const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWorkerManager } = require('../dist/runtime/worker-manager');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../dist/services/scheduler');

function fixture() {
    const children = [];
    class Child extends EventEmitter {
        constructor() { super(); children.push(this); }
        postMessage() {}
        terminate() { this.emit('exit', 0); }
    }
    const workers = {};
    const recoveries = [];
    const manager = createWorkerManager({
        WorkerThread: Child, processRef: process, workerScriptPath: 'synthetic.js',
        workers, globalLogs: [], log() {}, addAccountLog() {},
        normalizeStatusForPanel: value => value, buildConfigSnapshotForAccount: () => ({}),
        triggerOfflineReminder() {}, getOfflineAutoDeleteMs: () => Infinity,
        addOrUpdateAccount() {}, deleteAccount() {},
        scheduleAutoRelogin: (id, reason) => { recoveries.push({ id, reason }); return true; },
    });
    const account = { id: '1', name: 'farm', platform: 'wx', code: 'code' };
    manager.startWorker(account);
    return { manager, children, workers, recoveries, account };
}
test.afterEach(() => createScheduler('worker_manager').clearAll());

test('kickout IPC event stops worker and schedules exactly one recovery', () => {
    const f = fixture();
    f.children[0].emit('message', { type: 'account_kicked', reason: 'other login', reasonCode: 1 });
    f.children[0].emit('message', { type: 'account_disconnected', reason: 'duplicate' });
    assert.deepEqual(f.recoveries, [{ id: '1', reason: 'kickout:other login' }]);
    assert.equal(f.workers['1'].stopping, true);
    f.children[0].emit('exit', 0);
    assert.equal(f.recoveries.length, 1);
});

test('terminal websocket disconnect schedules recovery with connection diagnostics', () => {
    const f = fixture();
    f.children[0].emit('message', { type: 'account_disconnected', source: 'ws_error', phase: 'login', code: 400, reason: 'expired' });
    assert.deepEqual(f.recoveries, [{ id: '1', reason: 'disconnect:ws_error:login:400' }]);
    assert.equal(f.workers['1'].stopping, true);
});

test('unexpected worker exit schedules recovery; manual stop does not', () => {
    const f = fixture();
    f.children[0].emit('exit', 1);
    assert.deepEqual(f.recoveries, [{ id: '1', reason: 'worker_exit:1' }]);
    f.manager.startWorker(f.account);
    f.manager.stopWorker('1');
    f.children[1].emit('exit', 0);
    assert.equal(f.recoveries.length, 1);
});

test('user stop cancels an already requested deferred worker restart', () => {
    const f = fixture();
    let active = true;
    f.manager.restartWorker(f.account, () => active);
    active = false;
    f.manager.stopWorker('1');
    f.children[0].emit('exit', 0);
    assert.equal(f.children.length, 1);
    assert.equal(f.workers['1'], undefined);
    assert.equal(f.recoveries.length, 0);
});
