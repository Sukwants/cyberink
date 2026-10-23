import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import test, { type TestContext } from 'node:test';
import type { MailRepository, Mailbox } from '../src/contracts.js';
import { createSmtpServer } from '../src/smtp.js';

interface Reply { code: number; text: string }

class LocalSmtpClient {
  private buffer = '';
  private lines: string[] = [];
  private replies: Reply[] = [];
  private waiting?: { resolve: (reply: Reply) => void; reject: (error: Error) => void };
  private failure?: Error;
  readonly socket: Socket;

  constructor(port: number) {
    this.socket = createConnection({ host: '127.0.0.1', port });
    this.socket.setTimeout(3000, () => this.socket.destroy(new Error('SMTP test connection timed out')));
    this.socket.on('error', (error) => {
      this.failure = error;
      this.waiting?.reject(error);
      this.waiting = undefined;
    });
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let end: number;
      while ((end = this.buffer.indexOf('\r\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        this.lines.push(line);
        if (/^\d{3} /.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: this.lines.join('\n') };
          this.lines = [];
          if (this.waiting) {
            this.waiting.resolve(reply);
            this.waiting = undefined;
          } else {
            this.replies.push(reply);
          }
        }
      }
    });
  }

  private read(): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  async expect(code: number): Promise<Reply> {
    const reply = await this.read();
    assert.equal(reply.code, code, reply.text);
    return reply;
  }

  async command(line: string, code: number): Promise<Reply> {
    this.socket.write(line + '\r\n');
    return this.expect(code);
  }

  async begin(from = 'sender@example.net'): Promise<void> {
    await this.expect(220);
    await this.command('EHLO localhost', 250);
    // Deliberately omit SIZE so DATA size enforcement is exercised independently.
    await this.command('MAIL FROM:<' + from + '>', 250);
  }
}

async function fixture(t: TestContext, options: { failLookup?: boolean; failStore?: boolean; everyMailbox?: boolean } = {}) {
  const deliveries: Array<{ raw: Buffer; from: string; recipients: Mailbox[] }> = [];
  const repository = {
    findMailbox: async (address: string) => {
      if (options.failLookup) throw new Error('Database lookup failed');
      return options.everyMailbox || address === 'alice@example.test'
        ? { id: 1, userId: 1, address } : undefined;
    },
  } as unknown as MailRepository;
  const server = createSmtpServer({
    repository,
    store: {
      deliver: async (raw, from, recipients) => {
        if (options.failStore) throw new Error('Storage or transaction failed');
        deliveries.push({ raw, from, recipients });
      },
    },
    domains: ['example.test'],
    maxMessageBytes: 2048,
  });
  const sockets: Socket[] = [];
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return {
    deliveries,
    connect() {
      const client = new LocalSmtpClient(address.port);
      sockets.push(client.socket);
      return client;
    },
  };
}

test('SMTP accepts a real local recipient and rejects missing mailboxes and external relay targets', async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  await client.begin();
  await client.command('RCPT TO:<missing@example.test>', 550);
  await client.command('RCPT TO:<victim@example.net>', 550);
  await client.command('RCPT TO:<alice@example.test>', 250);
  await client.command('DATA', 354);
  await client.command('Subject: Local test\r\n\r\nHello from raw SMTP\r\n.', 250);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0]?.from, 'sender@example.net');
  assert.equal(f.deliveries[0]?.recipients[0]?.address, 'alice@example.test');
  assert.match(f.deliveries[0]!.raw.toString(), /Hello from raw SMTP/);
});

test('SMTP returns 451 when recipient lookup is unavailable', async (t) => {
  const f = await fixture(t, { failLookup: true });
  const client = f.connect();
  await client.begin();
  await client.command('RCPT TO:<alice@example.test>', 451);
  assert.equal(f.deliveries.length, 0);
});

test('SMTP returns 451 after DATA when durable storage fails', async (t) => {
  const f = await fixture(t, { failStore: true });
  const client = f.connect();
  await client.begin();
  await client.command('RCPT TO:<alice@example.test>', 250);
  await client.command('DATA', 354);
  await client.command('Subject: Failed persistence\r\n\r\nMust not return success\r\n.', 451);
  assert.equal(f.deliveries.length, 0);
});

test('SMTP rejects oversized DATA with 552 even without an advertised SIZE', async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  await client.begin();
  await client.command('RCPT TO:<alice@example.test>', 250);
  await client.command('DATA', 354);
  await client.command('Subject: Oversized\r\n\r\n' + ('x'.repeat(500) + '\r\n').repeat(6) + '.', 552);
  assert.equal(f.deliveries.length, 0);
});

test('SMTP caps recipients per transaction and resets the cap after RSET', async (t) => {
  const f = await fixture(t, { everyMailbox: true });
  const client = f.connect();
  await client.begin();
  for (let index = 0; index < 50; index += 1) {
    await client.command('RCPT TO:<box' + index + '@example.test>', 250);
  }
  await client.command('RCPT TO:<box50@example.test>', 452);
  await client.command('RSET', 250);
  await client.command('MAIL FROM:<sender@example.net>', 250);
  await client.command('RCPT TO:<alice@example.test>', 250);
  assert.equal(f.deliveries.length, 0);
});

test('SMTP accepts the empty reverse path used by bounce messages', async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  await client.begin('');
  await client.command('RCPT TO:<alice@example.test>', 250);
  await client.command('DATA', 354);
  await client.command('Subject: Bounce\r\n\r\nDelivery status notification\r\n.', 250);
  assert.equal(f.deliveries[0]?.from, '');
});
