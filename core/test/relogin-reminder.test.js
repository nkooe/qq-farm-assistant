const test = require('node:test');
const assert = require('node:assert/strict');
const { createReloginReminderService } = require('../src/runtime/relogin-reminder');

function harness(config, result = { ok: true }) {
    const messages = []; const sent = [];
    const service = createReloginReminderService({
        store: { getOfflineReminder: () => config },
        getAccounts: () => ({ accounts: [{ id: '1', username: 'fixture' }] }),
        log: (tag, message) => messages.push({ tag, message }),
        sendSmtpEmail: async payload => { sent.push(payload); return result; },
        sendPushooMessage: async payload => { sent.push(payload); return result; },
    });
    return { service, messages, sent };
}

test('disabled reminders do not send and missing SMTP configuration is a skipped result', async () => {
    for (const [config, expected] of [[{ enabled: false }, 'disabled'], [{ channel: 'smtp' }, 'unconfigured']]) {
        const h = harness(config);
        assert.deepEqual(await h.service.triggerOfflineReminder({ accountId: '1' }), { ok: false, status: expected });
        assert.equal(h.sent.length, 0);
        assert.equal(h.messages.some(entry => entry.tag === '错误'), false);
        assert.equal(h.messages.some(entry => /发送成功/.test(entry.message)), false);
    }
});

test('reminder results report actual delivery success and failure for both channels', async () => {
    for (const channel of ['smtp', 'webhook']) {
        for (const ok of [false, true]) {
            const h = harness({ channel, endpoint: 'https://example.test', smtpHost: 'smtp.test', smtpUser: 'fixture', smtpPass: 'fixture', recipientEmail: 'fixture@example.test' }, { ok });
            assert.deepEqual(await h.service.triggerOfflineReminder({ accountId: '1' }), { ok, status: ok ? 'sent' : 'failed' });
            assert.equal(h.sent.length, 1);
            assert.equal(h.messages.some(entry => /发送成功/.test(entry.message)), ok);
        }
    }
});

test('legacy relogin options do not change offline notification content', async () => {
    for (const reloginUrlMode of ['qq_link', 'qr_link']) {
        const h = harness({ channel: 'webhook', endpoint: 'https://example.test', msg: '请更新登录信息', reloginUrlMode });
        const result = await h.service.triggerOfflineReminder({ accountId: '1', accountName: '测试账号', reason: '登录失效', offlineMs: 120000 });
        assert.deepEqual(result, { ok: true, status: 'sent' });
        assert.equal(h.sent[0].content, '请更新登录信息\n原因: 登录失效\n离线时长: 2 分钟');
    }
});
