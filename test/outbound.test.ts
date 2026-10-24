import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { simpleParser } from 'mailparser';
import type { SendMailOptions } from 'nodemailer';
import type { AttachmentRecord, MailRepository, OutboundRecord, OutboundStatus, SendAttachment, SendInput } from '../src/contracts.js';
import { OutboundError, OutboundService, type OutboundOptions, type OutboundTransport, type RelayResult } from '../src/outbound.js';

const relay = { host: '127.0.0.1', port: 2526, secure: false };
const input: SendInput = {
  from: 'alice@example.test',
  to: ['bob@example.net'],
  subject: 'Outbound local test',
  text: 'Hello from the test transport',
};
const attachment: SendAttachment = {
  filename: '\u62a5\u544a.bin', contentType: 'application/octet-stream', content: Buffer.from([0, 1, 2, 128, 254, 255]),
};

async function storage(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cyberink-outbound-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function harness(
  send: (message: SendMailOptions) => Promise<RelayResult> = async () => ({ accepted: input.to, rejected: [] }),
  options: OutboundOptions = {},
) {
  const events: string[] = [];
  const records: OutboundRecord[] = [];
  const persistedFiles: AttachmentRecord[][] = [];
  const updates: Array<{ id: string; userId: number; status: OutboundStatus; error?: string }> = [];
  let sendCount = 0;
  const repository = {
    findMailbox: async (address: string) => address === input.from
      ? { id: 1, userId: 7, address } : undefined,
    createOutbound: async (record: OutboundRecord, attachments: AttachmentRecord[] = []) => {
      events.push('persist pending');
      records.push(structuredClone(record));
      persistedFiles.push(structuredClone(attachments));
    },
    setOutboundStatus: async (id: string, userId: number, status: OutboundStatus, error?: string) => {
      events.push('persist ' + status);
      updates.push({ id, userId, status, error });
    },
  } as unknown as MailRepository;
  const transport: OutboundTransport = {
    sendMail: async (message) => {
      events.push('send');
      sendCount += 1;
      return send(message);
    },
  };
  const service = new OutboundService(repository, relay, transport, options);
  return { service, repository, records, persistedFiles, updates, events, sendCount: () => sendCount };
}

test('outbound persists pending before sending the canonical MIME and records confirmed success', async () => {
  const h = harness(async (message) => {
    assert.deepEqual(message.envelope, { from: input.from, to: input.to });
    const raw = message.raw;
    assert.ok(Buffer.isBuffer(raw));
    const parsed = await simpleParser(raw);
    assert.equal(parsed.from?.value[0]?.address, input.from);
    assert.equal(parsed.subject, input.subject);
    assert.equal(parsed.text?.trim(), input.text);
    assert.match(parsed.messageId ?? '', /^<[^@]+@example\.test>$/);
    assert.deepEqual(Object.keys(message).sort(), ['envelope', 'raw']);
    return { accepted: input.to, rejected: [] };
  });
  const result = await h.service.send(7, input);
  assert.equal(h.records[0]?.status, 'pending');
  assert.equal(result.status, 'sent');
  assert.equal(result.error, null);
  assert.equal(h.updates[0]?.id, result.id);
  assert.equal(h.updates[0]?.userId, 7);
  assert.ok(Number.isFinite(Date.parse(result.createdAt)));
  assert.deepEqual(result.attachments, []);
  assert.deepEqual(h.events, ['persist pending', 'send', 'persist sent']);
  assert.equal(h.sendCount(), 1);
});

test('outbound verifies sender ownership before persisting or contacting a relay', async () => {
  const h = harness();
  await assert.rejects(h.service.send(8, input), (error: unknown) =>
    error instanceof OutboundError && error.statusCode === 403);
  await assert.rejects(h.service.send(7, { ...input, from: 'unknown@example.test' }), (error: unknown) =>
    error instanceof OutboundError && error.statusCode === 403);
  assert.deepEqual(h.records, []);
  assert.equal(h.sendCount(), 0);
});

for (const [label, relayError, expected] of [
  ['temporary rejection', Object.assign(new Error('password=must-not-leak'), { responseCode: 451 }), 'temp_failed'],
  ['permanent rejection', Object.assign(new Error('password=must-not-leak'), { responseCode: 550 }), 'permanent_failed'],
  ['timeout', Object.assign(new Error('password=must-not-leak'), { code: 'ETIMEDOUT' }), 'unknown'],
  ['connection reset', Object.assign(new Error('password=must-not-leak'), { code: 'ECONNRESET' }), 'unknown'],
] as const) {
  test('outbound classifies ' + label + ' and does not retry or expose relay details', async () => {
    const h = harness(async () => { throw relayError; });
    const result = await h.service.send(7, input);
    assert.equal(result.status, expected);
    assert.equal(h.updates[0]?.status, expected);
    assert.doesNotMatch(result.error ?? '', /password|must-not-leak/);
    assert.equal(h.sendCount(), 1);
  });
}

test('outbound marks partial recipient acceptance uncertain instead of success', async () => {
  const h = harness(async () => ({ accepted: [input.to[0]!], rejected: ['carol@example.net'] }));
  const result = await h.service.send(7, { ...input, to: [...input.to, 'carol@example.net'] });
  assert.equal(result.status, 'unknown');
  assert.equal(h.sendCount(), 1);
});

test('outbound needs positive acceptance confirmation', async () => {
  const h = harness(async () => ({}));
  assert.equal((await h.service.send(7, input)).status, 'unknown');
  assert.equal(h.sendCount(), 1);
});

test('outbound does not contact relay if pending persistence fails', async () => {
  const h = harness();
  h.repository.createOutbound = async () => { throw new Error('database unavailable'); };
  await assert.rejects(h.service.send(7, input), /database unavailable/);
  assert.equal(h.sendCount(), 0);
  assert.equal(h.updates.length, 0);
});

test('outbound propagates status persistence failure without resending', async () => {
  const h = harness();
  h.repository.setOutboundStatus = async () => { throw new Error('database unavailable'); };
  await assert.rejects(h.service.send(7, input), /database unavailable/);
  assert.equal(h.sendCount(), 1);
});

test('outbound rejects malformed recipients, excessive text, and header injection before sending', async () => {
  const h = harness();
  for (const invalid of [
    { ...input, to: [] },
    { ...input, to: ['Bob <bob@example.net>'] },
    { ...input, to: ['bob@example.net\r\nBcc: evil@example.net'] },
    { ...input, subject: 'Subject\r\nBcc: evil@example.net' },
    { ...input, text: 'x'.repeat(200_001) },
  ]) {
    await assert.rejects(h.service.send(7, invalid), (error: unknown) =>
      error instanceof OutboundError && error.statusCode === 400);
  }
  assert.equal(h.sendCount(), 0);
  assert.equal(h.records.length, 0);
});

test('outbound stores private attachment bytes before pending and sends matching Unicode/binary MIME', async (t) => {
  const storageDir = await storage(t);
  let transmitted: Buffer | undefined;
  const h = harness(async (message) => {
    assert.ok(Buffer.isBuffer(message.raw));
    transmitted = message.raw;
    return { accepted: input.to };
  }, { storageDir });
  const baseCreate = h.repository.createOutbound.bind(h.repository);
  h.repository.createOutbound = async (record, attachments) => {
    assert.equal(attachments?.length, 1);
    const saved = attachments![0]!;
    assert.deepEqual(await readFile(saved.path), attachment.content);
    assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(saved.path))).mode & 0o777, 0o700);
    assert.match(path.basename(saved.path), /^[a-f0-9-]{36}$/);
    assert.ok(saved.path.startsWith(path.join(storageDir, 'outbound') + path.sep));
    assert.notEqual(path.basename(saved.path), attachment.filename);
    await baseCreate(record, attachments);
  };
  const result = await h.service.send(7, { ...input, attachments: [attachment] });
  const parsed = await simpleParser(transmitted!);
  assert.equal(parsed.attachments[0]?.filename, attachment.filename);
  assert.equal(parsed.attachments[0]?.contentType, attachment.contentType);
  assert.deepEqual(parsed.attachments[0]?.content, attachment.content);
  assert.equal(result.attachments[0]?.size, attachment.content.length);
  assert.deepEqual(Object.keys(result.attachments[0]!).sort(), ['contentType', 'filename', 'id', 'size']);
  assert.doesNotMatch(JSON.stringify(result), /"path"|"content"|"type":"Buffer"/);
  assert.equal(result.attachments[0]?.id, h.persistedFiles[0]?.[0]?.id);
});

