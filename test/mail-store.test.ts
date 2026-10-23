import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MailStore } from '../src/mail-store.js';
import type { Mailbox, MailRepository, StoredMessage } from '../src/contracts.js';

const alice: Mailbox = { id: 1, userId: 1, address: 'alice@example.test' };
const bob: Mailbox = { id: 2, userId: 2, address: 'bob@example.test' };
const raw = Buffer.from([
  'From: Header Sender <spoofed@example.net>',
  'To: alice@example.test',
  'Subject: =?UTF-8?B?5rWL6K+V?=',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="test-boundary"',
  '',
  '--test-boundary',
  'Content-Type: multipart/alternative; boundary="body-boundary"',
  '',
  '--body-boundary',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello from WSL',
  '--body-boundary',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello from WSL</p><script>alert(1)</script>',
  '--body-boundary--',
  '--test-boundary',
  'Content-Type: application/octet-stream',
  'Content-Disposition: attachment; filename="../../secret.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  'YXR0YWNobWVudCBieXRlcw==',
  '--test-boundary--',
  '',
].join('\r\n'));

function repository(saveIncoming: MailRepository['saveIncoming']): MailRepository {
  return { saveIncoming } as MailRepository;
}

test('MIME delivery saves original bytes, parsed text and private attachment paths for all local recipients', async (t) => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'mail-store-test-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  let saved: StoredMessage[] = [];
  const store = new MailStore(storage, repository(async (messages) => { saved = messages; }));
  await store.deliver(raw, 'envelope@example.net', [alice, bob, alice]);
  assert.equal(saved.length, 2, 'duplicate RCPT must not duplicate mailbox delivery');
  assert.deepEqual(saved.map((message) => message.mailboxId), [alice.id, bob.id]);
  assert.notEqual(saved[0].id, saved[1].id);
  assert.equal(saved[0].subject, '测试');
  assert.equal(saved[0].fromAddress, 'envelope@example.net');
  assert.equal(saved[0].textBody.trim(), 'Hello from WSL');
  assert.match(saved[0].htmlBody, /<script>/);
  assert.equal(path.extname(saved[0].rawPath), '.eml');
  assert.deepEqual(await readFile(saved[0].rawPath), raw);
  assert.equal(saved[0].attachments.length, 1);
  const attachment = saved[0].attachments[0];
  assert.equal(attachment.size, 16);
  assert.equal(await readFile(attachment.path, 'utf8'), 'attachment bytes');
  assert.equal(path.relative(storage, attachment.path).split(path.sep).length, 2);
  assert.notEqual(path.basename(attachment.path), attachment.filename);
  assert.notEqual(attachment.id, saved[1].attachments[0].id);
});

test('database failure propagates and removes every file from the failed delivery', async (t) => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'mail-store-test-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const failure = new Error('Database unavailable');
  let rawExistedBeforeDatabase = false;
  const store = new MailStore(storage, repository(async (messages) => {
    rawExistedBeforeDatabase = (await readFile(messages[0].rawPath)).equals(raw);
    throw failure;
  }));
  await assert.rejects(store.deliver(raw, 'sender@example.net', [alice]), (error) => error === failure);
  assert.equal(rawExistedBeforeDatabase, true);
  assert.deepEqual(await readdir(storage), []);
});

test('filesystem failure prevents database persistence and is returned to SMTP caller', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'mail-store-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const storage = path.join(parent, 'not-a-directory');
  await writeFile(storage, 'occupied');
  let calls = 0;
  const store = new MailStore(storage, repository(async () => { calls += 1; }));
  await assert.rejects(store.deliver(raw, 'sender@example.net', [alice]));
  assert.equal(calls, 0);
  assert.equal(await readFile(storage, 'utf8'), 'occupied');
});

test('HTML-only mail derives a plain text body and preserves the received raw message', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'mail-store-test-'));
  const storage = path.join(parent, 'new', 'mail');
  t.after(() => rm(parent, { recursive: true, force: true }));
  let saved: StoredMessage[] = [];
  const htmlRaw = Buffer.from('Subject: HTML only\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Readable content</p>');
  const store = new MailStore(storage, repository(async (messages) => { saved = messages; }));
  await store.deliver(htmlRaw, 'sender@example.net', [alice]);
  assert.equal(saved[0].textBody.trim(), 'Readable content');
  assert.deepEqual(await readFile(saved[0].rawPath), htmlRaw);
});

test('recipient-free delivery is rejected before writing files or database records', async (t) => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'mail-store-test-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  let calls = 0;
  const store = new MailStore(storage, repository(async () => { calls += 1; }));
  await assert.rejects(store.deliver(raw, 'sender@example.net', []), /local recipient/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(storage), []);
});

test('uncertain commit returns failure but retains files that may be referenced by committed records', async (t) => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'mail-store-test-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const failure = Object.assign(new Error('Commit connection lost'), { persistenceUncertain: true });
  let saved: StoredMessage[] = [];
  const store = new MailStore(storage, repository(async (messages) => {
    saved = messages;
    throw failure;
  }));
  await assert.rejects(store.deliver(raw, 'sender@example.net', [alice]), (error) => error === failure);
  assert.deepEqual(await readFile(saved[0].rawPath), raw);
  assert.equal(await readFile(saved[0].attachments[0].path, 'utf8'), 'attachment bytes');
  assert.equal((await readdir(storage)).length, 1);
});
