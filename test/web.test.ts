import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildWeb } from '../src/web.js';
import { hashPassword } from '../src/auth.js';
import type { AppConfig, MailRepository, OutboundRecord, OutboundSender } from '../src/contracts.js';

test('Web sessions reject cross-site changes and enforce mailbox ownership', async (t) => {
  const testRoot = resolve('.test-data');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'web-unit-'));
  const storageDir = join(root, 'mail');
  await mkdir(storageDir);
  const attachmentPath = join(storageDir, 'sample.txt');
  const outsidePath = join(root, 'outside.txt');
  await writeFile(outsidePath, 'Private server file');
  await writeFile(attachmentPath, 'Attachment content');
  const user = { id: 1, email: 'alice@example.test', passwordHash: await hashPassword('test-password-123') };
  const message = { id: 'message-one', fromAddress: 'sender@example.test', toAddress: user.email, subject: 'A real subject', createdAt: new Date().toISOString(), isRead: false, textBody: '<script>unsafe()</script>', attachments: [{ id: 'attachment-one', filename: 'note.txt', contentType: 'text/plain', size: 18 }] };
  const sentMessage: OutboundRecord = {
    id: 'sent-message-one', userId: user.id, from: user.email, to: ['recipient@example.test'],
    subject: 'Sent subject', text: 'Sent body', status: 'sent', error: null, createdAt: new Date().toISOString(),
    attachments: [{ id: 'sent-attachment-one', filename: 'note.txt', contentType: 'text/plain', size: 18 }],
  };
  let sentDeleted = false;
  let deleteSentCalls = 0;
  let deleted = false;
  let sends = 0;
  const repository: MailRepository = {
    initialize: async () => {}, close: async () => {},
    findUserByEmail: async (email) => email === user.email ? user : undefined,
    getUser: async (id) => id === user.id ? user : undefined,
    createUser: async () => { throw new Error('Unexpected create user'); },
    createMailbox: async () => { throw new Error('Unexpected create mailbox'); },
    findMailbox: async () => undefined,
    listMailboxes: async (id) => id === user.id ? [{ id: 1, userId: id, address: user.email }] : [],
    saveIncoming: async () => { throw new Error('Unexpected incoming delivery'); },
    listMessages: async (id) => id === user.id && !deleted ? [message] : [],
    getMessage: async (id, messageId) => id === user.id && messageId === message.id && !deleted ? message : undefined,
    setRead: async (id, messageId, isRead) => { if (id !== user.id || messageId !== message.id || deleted) return false; message.isRead = isRead; return true; },
    deleteMessage: async (id, messageId) => { if (id !== user.id || messageId !== message.id || deleted) return false; deleted = true; return true; },
    getAttachment: async (id, attachmentId) => id !== user.id || deleted ? undefined : attachmentId === 'attachment-one' ? { ...message.attachments[0], path: attachmentPath } : attachmentId === 'attachment-outside' ? { ...message.attachments[0], path: outsidePath } : undefined,
    createOutbound: async () => {},
    listSent: async (id) => id === user.id && !sentDeleted ? [sentMessage] : [],
    deleteSent: async (id, messageId) => {
      deleteSentCalls++;
      if (id !== user.id || messageId !== sentMessage.id || sentDeleted) return false;
      sentDeleted = true;
      return true;
    },
    getOutboundAttachment: async (id, attachmentId) => id === user.id && attachmentId === 'sent-attachment-one' && !sentDeleted
      ? { ...sentMessage.attachments[0], path: attachmentPath } : undefined,
    setOutboundStatus: async () => {},
    getOutbound: async (id, messageId) => id === user.id && messageId === sentMessage.id && !sentDeleted ? sentMessage : undefined,
  };
  const outbound: OutboundSender = { send: async (userId, input) => { sends++; return { id: 'outbound-one', userId, ...input, attachments: [], createdAt: new Date().toISOString(), status: 'sent', error: null }; } };
  const config: AppConfig = {
    env: 'test', host: '127.0.0.1', httpPort: 3000, smtpPort: 2525, domains: ['example.test'], maxMessageBytes: 65_536, maxAttachments: 10, maxAttachmentBytes: 65_536, storageDir,
    db: { host: '127.0.0.1', port: 3306, user: 'mail_platform_test', password: 'test', database: 'mail_platform_test', connectionLimit: 1 },
    relay: { host: '127.0.0.1', port: 2526, secure: false }, sessionTtlMs: 60_000, secureCookies: false,
  };
  const app = await buildWeb({ config, repository, outbound });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await app.inject({ url: '/' });
  assert.equal(page.statusCode, 200); assert.match(page.body, /lang="zh-CN"/);
  assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
  const unauthenticated = await app.inject({ url: '/api/inbox' });
  assert.equal(unauthenticated.statusCode, 401);
  const failed = await app.inject({ method: 'POST', url: '/api/login', payload: { email: user.email, password: 'wrong' } });
  assert.equal(failed.statusCode, 401);
  const crossSiteLogin = await app.inject({ method: 'POST', url: '/api/login', headers: { origin: 'https://attacker.test' }, payload: { email: user.email, password: 'test-password-123' } });
  assert.equal(crossSiteLogin.statusCode, 403);
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: user.email, password: 'test-password-123' } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.passwordHash, undefined);
  const csrfToken: string = login.json().csrfToken;
  assert.equal(csrfToken.length, 64);
  const setCookie = login.headers['set-cookie'] as string;
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const auth = { cookie, 'x-csrf-token': csrfToken };
  const me = await app.inject({ url: '/api/me', headers: { cookie } });
  assert.equal(me.json().user.email, user.email);
  assert.equal(me.json().csrfToken, csrfToken);
  const inbox = await app.inject({ url: '/api/inbox', headers: auth });
  assert.equal(inbox.json().messages[0].id, message.id);
  const read = await app.inject({ url: '/api/messages/message-one', headers: auth });
  assert.equal(read.json().message.textBody, '<script>unsafe()</script>');
  for (const url of ['/api/messages/foreign-message', '/api/attachments/foreign-attachment', '/api/outbound/foreign-outbound']) {
    assert.equal((await app.inject({ url, headers: auth })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/messages/message-one', headers: { cookie }, payload: { isRead: true } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/messages/message-one', headers: { cookie, 'x-csrf-token': '中'.repeat(64) }, payload: { isRead: true } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/messages/message-one', headers: { ...auth, origin: 'https://attacker.test' }, payload: { isRead: true } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/messages/message-one', headers: auth, payload: { isRead: 'yes' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/messages/message-one', headers: auth, payload: { isRead: true } })).statusCode, 200);
  assert.equal(message.isRead, true);
  assert.equal((await app.inject({ url: '/api/attachments/attachment-outside', headers: auth })).statusCode, 404);
  const attachment = await app.inject({ url: '/api/attachments/attachment-one', headers: auth });
  assert.equal(attachment.statusCode, 200);
  assert.equal(attachment.body, 'Attachment content');
  assert.match(String(attachment.headers['content-disposition']), /^attachment;/);
  assert.equal(attachment.headers['x-content-type-options'], 'nosniff');
  const forbiddenSender = await app.inject({ method: 'POST', url: '/api/send', headers: auth, payload: { from: 'bob@example.test', to: ['local@example.test'], subject: 'test', text: 'test' } });
  assert.equal(forbiddenSender.statusCode, 403); assert.equal(sends, 0);
  const invalidSend = await app.inject({ method: 'POST', url: '/api/send', headers: auth, payload: { from: user.email, to: ['local@example.test'], subject: 'test\r\nBcc: evil@example.test', text: 'test' } });
  assert.equal(invalidSend.statusCode, 400); assert.equal(sends, 0);
  const sent = await app.inject({ method: 'POST', url: '/api/send', headers: auth, payload: { from: user.email, to: ['local@example.test'], subject: 'test', text: 'test' } });
  assert.equal(sent.statusCode, 201); assert.equal((sent.json() as OutboundRecord).status, 'sent'); assert.equal(sends, 1);
  await t.test('HTTPS proxy preserves origin and CSRF protection and sets secure cookies', async () => {
    const proxyApp = await buildWeb({
      config: { ...config, env: 'production', secureCookies: true, trustedProxies: ['127.0.0.1'] },
      repository, outbound,
    });
    try {
      const headers = {
        host: '127.0.0.1:3000',
        origin: 'https://mail.example.test:8443',
        'x-forwarded-host': 'mail.example.test:8443',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.20',
      };
      const payload = { email: user.email, password: 'test-password-123' };
      const login = await proxyApp.inject({ method: 'POST', url: '/api/login', remoteAddress: '127.0.0.1', headers, payload });
      assert.equal(login.statusCode, 200);
      assert.match(String(login.headers['set-cookie']), /; Secure(?:;|$)/);
      const cookie = (login.headers['set-cookie'] as string).split(';')[0];
      const csrfToken = login.json().csrfToken;
      const noCsrf = await proxyApp.inject({ method: 'PATCH', url: '/api/messages/message-one', remoteAddress: '127.0.0.1', headers: { ...headers, cookie }, payload: { isRead: false } });
      assert.equal(noCsrf.statusCode, 403);
      const patch = await proxyApp.inject({ method: 'PATCH', url: '/api/messages/message-one', remoteAddress: '127.0.0.1', headers: { ...headers, cookie, 'x-csrf-token': csrfToken }, payload: { isRead: false } });
      assert.equal(patch.statusCode, 200);
      assert.equal(message.isRead, false);
      const crossSite = await proxyApp.inject({ method: 'POST', url: '/api/login', remoteAddress: '127.0.0.1', headers: { ...headers, origin: 'https://attacker.test' }, payload });
      assert.equal(crossSite.statusCode, 403);
      for (const origin of ['https://mail.example.test', 'http://mail.example.test:8443']) {
        const mismatch = await proxyApp.inject({ method: 'POST', url: '/api/login', remoteAddress: '127.0.0.1', headers: { ...headers, origin }, payload });
        assert.equal(mismatch.statusCode, 403);
      }
      const crossSiteHeader = await proxyApp.inject({ method: 'POST', url: '/api/login', remoteAddress: '127.0.0.1', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, payload });
      assert.equal(crossSiteHeader.statusCode, 403);
      const untrusted = await proxyApp.inject({ method: 'POST', url: '/api/login', remoteAddress: '203.0.113.10', headers, payload });
      assert.equal(untrusted.statusCode, 403);
      const disabled = await app.inject({ method: 'POST', url: '/api/login', remoteAddress: '127.0.0.1', headers, payload });
      assert.equal(disabled.statusCode, 403);
    } finally {
      await proxyApp.close();
    }
  });
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/messages/message-one', headers: auth })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/messages/message-one', headers: auth })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/attachments/attachment-one', headers: auth })).statusCode, 404);
  await t.test('sent deletion validates authentication, CSRF, origin and IDs before hiding the record', async () => {
    const url = '/api/sent/' + sentMessage.id;
    assert.equal((await app.inject({ method: 'DELETE', url })).statusCode, 401);
    assert.equal((await app.inject({ method: 'DELETE', url, headers: { cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url, headers: { ...auth, origin: 'https://attacker.test' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url, headers: { ...auth, 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/sent/%3Cinvalid%3E', headers: auth })).statusCode, 400);
    assert.equal(deleteSentCalls, 0);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/sent/missing-sent', headers: auth })).statusCode, 404);
    assert.equal(sentDeleted, false);
    assert.equal((await app.inject({ url: '/api/outbound/' + sentMessage.id, headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/outbound/attachments/sent-attachment-one', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/sent', headers: auth })).json().messages[0].id, sentMessage.id);
    const result = await app.inject({ method: 'DELETE', url, headers: auth });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { ok: true });
    assert.equal((await app.inject({ method: 'DELETE', url, headers: auth })).statusCode, 404);
    assert.deepEqual((await app.inject({ url: '/api/sent', headers: auth })).json(), { messages: [] });
    assert.equal((await app.inject({ url: '/api/outbound/' + sentMessage.id, headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/outbound/attachments/sent-attachment-one', headers: auth })).statusCode, 404);
  });
  assert.equal((await app.inject({ method: 'POST', url: '/api/logout', headers: auth })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/inbox', headers: auth })).statusCode, 401);
});
