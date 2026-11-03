const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

function load(fetchImpl, failAfterConnect = false) {
    const filename = path.resolve(__dirname, '../dist/services/wx-login/native-protocol.js');
    const realRequire = createRequire(filename);
    const attempts = [];
    const sockets = [];
    const net = { createConnection: target => {
        attempts.push(target);
        const s = new EventEmitter();
        s.destroyed = false;
        s.destroy = () => { s.destroyed = true; s.emit('close'); };
        s.write = (_, callback) => {
            callback();
            if (failAfterConnect) s.emit('error', new Error('synthetic connection error'));
            else s.emit('data', Buffer.from([0x16, 0xf1, 0x03, 0x00, 0x01, 0x00]));
            return true;
        };
        sockets.push(s);
        setImmediate(() => s.emit('connect'));
        return s;
    } };
    const sandbox = {
        require: name => name === 'node:net' ? net : realRequire(name),
        exports: {}, Buffer, process, console, setTimeout, clearTimeout,
        AbortSignal, fetch: fetchImpl,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return { issue: sandbox.exports.getNativeWxLoginCode, attempts, sockets };
}

// Minimal synthetic protobuf credentials: ticket='x', device='d'. All sockets
// are mocked; no WeChat credentials or network requests are involved.
const buffer = Buffer.from([0x0a, 1, 0x78, 0x12, 1, 0x64]).toString('base64');

test('native retry prefers the old fast ports, preserves new DNS ports and destroys failed sockets', async () => {
    const f = load(async () => ({ json: async () => ({ dns: { domainlist: [{
        name: 'longcloud.weixin.com', iplist: [{ ip: '192.0.2.1' }],
        protocollist: [{ name: 'mmtlsovertcp', portlist: [80, 9000, 443, 8080, 5000] }],
    }] } }) }));
    await assert.rejects(f.issue(buffer, 'app'), /Unable to establish/);
    assert.deepEqual(f.attempts.map(a => a.port), [8080, 443, 5000, 9000, 80]);
    assert.equal(f.sockets.every(s => s.destroyed), true);
});

test('HTTPDNS failures use the built-in fallback and close sockets after connected errors', async () => {
    const f = load(async () => { throw new Error('DNS unavailable'); }, true);
    await assert.rejects(f.issue(buffer, 'app'), /synthetic connection error/);
    assert.equal(f.attempts[0].port, 8080);
    assert.equal(f.sockets.length, 1);
    assert.equal(f.sockets[0].destroyed, true);
});
