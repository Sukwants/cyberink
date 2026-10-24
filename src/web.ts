import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import multipart from '@fastify/multipart';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword } from './auth.js';
import type { AppConfig, AttachmentRecord, MailRepository, OutboundSender, SendAttachment, User } from './contracts.js';

interface WebDependencies {
  config: AppConfig;
  repository: MailRepository;
  outbound: OutboundSender;
}

interface Session {
  userId: number;
  expiresAt: number;
  csrfToken: string;
}

interface LoginAttempts { count: number; expiresAt: number }

const SESSION_COOKIE = 'cyberink_session';
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const emailPattern = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && emailPattern.test(value);
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}

function tokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function safeOrigin(request: FastifyRequest): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.protocol + '://' + request.host).origin;
  } catch {
    return false;
  }
}

export async function buildWeb({ config, repository, outbound }: WebDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: config.trustedProxies?.length ? config.trustedProxies : false,
    bodyLimit: Math.min(Math.max(config.maxMessageBytes * 2, 65_536), 10_485_760),
  });
  const limits = {maxMessageBytes: config.maxMessageBytes, maxAttachments: config.maxAttachments, maxAttachmentBytes: config.maxAttachmentBytes};
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, LoginAttempts>();
  const requestSessions = new WeakMap<FastifyRequest, Session>();
  const requestUsers = new WeakMap<FastifyRequest, User>();
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.secureCookies,
  };
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    for (const [ip, attempt] of attempts) if (attempt.expiresAt <= now) attempts.delete(ip);
  }, 60_000);
  cleanup.unref();
  app.addHook('onClose', async () => { clearInterval(cleanup); sessions.clear(); attempts.clear(); });

  await app.register(cookie);
  await app.register(multipart, {
    limits: {fileSize: config.maxAttachmentBytes, files: config.maxAttachments,
      fields: 4, parts: config.maxAttachments + 4, fieldNameSize: 32, fieldSize: 800_000},
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (unsafeMethods.has(request.method) && !safeOrigin(request)) {
      return reply.code(403).send({ error: '请求来源无效' });
    }
    if (path === '/api/login') return;
    const sessionId = request.cookies[SESSION_COOKIE];
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) sessions.delete(sessionId);
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
      return reply.code(401).send({ error: '请先登录邮箱' });
    }
    if (unsafeMethods.has(request.method) && !tokenMatches(request.headers['x-csrf-token'], session.csrfToken)) {
      return reply.code(403).send({ error: '请求校验失败，请刷新页面后重试' });
    }
    const user = await repository.getUser(session.userId);
    if (!user) {
      sessions.delete(sessionId!);
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
      return reply.code(401).send({ error: '登录状态已失效' });
    }
    requestSessions.set(request, session);
    requestUsers.set(request, user);
  });

  app.setErrorHandler((error, request, reply) => {
    const candidate = isObject(error) && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const statusCode = candidate >= 400 && candidate < 500 ? candidate : 500;
    if (statusCode === 500) request.log.error({ err: error }, 'HTTP request failed');
    void reply.code(statusCode).send({ error: statusCode === 500 ? '服务器暂时无法完成请求' : statusCode === 413 ? '请求内容超过大小限制' : '请求格式无效' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '请求的资源不存在' }));

  app.post('/api/login', async (request, reply) => {
    const body = request.body;
    if (!isObject(body) || !onlyKeys(body, ['email', 'password']) || !isEmail(body.email) || typeof body.password !== 'string' || !body.password || body.password.length > 256) {
      return reply.code(400).send({ error: '请输入有效的邮箱地址和密码' });
    }
    const now = Date.now();
    let attempt = attempts.get(request.ip);
    if (!attempt || attempt.expiresAt <= now) {
      attempt = { count: 0, expiresAt: now + 15 * 60_000 };
      attempts.set(request.ip, attempt);
    }
    if (attempt.count >= 20) {
      reply.header('Retry-After', Math.ceil((attempt.expiresAt - now) / 1000));
      return reply.code(429).send({ error: '登录尝试过于频繁，请稍后重试' });
    }
    attempt.count++;
    const user = await repository.findUserByEmail(body.email.trim().toLowerCase());
    const verified = await verifyPassword(body.password, user?.passwordHash ?? dummyHash);
    if (!user || !verified) return reply.code(401).send({ error: '邮箱地址或密码不正确' });
    attempts.delete(request.ip);
    const mailboxes = await repository.listMailboxes(user.id);
    if (sessions.size >= 10_000) return reply.code(503).send({ error: '当前登录人数过多，请稍后重试' });
    const oldId = request.cookies[SESSION_COOKIE];
    if (oldId) sessions.delete(oldId);
    const id = randomBytes(32).toString('hex');
    const session: Session = { userId: user.id, expiresAt: now + config.sessionTtlMs, csrfToken: randomBytes(32).toString('hex') };
    sessions.set(id, session);
    reply.setCookie(SESSION_COOKIE, id, { ...cookieOptions, maxAge: Math.floor(config.sessionTtlMs / 1000) });
    return { user: { id: user.id, email: user.email, mailboxes: mailboxes.map(({ id: mailboxId, address }) => ({ id: mailboxId, address })) }, csrfToken: session.csrfToken, limits };
  });

  app.get('/api/me', async (request) => {
    const user = requestUsers.get(request)!;
    const mailboxes = await repository.listMailboxes(user.id);
    return { user: { id: user.id, email: user.email, mailboxes: mailboxes.map(({ id, address }) => ({ id, address })) }, csrfToken: requestSessions.get(request)!.csrfToken, limits };
  });
  app.post('/api/logout', async (request, reply) => {
    const id = request.cookies[SESSION_COOKIE];
    if (id) sessions.delete(id);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });
  app.get('/api/sent', async (request) => ({ messages: await repository.listSent(requestUsers.get(request)!.id) }));
  app.delete<{ Params: { id: string } }>('/api/sent/:id', async (request, reply) => {
    if (!validId(request.params.id)) return reply.code(400).send({ error: '邮件编号无效' });
    const changed = await repository.deleteSent(requestUsers.get(request)!.id, request.params.id);
    if (!changed) return reply.code(404).send({ error: '邮件不存在' });
    return { ok: true };
  });
  app.get('/api/inbox', async (request) => ({ messages: await repository.listMessages(requestUsers.get(request)!.id) }));

  app.get<{ Params: { id: string } }>('/api/messages/:id', async (request, reply) => {
    if (!validId(request.params.id)) return reply.code(400).send({ error: '邮件编号无效' });
    const message = await repository.getMessage(requestUsers.get(request)!.id, request.params.id);
    if (!message) return reply.code(404).send({ error: '邮件不存在' });
    return { message };
  });
  app.patch<{ Params: { id: string } }>('/api/messages/:id', async (request, reply) => {
    const body = request.body;
    if (!validId(request.params.id) || !isObject(body) || !onlyKeys(body, ['isRead']) || typeof body.isRead !== 'boolean') {
      return reply.code(400).send({ error: '请提供有效的邮件编号和已读状态' });
    }
    const changed = await repository.setRead(requestUsers.get(request)!.id, request.params.id, body.isRead);
    if (!changed) return reply.code(404).send({ error: '邮件不存在' });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/messages/:id', async (request, reply) => {
    if (!validId(request.params.id)) return reply.code(400).send({ error: '邮件编号无效' });
    const changed = await repository.deleteMessage(requestUsers.get(request)!.id, request.params.id);
    if (!changed) return reply.code(404).send({ error: '邮件不存在' });
    return { ok: true };
  });
  async function downloadAttachment(attachment: AttachmentRecord | undefined, reply: FastifyReply) {
    if (!attachment) return reply.code(404).send({ error: '附件不存在' });
    try {
      const [root, attachmentPath] = await Promise.all([realpath(config.storageDir), realpath(attachment.path)]);
      if (!attachmentPath.startsWith(root + sep) || !(await stat(attachmentPath)).isFile()) return reply.code(404).send({ error: '附件不存在' });
      const filename = Array.from(attachment.filename).filter((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127).join('').slice(0, 255) || 'attachment';
      reply.header('Content-Disposition', "attachment; filename=\"download\"; filename*=UTF-8''" + encodeURIComponent(filename).replace(/['()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase()));
      reply.type('application/octet-stream');
      return reply.send(createReadStream(attachmentPath));
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') return reply.code(404).send({ error: '附件文件不存在' });
      throw error;
    }
  }
  app.get<{ Params: { id: string } }>('/api/attachments/:id', async (request, reply) => {
    if (!validId(request.params.id)) return reply.code(400).send({ error: '附件编号无效' });
    return downloadAttachment(await repository.getAttachment(requestUsers.get(request)!.id, request.params.id), reply);
  });
  app.get<{ Params: { id: string } }>('/api/outbound/attachments/:id', async (request, reply) => {
    if (!validId(request.params.id)) return reply.code(400).send({ error: '附件编号无效' });
    return downloadAttachment(await repository.getOutboundAttachment(requestUsers.get(request)!.id, request.params.id), reply);
  });

  app.post('/api/send', async (request, reply) => {
    let body: unknown = request.body;
    const attachments: SendAttachment[] = [];
    if (request.isMultipart()) {
      const fields: Record<string, unknown> = {};
      let total = 0;
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'attachments') return reply.code(400).send({error: '附件字段无效'});
          const content = await part.toBuffer();
          total += content.length;
          attachments.push({filename: part.filename, contentType: part.mimetype, content});
        } else {
          if (!['from','to','subject','text'].includes(part.fieldname) || Object.hasOwn(fields,part.fieldname)
            || part.valueTruncated || part.fieldnameTruncated || typeof part.value !== 'string') {
            return reply.code(400).send({error: '发件字段无效或超过限制'});
          }
          fields[part.fieldname] = part.value;
          total += Buffer.byteLength(part.value);
        }
        if (total > config.maxMessageBytes) return reply.code(413).send({error: '邮件内容和附件超过大小限制'});
      }
      if (typeof fields.to === 'string' && fields.to.startsWith('[')) {
        try { fields.to = JSON.parse(fields.to); }
        catch { return reply.code(400).send({error: '收件人格式无效'}); }
      }
      body = fields;
    }
    if (!isObject(body) || !onlyKeys(body, ['from', 'to', 'subject', 'text']) || !isEmail(body.from) || typeof body.subject !== 'string' || body.subject.length > 998 || /[\r\n]/.test(body.subject) || typeof body.text !== 'string' || body.text.length > 200_000) {
      return reply.code(400).send({ error: '发件内容格式无效' });
    }
    const recipients: unknown[] = Array.isArray(body.to) ? body.to : [body.to];
    if (!recipients.length || recipients.length > 50 || !recipients.every(isEmail)) return reply.code(400).send({ error: '请提供有效的收件人地址（最多 50 个）' });
    const user = requestUsers.get(request)!;
    const mailboxes = await repository.listMailboxes(user.id);
    const from = body.from.toLowerCase();
    if (!mailboxes.some((mailbox) => mailbox.address.toLowerCase() === from)) return reply.code(403).send({ error: '无权使用此发件人地址' });
    const record = await outbound.send(user.id, { from, to: [...new Set(recipients.map((address) => (address as string).toLowerCase()))], subject: body.subject, text: body.text, attachments });
    return reply.code(201).send(record);
  });
  app.get<{ Params: { id: string } }>('/api/outbound/:id', async (request, reply) => {
    if (!validId(request.params.id)) return reply.code(400).send({ error: '发送记录编号无效' });
    const message = await repository.getOutbound(requestUsers.get(request)!.id, request.params.id);
    if (!message) return reply.code(404).send({ error: '发送记录不存在' });
    return { message };
  });

  const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
  await app.register(staticFiles, { root: publicRoot, index: ['index.html'], cacheControl: false, dotfiles: 'deny' });
  return app;
}
