import { randomUUID } from 'node:crypto';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import type {
  AppConfig, MailRepository, OutboundRecord, OutboundSender, OutboundStatus, SendInput,
} from './contracts.js';

export interface RelayResult {
  accepted?: Array<string | { address: string }>;
  rejected?: Array<string | { address: string }>;
}

export interface OutboundTransport {
  sendMail(message: SendMailOptions): Promise<RelayResult>;
}

export class OutboundError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'OutboundError';
  }
}

function normalizeAddress(address: string): string {
  if (typeof address !== 'string' || address.length > 254 ||
      !/^[^\s<>@,;:]+@[^\s<>@,;:]+\.[^\s<>@,;:]+$/.test(address)) {
    throw new OutboundError('Invalid email address', 400);
  }
  return address.toLowerCase();
}

function normalizeInput(input: SendInput): SendInput {
  if (!input || !Array.isArray(input.to) || input.to.length === 0 || input.to.length > 50 ||
      typeof input.subject !== 'string' || input.subject.length > 998 || /[\r\n]/.test(input.subject) ||
      typeof input.text !== 'string') {
    throw new OutboundError('Invalid mail request', 400);
  }
  return {
    from: normalizeAddress(input.from),
    to: [...new Set(input.to.map(normalizeAddress))],
    subject: input.subject,
    text: input.text,
  };
}

function addressOf(address: string | { address: string }): string {
  return (typeof address === 'string' ? address : address.address).toLowerCase();
}

function classifyFailure(error: unknown): { status: OutboundStatus; detail: string } {
  const responseCode = typeof error === 'object' && error !== null && 'responseCode' in error
    ? error.responseCode : undefined;
  if (typeof responseCode === 'number' && responseCode >= 400 && responseCode < 500) {
    return { status: 'temp_failed', detail: 'SMTP relay temporarily rejected delivery (' + responseCode + ')' };
  }
  if (typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600) {
    return { status: 'permanent_failed', detail: 'SMTP relay permanently rejected delivery (' + responseCode + ')' };
  }
  // An interrupted connection may occur after the relay has accepted DATA.
  return { status: 'unknown', detail: 'Relay delivery result is uncertain; inspect before resending' };
}

export class OutboundService implements OutboundSender {
  private readonly transport: OutboundTransport;

  constructor(
    private readonly repository: MailRepository,
    relay: AppConfig['relay'],
    transport?: OutboundTransport,
  ) {
    this.transport = transport ?? nodemailer.createTransport({
      host: relay.host,
      port: relay.port,
      secure: relay.secure,
      auth: relay.user ? { user: relay.user, pass: relay.password ?? '' } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(userId: number, input: SendInput): Promise<OutboundRecord> {
    const mail = normalizeInput(input);
    const mailbox = await this.repository.findMailbox(mail.from);
    if (!mailbox || mailbox.userId !== userId) {
      throw new OutboundError('The sender mailbox does not belong to this user', 403);
    }

    const record: OutboundRecord = {
      ...mail, id: randomUUID(), userId, status: 'pending', error: null,
    };
    // Persist intent before any network activity; pending and uncertain records are never auto-retried.
    await this.repository.createOutbound(record);

    let status: OutboundStatus;
    let detail: string | undefined;
    try {
      const result = await this.transport.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        messageId: '<' + record.id + '@' + mail.from.split('@')[1] + '>',
        envelope: { from: mail.from, to: mail.to },
      });
      const accepted = new Set((result.accepted ?? []).map(addressOf));
      if ((result.rejected?.length ?? 0) === 0 && mail.to.every((address) => accepted.has(address))) {
        status = 'sent';
      } else {
        status = 'unknown';
        detail = 'Relay did not confirm acceptance of every recipient; inspect before resending';
      }
    } catch (error: unknown) {
      const failure = classifyFailure(error);
      status = failure.status;
      detail = failure.detail;
    }

    // A database failure here propagates instead of incorrectly claiming successful persistence.
    await this.repository.setOutboundStatus(record.id, userId, status, detail);
    return { ...record, status, error: detail ?? null };
  }
}
