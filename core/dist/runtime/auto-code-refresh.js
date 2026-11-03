"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const service_1 = require("../services/wx-login/service");
const { createScheduler } = require('../services/scheduler');
const TARGET_APP_ID = 'wx5306c5978fdb76e4';
/** Credential renewal lives in the manager process, never in game workers. */
function createAutoCodeRefreshService(deps) {
    const { store, log, addAccountLog, resolveWorkerControls } = deps;
    const wxLogin = deps.wxLogin || new service_1.WxLoginService();
    const scheduler = deps.scheduler || createScheduler('auto_code_refresh');
    const active = new Map();
    const operations = new Map();
    const refreshes = new Map();
    const pendingRelogins = new Set();
    const recoveries = new Map();
    const find = (id) => (store.getAccounts().accounts || []).find((a) => String(a.id) === id);
    const supported = (a) => a && a.platform === 'wx' && a.wxid && a.loginBuffer;
    const config = (id) => store.getConfigSnapshot(id).autoCodeRefresh || { enabled: true, intervalMinutes: 60 };
    const valid = (id, generation) => active.get(id) === generation && !!find(id);
    const fingerprint = (a) => JSON.stringify([a.platform, a.wxid, a.loginBuffer, a.refreshtoken, a.accesstoken]);
    function report(id, event, message, extra = {}) {
        const a = find(id);
        if (!a)
            return;
        addAccountLog(event, message, id, a.name, extra);
        log(event.endsWith('failed') ? '错误' : '系统', message, { accountId: id, accountName: a.name, ...extra });
    }
    function recovery(id) {
        // Match the deployment's configured timezone instead of the UTC date.
        const day = new Date().toLocaleDateString('en-CA');
        let state = recoveries.get(id);
        if (!state || state.day !== day) {
            state = { day, attempts: 0, failures: 0 };
            recoveries.set(id, state);
        }
        return state;
    }
    function blocked(id) {
        const s = recovery(id);
        return s.attempts >= 8 || s.failures >= 3;
    }
    async function locked(id, operation) {
        const previous = operations.get(id) || Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        operations.set(id, next);
        try {
            return await next;
        }
        finally {
            if (operations.get(id) === next)
                operations.delete(id);
        }
    }
    async function renew(id, generation) {
        if (!valid(id, generation))
            throw new Error('账号已停止或删除');
        let account = find(id);
        if (!supported(account))
            throw new Error('账号缺少微信扫码凭证，请重新扫码');
        if (!account.refreshtoken)
            return account;
        const before = fingerprint(account);
        const session = {
            cookies: new Map(), uuid: '', openid: account.wxid,
            loginBuffer: account.loginBuffer, refreshtoken: account.refreshtoken,
            accesstoken: account.accesstoken || '',
        };
        try {
            const refreshed = await wxLogin.refreshLoginBuffer(session);
            const latest = find(id);
            // A rescan or deletion supersedes this request. Never restore its
            // old credential set over a freshly authorized session.
            if (!latest || fingerprint(latest) !== before)
                throw new Error('微信凭证已更新，本次旧请求已取消');
            store.addOrUpdateAccount({ id, ...refreshed });
            account = find(id);
        }
        catch (error) {
            const latest = find(id);
            if (latest && fingerprint(latest) === before && (error.refreshtoken || error.accesstoken)) {
                store.addOrUpdateAccount({ id,
                    ...(error.refreshtoken ? { refreshtoken: error.refreshtoken } : {}),
                    ...(error.accesstoken ? { accesstoken: error.accesstoken } : {}),
                });
            }
            throw error;
        }
        if (!valid(id, generation))
            throw new Error('账号已停止，本次启动已取消');
        return account;
    }
    async function issue(id, generation) {
        const account = await renew(id, generation);
        const before = fingerprint(account);
        const code = await wxLogin.issueCode({ loginBuffer: account.loginBuffer }, TARGET_APP_ID);
        if (!valid(id, generation) || fingerprint(find(id)) !== before)
            throw new Error('账号已停止或凭证已更新，本次换码已取消');
        if (!code)
            throw new Error('微信未返回登录 Code');
        store.addOrUpdateAccount({ id, code });
        return find(id);
    }
    function launch(account, generation) {
        const id = String(account.id);
        if (!valid(id, generation))
            return false;
        const controls = resolveWorkerControls();
        if (controls.hasWorker?.(id)) {
            controls.restartWorker(account, () => valid(id, generation));
            return true;
        }
        return controls.startWorker(account);
    }
    function schedule(id) {
        scheduler.clear(`refresh_${id}`);
        scheduler.clear(`keepalive_${id}`);
        const a = find(id);
        if (!active.has(id) || !supported(a))
            return;
        if (a.refreshtoken) {
            scheduler.setIntervalTask(`keepalive_${id}`, 30 * 60_000, async () => {
                const generation = active.get(id);
                try {
                    await locked(id, () => renew(id, generation));
                    report(id, 'wx_credential_keepalive', '微信凭证续期成功');
                }
                catch (error) {
                    if (valid(id, generation))
                        report(id, 'wx_credential_keepalive_failed', `微信凭证续期失败: ${error.message}`);
                }
            }, { preventOverlap: true });
        }
        const cfg = config(id);
        if (cfg.enabled)
            scheduler.setIntervalTask(`refresh_${id}`, cfg.intervalMinutes * 60_000, () => refreshAccountCode(id, 'timer'), { preventOverlap: true });
    }
    function refreshAccountCode(accountId, reason = 'manual') {
        const id = String(accountId);
        const current = refreshes.get(id);
        if (current)
            return current;
        const request = refreshCode(id, reason).finally(() => {
            if (refreshes.get(id) === request)
                refreshes.delete(id);
        });
        refreshes.set(id, request);
        return request;
    }
    async function refreshCode(accountId, reason) {
        const id = String(accountId);
        const generation = active.get(id);
        if (!generation || !supported(find(id)))
            return false;
        return locked(id, async () => {
            if (!valid(id, generation) || (reason !== 'manual' && !config(id).enabled))
                return false;
            const controls = resolveWorkerControls();
            const recovering = reason !== 'timer' || !controls.isRunning(id);
            if (recovering && blocked(id)) {
                report(id, 'auto_relogin_blocked', '自动重登已暂停：连续失败 3 次或今日恢复已达 8 次，请检查网络或重新扫码');
                return false;
            }
            if (recovering)
                recovery(id).attempts++;
            try {
                const account = await issue(id, generation);
                if (!valid(id, generation) || (reason !== 'manual' && !config(id).enabled))
                    return false;
                scheduler.clear(`relogin_${id}`);
                pendingRelogins.delete(id);
                controls.restartWorker(account, () => valid(id, generation));
                recovery(id).failures = 0;
                report(id, 'auto_code_refresh', '自动刷新 Code 成功，正在重新登录', { reason });
                return true;
            }
            catch (error) {
                if (!valid(id, generation))
                    return false;
                recovery(id).failures++;
                report(id, 'auto_code_refresh_failed', `自动刷新 Code 失败: ${error.message}`, { reason });
                if (recovering)
                    scheduleRelogin(id, 'refresh_failed');
                return false;
            }
        });
    }
    function scheduleRelogin(accountId, reason = 'offline') {
        const id = String(accountId);
        if (!active.has(id) || !supported(find(id)) || !config(id).enabled)
            return false;
        if (pendingRelogins.has(id))
            return true;
        if (blocked(id)) {
            report(id, 'auto_relogin_blocked', '自动重登已暂停，请检查网络或重新扫码');
            return false;
        }
        // A single delayed recovery per account; duplicate terminal IPC events
        // do not postpone it or issue concurrent one-use game codes.
        pendingRelogins.add(id);
        scheduler.setTimeoutTask(`relogin_${id}`, 60_000, () => {
            pendingRelogins.delete(id);
            return refreshAccountCode(id, reason);
        });
        report(id, 'auto_relogin_scheduled', '掉线后将在 1 分钟后自动换码重登', { reason });
        return true;
    }
    async function startAccount(account, useExistingCode = false) {
        const id = String(account.id);
        if (resolveWorkerControls().isRunning(id))
            return false;
        const generation = {};
        active.set(id, generation);
        recoveries.delete(id);
        schedule(id);
        if (!supported(account) || useExistingCode)
            return launch(account, generation);
        return locked(id, async () => {
            try {
                const fresh = await issue(id, generation);
                if (!valid(id, generation))
                    return false;
                return launch(fresh, generation);
            }
            catch (error) {
                if (!valid(id, generation))
                    return false;
                report(id, 'auto_code_refresh_failed', `启动前刷新 Code 失败: ${error.message}`);
                scheduleRelogin(id, 'refresh_failed');
                return false;
            }
        });
    }
    async function restartAccount(account, useExistingCode = false) {
        const id = String(account.id);
        stopAccount(id);
        resolveWorkerControls().stopWorker(id);
        const generation = {};
        active.set(id, generation);
        recoveries.delete(id);
        schedule(id);
        return locked(id, async () => {
            try {
                const fresh = supported(account) && !useExistingCode ? await issue(id, generation) : find(id);
                if (!fresh || !valid(id, generation))
                    return false;
                resolveWorkerControls().restartWorker(fresh, () => valid(id, generation));
                return true;
            }
            catch (error) {
                if (valid(id, generation)) {
                    report(id, 'auto_code_refresh_failed', `重启前刷新 Code 失败: ${error.message}`);
                    scheduleRelogin(id, 'refresh_failed');
                }
                return false;
            }
        });
    }
    function stopAccount(accountId) {
        const id = String(accountId);
        active.delete(id);
        pendingRelogins.delete(id);
        for (const prefix of ['refresh', 'keepalive', 'relogin'])
            scheduler.clear(`${prefix}_${id}`);
    }
    function rescheduleAccount(accountId) {
        const id = String(accountId);
        schedule(id);
        if (!config(id).enabled) {
            scheduler.clear(`relogin_${id}`);
            pendingRelogins.delete(id);
        }
        else if (active.has(id) && !resolveWorkerControls().isRunning(id)) {
            scheduleRelogin(id, 'settings_enabled');
        }
    }
    function stopAll() { active.clear(); pendingRelogins.clear(); scheduler.clearAll(); }
    return { startAccount, restartAccount, stopAccount, rescheduleAccount, scheduleRelogin, refreshAccountCode, stopAll };
}
module.exports = { createAutoCodeRefreshService };
//# sourceMappingURL=auto-code-refresh.js.map