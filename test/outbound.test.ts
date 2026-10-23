import assert from 'node:assert/strict';
import test from 'node:test';
import type { SendMailOptions } from 'nodemailer';
import type { MailRepository, OutboundRecord, OutboundStatus, SendInput } from '../src/contracts.js';
import { OutboundError, OutboundService, type OutboundTransport, type RelayResult } from '../src/outbound.js';

const relay = { host: '127.0.0.1', port: 2526, secure: false };
const input: SendInput = {
  from: 'alice@example.test',
  to: ['bob@example.net'],
  subject: 'Outbound local test',
  text: 'Hello from the test transport',
};

function harness(
  send: (message: SendMailOptions) => Promise<RelayResult> = async () => ({ accepted: input.to, rejected: [] }),
) {
  const events: string[] = [];
  const records: OutboundRecord[] = [];
  const updates: Array<{ id: string; userId: number; status: OutboundStatus; error?: string }> = [];
  let sendCount = 0;
  const repository = {
    findMailbox: async (address: string) => address === input.from
      ? { id: 1, userId: 7, address } : undefined,
    createOutbound: async (record: OutboundRecord) => {
      events.push('persist pending');
      records.push(structuredClone(record));
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
  const service = new OutboundService(repository, relay, transport);
  return { service, repository, records, updates, events, sendCount: () => sendCount };
}

test('outbound persists pending before sending and records success only after all recipients are accepted', async () => {
  const h = harness(async (message) => {
    assert.equal(message.from, input.from);
    assert.deepEqual(message.envelope, { from: input.from, to: input.to });
    assert.match(String(message.messageId), /^<[^@]+@example\.test>$/);
    return { accepted: input.to, rejected: [] };
  });
  const result = await h.service.send(7, input);
  assert.equal(h.records[0]?.status, 'pending');
  assert.equal(result.status, 'sent');
  assert.equal(result.error, null);
  assert.equal(h.updates[0]?.id, result.id);
  assert.equal(h.updates[0]?.userId, 7);
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

test('outbound rejects malformed recipients and header injection before sending', async () => {
  const h = harness();
  for (const invalid of [
    { ...input, to: [] },
    { ...input, to: ['Bob <bob@example.net>'] },
    { ...input, to: ['bob@example.net\r\nBcc: evil@example.net'] },
    { ...input, subject: 'Subject\r\nBcc: evil@example.net' },
  ]) {
    await assert.rejects(h.service.send(7, invalid), (error: unknown) =>
      error instanceof OutboundError && error.statusCode === 400);
  }
  assert.equal(h.sendCount(), 0);
  assert.equal(h.records.length, 0);
});