test('outbound snapshots attachment content so async input mutation cannot change sent or stored bytes', async (t) => {
  const storageDir = await storage(t);
  const original = Buffer.from('original bytes');
  const h = harness(async (message) => {
    assert.ok(Buffer.isBuffer(message.raw));
    const parsed = await simpleParser(message.raw);
    assert.equal(parsed.attachments[0]?.content.toString(), 'original bytes');
    return { accepted: input.to };
  }, { storageDir });
  h.repository.findMailbox = async () => {
    original.fill(120);
    return { id: 1, userId: 7, address: input.from };
  };
  await h.service.send(7, { ...input, attachments: [{ ...attachment, content: original }] });
  assert.equal((await readFile(h.persistedFiles[0]![0]!.path)).toString(), 'original bytes');
});

test('outbound rejects path, URL, non-Buffer, malformed filenames and content types as attachment inputs', async () => {
  const h = harness();
  const invalidAttachments = [
    { path: '/etc/passwd', filename: 'passwd', contentType: 'text/plain' },
    { href: 'http://127.0.0.1/private', filename: 'remote', contentType: 'text/plain' },
    { ...attachment, path: '/etc/passwd' },
    { ...attachment, href: 'https://example.net/private' },
    { ...attachment, content: 'base64-looking-string' },
    { ...attachment, content: new Uint8Array([1, 2]) },
    { ...attachment, filename: '../escape.bin' },
    { ...attachment, filename: 'folder\\escape.bin' },
    { ...attachment, filename: 'bad\r\nname' },
    { ...attachment, filename: '' },
    { ...attachment, filename: '..' },
    { ...attachment, contentType: 'text/plain\r\nBcc: evil@example.net' },
    { ...attachment, contentType: 'text/plain; charset=utf-8' },
  ];
  for (const invalid of invalidAttachments) {
    await assert.rejects(h.service.send(7, { ...input, attachments: [invalid as unknown as SendAttachment] }),
      (error: unknown) => error instanceof OutboundError && error.statusCode === 400);
  }
  assert.equal(h.records.length, 0);
  assert.equal(h.sendCount(), 0);
});

