const assert = require('node:assert/strict');
const test = require('node:test');

const {
    runExclusiveAutomationTask,
} = require('../dist/services/automation-lock');

test('automation lock serializes top-level tasks', async () => {
    let active = 0;
    let maxActive = 0;

    const task = async (delay) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, delay));
        active -= 1;
    };

    await Promise.all([
        runExclusiveAutomationTask('task-a', () => task(15)),
        runExclusiveAutomationTask('task-b', () => task(5)),
        runExclusiveAutomationTask('task-c', () => task(10)),
    ]);

    assert.equal(maxActive, 1);
});

test('automation lock allows nested calls in the same task', async () => {
    let active = 0;
    let maxActive = 0;

    await runExclusiveAutomationTask('outer', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await runExclusiveAutomationTask('inner', async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
        });
        active -= 1;
    });

    assert.equal(maxActive, 2);
});

test('a delayed callback with an expired async lock context queues behind a live task', async () => {
    const events = [];
    let trigger;
    let completion;
    const ready = new Promise(resolve => { trigger = resolve; });
    await runExclusiveAutomationTask('original', () => {
        completion = ready.then(() => runExclusiveAutomationTask('late', () => events.push('late')));
    });
    let release;
    const blocker = runExclusiveAutomationTask('live', async () => {
        events.push('live-start');
        await new Promise(resolve => { release = resolve; });
        events.push('live-end');
    });
    await new Promise(resolve => setImmediate(resolve));
    trigger();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['live-start']);
    release();
    await Promise.all([blocker, completion]);
    assert.deepEqual(events, ['live-start', 'live-end', 'late']);
});

test('detached work scheduled inside an active task waits for that task to release', async () => {
    const events = [];
    let detached;
    await runExclusiveAutomationTask('parent', async () => {
        events.push('parent-start');
        detached = runExclusiveAutomationTask('continuation', () => events.push('continuation'), { detached: true });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(events, ['parent-start']);
        events.push('parent-end');
    });
    await detached;
    assert.deepEqual(events, ['parent-start', 'parent-end', 'continuation']);
});
