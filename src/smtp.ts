import { SMTPServer, type SMTPServerSession } from 'smtp-server';
import type { InboundDelivery, MailRepository } from './contracts.js';

interface SmtpOptions {
  repository: MailRepository;
  store: InboundDelivery;
  domains: string[];
  maxMessageBytes: number;
}

function smtpError(message: string, responseCode: number): Error {
  return Object.assign(new Error(message), { responseCode });
}

/** This listener accepts local delivery only; outbound mail uses the authenticated API. */
export function createSmtpServer({ repository, store, domains, maxMessageBytes }: SmtpOptions): SMTPServer {
  const hostedDomains = new Set(domains.map((domain) => domain.toLowerCase()));
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new Error('maxMessageBytes must be a positive integer');
  }

  async function resolveRecipient(address: string) {
    const normalized = address.toLowerCase();
    const at = normalized.lastIndexOf('@');
    if (at < 1 || !hostedDomains.has(normalized.slice(at + 1))) {
      throw smtpError('Relaying denied', 550);
    }
    const mailbox = await repository.findMailbox(normalized);
    if (!mailbox) throw smtpError('No such local recipient', 550);
    return mailbox;
  }

  async function deliver(
    stream: AsyncIterable<Buffer> & { sizeExceeded?: boolean },
    session: SMTPServerSession,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
      // Continue draining the stream after the limit, without retaining oversized DATA.
      if (total <= maxMessageBytes) chunks.push(chunk);
    }
    if (total > maxMessageBytes || stream.sizeExceeded) {
      throw smtpError('Message exceeds the configured size limit', 552);
    }
    const uniqueAddresses = [...new Set(session.envelope.rcptTo.map(({ address }) => address.toLowerCase()))];
    const recipients = await Promise.all(uniqueAddresses.map(resolveRecipient));
    if (recipients.length === 0) throw smtpError('No valid recipients', 554);
    await store.deliver(Buffer.concat(chunks, total), session.envelope.mailFrom ? session.envelope.mailFrom.address : '', recipients);
  }

  return new SMTPServer({
    name: 'localhost',
    banner: 'Cyberink SMTP service',
    secure: false,
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: maxMessageBytes,
    maxClients: 50,
    socketTimeout: 60_000,
    hidePIPELINING: false,
    onRcptTo(address, session, callback) {
      if (session.envelope.rcptTo.length >= 50) {
        callback(smtpError('Too many recipients in one transaction', 452));
        return;
      }
      void resolveRecipient(address.address).then(
        () => callback(),
        (error: unknown) => callback(
          error instanceof Error && 'responseCode' in error
            ? error
            : smtpError('Recipient lookup temporarily unavailable', 451),
        ),
      );
    },
    onData(stream, session, callback) {
      void deliver(stream, session).then(
        () => callback(null, 'Message stored'),
        (error: unknown) => callback(
          error instanceof Error && 'responseCode' in error
            ? error
            : smtpError('Message could not be durably stored; try again later', 451),
        ),
      );
    },
  });
}