test('outbound enforces the shared attachment count limit', async () => {
  const h = harness();
  await assert.rejects(h.service.send(7, { ...input, attachments: Array.from({ length: 11 }, () => attachment) }),
    (error: unknown) => error instanceof OutboundError && error.statusCode === 400);
  assert.equal(h.records.length, 0);
  assert.equal(h.sendCount(), 0);
});

test('outbound checks MIME/base64 overhead before file persistence, database writes, or relay traffic', async (t) => {
  const storageDir = await storage(t);
  const h = harness(undefined, { storageDir, maxMessageBytes: 4000 });
  const attachments = [{ ...attachment, content: Buffer.alloc(3000, 120) }];
  await assert.rejects(h.service.send(7, { ...input, attachments }),
    (error: unknown) => error instanceof OutboundError && error.statusCode === 413);
  assert.equal(h.records.length, 0);
  assert.equal(h.sendCount(), 0);
  await assert.rejects(stat(path.join(storageDir, 'outbound')), { code: 'ENOENT' });
});

test('outbound permits the exact canonical MIME size and rejects one byte below it', async (t) => {
  const storageDir = await storage(t);
  let rawBytes = 0;
  const baseline = harness(async (message) => {
    assert.ok(Buffer.isBuffer(message.raw));
    rawBytes = message.raw.length;
    return { accepted: input.to };
  }, { storageDir });
  const withAttachment = { ...input, attachments: [attachment] };
  await baseline.service.send(7, withAttachment);
  const exact = harness(undefined, { storageDir, maxMessageBytes: rawBytes });
  assert.equal((await exact.service.send(7, withAttachment)).status, 'sent');
  const tooSmall = harness(undefined, { storageDir, maxMessageBytes: rawBytes - 1 });
  await assert.rejects(tooSmall.service.send(7, withAttachment),
    (error: unknown) => error instanceof OutboundError && error.statusCode === 413);
  assert.equal(tooSmall.records.length, 0);
  assert.equal(tooSmall.sendCount(), 0);
});

test('outbound removes newly saved attachments on known pending transaction failure', async (t) => {
  const storageDir = await storage(t);
  const h = harness(undefined, { storageDir });
  h.repository.createOutbound = async (_record, files) => {
    assert.ok(files?.length);
    assert.deepEqual(await readFile(files![0]!.path), attachment.content);
    throw new Error('known rollback');
  };
  await assert.rejects(h.service.send(7, { ...input, attachments: [attachment] }), /known rollback/);
  assert.deepEqual(await readdir(path.join(storageDir, 'outbound')), []);
  assert.equal(h.sendCount(), 0);
});

test('outbound retains saved attachment bytes when COMMIT acknowledgement is uncertain', async (t) => {
  const storageDir = await storage(t);
  const h = harness(undefined, { storageDir });
  let savedFile: string | undefined;
  h.repository.createOutbound = async (_record, files) => {
    savedFile = files![0]!.path;
    throw Object.assign(new Error('commit response lost'), { persistenceUncertain: true });
  };
  await assert.rejects(h.service.send(7, { ...input, attachments: [attachment] }), /commit response lost/);
  assert.deepEqual(await readFile(savedFile!), attachment.content);
  assert.equal(h.sendCount(), 0);
});

