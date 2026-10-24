import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import mariadb, { type Pool } from 'mariadb';
import type { AttachmentRecord, OutboundRecord } from '../src/contracts.js';
import { PersistenceUncertainError, Repository } from '../src/repository.js';

const attachment: AttachmentRecord = {
  id: '00000000-0000-4000-8000-000000000002', filename: 'example.bin',
  contentType: 'application/octet-stream', size: 4, path: '/private/test/outbound.bin',
};
const record: OutboundRecord = {
  id: '00000000-0000-4000-8000-000000000001', userId: 1,
  from: 'alice@example.test', to: ['recipient@example.test'], subject: 'Transactional attachment',
  text: 'body', status: 'pending', error: null, createdAt: '2026-10-24T00:00:00.000Z',
  attachments: [{ id: attachment.id, filename: attachment.filename, contentType: attachment.contentType, size: attachment.size }],
};

function setup(t: TestContext, fault?: 'attachment' | 'commit' | 'release') {
  const failure = new Error('Injected ' + fault + ' failure');
  const events: string[] = [];
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    beginTransaction: async () => { events.push('begin'); },
    query: async (sql: string, values: unknown[]) => {
      events.push(sql.includes('outbound_attachments') ? 'attachment' : 'intent');
      writes.push({ sql, values });
      if (fault === 'attachment' && sql.includes('outbound_attachments')) throw failure;
    },
    commit: async () => {
      events.push('commit');
      if (fault === 'commit') throw failure;
    },
    rollback: async () => { events.push('rollback'); },
    release: async () => {
      events.push('release');
      if (fault === 'release') throw failure;
    },
    destroy: () => { events.push('destroy'); },
  };
  const pool = { getConnection: async () => connection, end: async () => {} };
  t.mock.method(mariadb, 'createPool', () => pool as unknown as Pool);
  const repository = new Repository({ host: '127.0.0.1', port: 3306, user: 'unused', password: 'unused', database: 'unused', connectionLimit: 1 });
  return { repository, events, writes, failure };
}

test('outbound intent and attachment records are committed together with a persisted creation date', async (t) => {
  const { repository, events, writes } = setup(t);
  await repository.createOutbound(record, [attachment]);
  assert.deepEqual(events, ['begin', 'intent', 'attachment', 'commit', 'release']);
  assert.equal(writes[0].values[8] instanceof Date, true);
  assert.equal((writes[0].values[8] as Date).toISOString(), record.createdAt);
  assert.equal(writes[1].values[1], record.id);
  assert.equal(writes[1].values[5], attachment.path);
  assert.equal(writes.flatMap((write) => write.values).some(Buffer.isBuffer), false);
});

test('failure while inserting outbound attachment rolls back intent and preserves the original error', async (t) => {
  const { repository, events, failure } = setup(t, 'attachment');
  await assert.rejects(repository.createOutbound(record, [attachment]), (error) => error === failure);
  assert.deepEqual(events, ['begin', 'intent', 'attachment', 'rollback', 'release']);
});

test('unknown outbound COMMIT outcome marks persistence uncertain so attachment files can be retained', async (t) => {
  const { repository, events, failure } = setup(t, 'commit');
  await assert.rejects(repository.createOutbound(record, [attachment]), (error) =>
    error instanceof PersistenceUncertainError && error.persistenceUncertain === true && error.cause === failure);
  assert.deepEqual(events, ['begin', 'intent', 'attachment', 'commit', 'release']);
});

test('pool release failure cannot turn a committed outbound intent into a failed save', async (t) => {
  const { repository, events } = setup(t, 'release');
  await repository.createOutbound(record, []);
  assert.deepEqual(events, ['begin', 'intent', 'commit', 'release', 'destroy']);
});
