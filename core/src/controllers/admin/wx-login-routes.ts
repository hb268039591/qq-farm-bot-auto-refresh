import crypto from 'node:crypto';
import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
import { WxLoginService } from '../../services/wx-login/service';
import type { ScanStatus, WxLoginSession } from '../../services/wx-login/service';

export { };

const { createAuthRequired } = require('./middleware');

const TARGET_APP_ID = 'wx5306c5978fdb76e4';
const TASK_TTL_MS = 110_000;
type Status = ScanStatus | 'ready_for_code' | 'failed';
interface Task { id: string; createdAt: number; status: Status; session: WxLoginSession; qr: Buffer; code?: string; pending?: Promise<void>; }
const tasks = new Map<string, Task>();
const wxLogin = new WxLoginService();
const credentialTickets = new Map<string, { expiresAt: number; code: string; credentials: Record<string, string> }>();
function pruneCredentialTickets(): void {
    for (const [id, ticket] of credentialTickets) if (ticket.expiresAt <= Date.now()) credentialTickets.delete(id);
}
function createCredentialTicket(task: Task): string {
    pruneCredentialTickets();
    const id = crypto.randomBytes(32).toString('hex');
    credentialTickets.set(id, {
        expiresAt: Date.now() + 10 * 60_000,
        code: task.code || '',
        credentials: {
            wxid: task.session.openid || '', loginBuffer: task.session.loginBuffer || '',
            refreshtoken: task.session.refreshtoken || '', accesstoken: task.session.accesstoken || '',
        },
    });
    return id;
}
function peekCredentialTicket(id: string, code: string): Record<string, string> {
    pruneCredentialTickets();
    const ticket = credentialTickets.get(id);
    if (!ticket || !code || ticket.code !== code) throw new Error('微信扫码凭证已过期或与 Code 不匹配，请重新扫码');
    return { ...ticket.credentials };
}
function consumeCredentialTicket(id: string): void { credentialTickets.delete(id); }


function destroy(task: Task): void { wxLogin.destroy(task.session); task.code = undefined; tasks.delete(task.id); }
function publicTask(task: Task) { return { task_id: task.id, app_id: TARGET_APP_ID, status: task.status, expires_at: Math.floor((task.createdAt + TASK_TTL_MS) / 1000) }; }
function findTask(req: Request, res: Response): Task | null {
    const task = tasks.get(String(req.params.taskId || ''));
    if (!task || Date.now() - task.createdAt > TASK_TTL_MS) { if (task) destroy(task); res.status(404).json({ ok: false, error: 'Login task not found or expired' }); return null; }
    return task;
}
async function createTask(): Promise<Task> {
    const { session, qr } = await wxLogin.createQrSession();
    const task: Task = { id: crypto.randomBytes(32).toString('hex'), createdAt: Date.now(), status: 'waiting', session, qr };
    tasks.set(task.id, task);
    return task;
}
async function poll(task: Task): Promise<void> { if (task.status === 'authorized' || task.status === 'ready_for_code') return; task.status = await wxLogin.poll(task.session); }
async function confirm(task: Task): Promise<void> {
    if (task.status !== 'authorized') throw new Error('Waiting for scan authorization');
    await wxLogin.confirm(task.session);
    task.status = 'ready_for_code';
}
async function consumeCode(task: Task): Promise<void> { if (task.status !== 'ready_for_code') throw new Error('Login code is not ready'); task.code = await wxLogin.issueCode(task.session, TARGET_APP_ID); }

function mountWxLoginRoutes(app: Application, ctx: AdminContext): void {
    app.use('/api/wx-login', createAuthRequired(ctx));

    app.post('/api/wx-login/tasks', async (req, res) => { if (req.body?.app_id && req.body.app_id !== TARGET_APP_ID) return res.status(400).json({ ok: false, error: 'Unsupported app_id' }); try { const task = await createTask(); res.json({ ok: true, data: { ...publicTask(task), qr_url: `/api/wx-login/tasks/${task.id}/qr` } }); } catch (error: any) { res.status(502).json({ ok: false, error: error.message }); } });
    app.get('/api/wx-login/tasks/:taskId/qr', (req, res) => { const task = findTask(req, res); if (task) res.type('jpeg').send(task.qr); });
    app.delete('/api/wx-login/tasks/:taskId', (req, res) => {
        const task = tasks.get(String(req.params.taskId || ''));
        if (!task) return res.status(404).json({ ok: false, error: 'Login task not found or expired' });
        destroy(task);
        return res.json({ ok: true });
    });
    app.get('/api/wx-login/tasks/:taskId/status', async (req, res) => { const task = findTask(req, res); if (!task) return; try { if (!task.pending) task.pending = poll(task).finally(() => { task.pending = undefined; }); await task.pending; const data = publicTask(task); if (task.status === 'cancelled' || task.status === 'expired') destroy(task); res.json({ ok: true, data }); } catch (error: any) { task.status = 'failed'; destroy(task); res.status(502).json({ ok: false, error: error.message }); } });
    app.post('/api/wx-login/tasks/:taskId/confirm', async (req, res) => { const task = findTask(req, res); if (!task) return; try { if (!task.pending) task.pending = confirm(task).finally(() => { task.pending = undefined; }); await task.pending; res.json({ ok: true, data: publicTask(task) }); } catch (error: any) { task.status = 'failed'; destroy(task); res.status(502).json({ ok: false, error: error.message }); } });
    app.post('/api/wx-login/tasks/:taskId/code', async (req, res) => { const task = findTask(req, res); if (!task) return; try { if (!task.pending) task.pending = consumeCode(task).finally(() => { task.pending = undefined; }); await task.pending; const data = { wxCredentialTicket: createCredentialTicket(task), openid: task.session.openid, app_id: TARGET_APP_ID, code: task.code, nickname: task.session.nickname || '', err_msg: 'login:ok' }; destroy(task); res.json({ ok: true, data }); } catch (error: any) { task.status = 'failed'; destroy(task); res.status(502).json({ ok: false, error: error.message }); } });
}
module.exports = { mountWxLoginRoutes, peekCredentialTicket, consumeCredentialTicket };