test('outbound retains linked files after relay failure and does not retry', async (t) => {
  const storageDir = await storage(t);
  const h = harness(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }, { storageDir });
  const result = await h.service.send(7, { ...input, attachments: [attachment] });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(await readFile(h.persistedFiles[0]![0]!.path), attachment.content);
  assert.equal(h.sendCount(), 1);
});

test('outbound does not persist pending or contact relay when attachment storage fails', async (t) => {
  const storageDir = await storage(t);
  const blocker = path.join(storageDir, 'blocked');
  await writeFile(blocker, 'regular file');
  const h = harness(undefined, { storageDir: blocker });
  await assert.rejects(h.service.send(7, { ...input, attachments: [attachment] }), { code: 'ENOTDIR' });
  assert.equal(h.records.length, 0);
  assert.equal(h.sendCount(), 0);
});

test('outbound supports a configured attachment count above the default ten', async (t) => {
  const storageDir = await storage(t);
  const h = harness(undefined, { storageDir, maxAttachments: 11 });
  const attachments = Array.from({ length: 11 }, (_, index) => ({ ...attachment, filename: 'file-' + index + '.bin' }));
  const result = await h.service.send(7, { ...input, attachments });
  assert.equal(result.status, 'sent');
  assert.equal(result.attachments.length, 11);
  assert.equal(h.persistedFiles[0]?.length, 11);
  assert.equal(h.sendCount(), 1);
});

test('outbound applies a lower configured count before files, pending, or relay traffic', async (t) => {
  const storageDir = await storage(t);
  const h = harness(undefined, { storageDir, maxAttachments: 2 });
  await assert.rejects(h.service.send(7, { ...input, attachments: [attachment, attachment, attachment] }),
    (error: unknown) => error instanceof OutboundError && error.statusCode === 400);
  assert.equal(h.records.length, 0);
  assert.equal(h.sendCount(), 0);
  await assert.rejects(stat(path.join(storageDir, 'outbound')), { code: 'ENOENT' });
});

test('outbound permits text mail when configured count zero disables attachments', async (t) => {
  const storageDir = await storage(t);
  const h = harness(undefined, { storageDir, maxAttachments: 0 });
  assert.equal((await h.service.send(7, input)).status, 'sent');
  await assert.rejects(h.service.send(7, { ...input, attachments: [attachment] }),
    (error: unknown) => error instanceof OutboundError && error.statusCode === 400);
  assert.equal(h.records.length, 1);
  assert.equal(h.sendCount(), 1);
  await assert.rejects(stat(path.join(storageDir, 'outbound')), { code: 'ENOENT' });
});

test('outbound permits the exact per-file byte limit and rejects one byte more before persistence', async (t) => {
  const storageDir = await storage(t);
  const accepted = harness(undefined, { storageDir, maxAttachmentBytes: attachment.content.length });
  const result = await accepted.service.send(7, { ...input, attachments: [attachment] });
  assert.equal(result.status, 'sent');
  assert.deepEqual(await readFile(accepted.persistedFiles[0]![0]!.path), attachment.content);

  const rejectedStorage = await storage(t);
  const rejected = harness(undefined, { storageDir: rejectedStorage, maxAttachmentBytes: attachment.content.length });
  await assert.rejects(rejected.service.send(7, {
    ...input, attachments: [{ ...attachment, content: Buffer.alloc(attachment.content.length + 1) }],
  }), (error: unknown) => error instanceof OutboundError && error.statusCode === 413);
  assert.equal(rejected.records.length, 0);
  assert.equal(rejected.sendCount(), 0);
  await assert.rejects(stat(path.join(rejectedStorage, 'outbound')), { code: 'ENOENT' });
});

test('outbound rejects malformed configurable attachment count and file-size limits', () => {
  for (const value of [-1, 1001, 0.5, NaN, Infinity, '10', null, false]) {
    assert.throws(() => harness(undefined, { maxAttachments: value as unknown as number }), /maxAttachments/);
  }
  for (const value of [0, -1, 0.5, NaN, Infinity, '10', null, false, 1001]) {
    assert.throws(() => harness(undefined, {
      maxMessageBytes: 1000, maxAttachmentBytes: value as unknown as number,
    }), /maxAttachmentBytes/);
  }
  assert.doesNotThrow(() => harness(undefined, { maxAttachments: 1000, maxMessageBytes: 1000, maxAttachmentBytes: 1000 }));
});
