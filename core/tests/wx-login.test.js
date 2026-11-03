const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { WxLoginService } = require('../dist/services/wx-login/service');

test('WeChat confirm fetches user info and uses nick_name for the session nickname', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    const responses = [
        '{}',
        JSON.stringify({ code: 0, ext_info: { list_s: { login_buffer: { value: ['login-buffer'] } } } }),
        JSON.stringify({ code: 0, nick_name: 'wechat-nickname', head_img_url: 'https://example.test/avatar.jpg' }),
    ];

    global.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const body = responses.shift();
        assert.notEqual(body, undefined);
        return {
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => Buffer.from(body),
        };
    };

    try {
        const session = {
            cookies: new Map([
                ['openid', 'openid-value'],
                ['accesstoken', 'access-token-value'],
                ['refreshtoken', 'refresh-token-value'],
            ]),
            uuid: 'uuid',
            oauthCode: 'oauth-code',
        };

        await new WxLoginService().confirm(session);

        assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
            '/pc_yyb/pcyyb_oauth',
            '/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth',
            '/pc_yyb/pcyyb_get_user_info',
        ]);
        assert.equal(session.nickname, 'wechat-nickname');
        assert.equal(session.refreshtoken, 'refresh-token-value');
        assert.equal(session.accesstoken, 'access-token-value');
        assert.equal(session.loginBuffer, 'login-buffer');
        const infoHeaders = calls[2].init.headers;
        const timestamp = infoHeaders.get('Ual-Access-Timestamp');
        const nonce = infoHeaders.get('Ual-Access-Nonce');
        assert.equal(infoHeaders.get('Ual-Access-Access-Token'), 'access-token-value');
        assert.equal(infoHeaders.get('Ual-Access-Openid'), 'openid-value');
        assert.equal(
            infoHeaders.get('Ual-Access-Signature'),
            crypto.createHash('md5').update(`${timestamp}${nonce}`).digest('hex'),
        );
    }
    finally {
        global.fetch = originalFetch;
    }
});

test('WeChat renewal signs camelCase token request and uses rolled tokens for the login buffer', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        const body = calls.length === 1
            ? { code: 0, userInfo: { accessToken: 'access-next', refreshToken: 'refresh-next' } }
            : { code: 0, extInfo: { listS: { loginBuffer: { value: ['buffer-next'] } } } };
        return { status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from(JSON.stringify(body)) };
    };
    try {
        const session = { cookies: new Map([['refreshtoken', 'refresh-old']]), openid: 'openid', refreshtoken: 'refresh-old', accesstoken: 'access-old' };
        const result = await new WxLoginService().refreshLoginBuffer(session);
        assert.deepEqual(JSON.parse(calls[0].init.body), { userInfo: {
            openId: 'openid', refreshToken: 'refresh-old', accessToken: 'access-old', loginType: 'WX',
        } });
        const headers = calls[0].init.headers;
        const expected = crypto.createHash('md5').update(`${calls[0].init.body}${headers.get('Ual-Access-Timestamp')}wgrdg373hy26ww2${headers.get('Ual-Access-Nonce')}`).digest('hex');
        assert.equal(headers.get('Ual-Access-Signature'), expected);
        assert.equal(new URL(calls[0].url).pathname, '/pc_yyb_auth/pcyyb_refresh_token_auth');
        assert.match(calls[1].init.headers.get('Cookie'), /refreshtoken=refresh-next/);
        assert.doesNotMatch(calls[1].init.headers.get('Cookie'), /refresh-old/);
        assert.equal(JSON.parse(calls[1].init.body).extInfo.listS.access_token.value[0], 'access-next');
        assert.deepEqual(result, { loginBuffer: 'buffer-next', refreshtoken: 'refresh-next', accesstoken: 'access-next' });
    } finally { global.fetch = originalFetch; }
});

test('WeChat renewal exposes rolled credentials when the next buffer response fails', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => ({
        status: 200, headers: new Headers(),
        arrayBuffer: async () => Buffer.from(JSON.stringify(++calls === 1
            ? { code: 0, user_info: { access_token: 'access-next', refresh_token: 'refresh-next' } }
            : { code: 5, msg: 'retry buffer later' })),
    });
    try {
        await assert.rejects(new WxLoginService().refreshLoginBuffer({
            cookies: new Map(), openid: 'openid', refreshtoken: 'refresh-old',
        }), error => error.refreshtoken === 'refresh-next' && error.accesstoken === 'access-next');
    } finally { global.fetch = originalFetch; }
});
