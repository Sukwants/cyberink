import { randomUUID } from 'node:crypto';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import type {
  AppConfig, MailRepository, OutboundRecord, OutboundSender, OutboundStatus, SendAttachment, SendInput,
} from './contracts.js';
import { DEFAULT_MAX_ATTACHMENTS, MAX_CONFIGURED_ATTACHMENTS } from './limits.js';
import { OutboundAttachmentStore } from './outbound-store.js';

export interface RelayResult {
  accepted?: Array<string | { address: string }>;
  rejected?: Array<string | { address: string }>;
}

export interface OutboundTransport {
  sendMail(message: SendMailOptions): Promise<RelayResult>;
}

export interface OutboundOptions {
  storageDir?: string;
  maxMessageBytes?: number;
  maxAttachments?: number;
  maxAttachmentBytes?: number;
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

function normalizeInput(input: SendInput, maxMessageBytes: number, maxAttachments: number, maxAttachmentBytes: number): Required<SendInput> {
  if (!input || !Array.isArray(input.to) || input.to.length === 0 || input.to.length > 50 ||
      typeof input.subject !== 'string' || input.subject.length > 998 || /[\r\n]/.test(input.subject) ||
      typeof input.text !== 'string' || input.text.length > 200_000 ||
      (input.attachments !== undefined && !Array.isArray(input.attachments))) {
    throw new OutboundError('Invalid mail request', 400);
  }
  const sourceAttachments = input.attachments ?? [];
  if (sourceAttachments.length > maxAttachments) {
    throw new OutboundError('Too many attachments', 400);
  }
  let contentBytes = Buffer.byteLength(input.text, 'utf8');
  for (const attachment of sourceAttachments) {
    if (!attachment || typeof attachment !== 'object' ||
        Object.keys(attachment).some((key) => !['filename', 'contentType', 'content'].includes(key)) ||
        !Buffer.isBuffer(attachment.content) ||
        typeof attachment.filename !== 'string' || attachment.filename.length === 0 ||
        attachment.filename.length > 255 || /^[.]{1,2}$/.test(attachment.filename) ||
        /[\\/]/.test(attachment.filename) ||
        [...attachment.filename].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
        typeof attachment.contentType !== 'string' || attachment.contentType.length > 255 ||
        !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(attachment.contentType)) {
      throw new OutboundError('Invalid attachment', 400);
    }
    if (attachment.content.length > maxAttachmentBytes) {
      throw new OutboundError('Attachment exceeds the configured file size limit', 413);
    }
    contentBytes += attachment.content.length;
  }
  // Avoid copying obviously oversized input; canonical MIME size is checked after composition.
  if (contentBytes > maxMessageBytes) {
    throw new OutboundError('Message exceeds the configured size limit', 413);
  }
  return {
    from: normalizeAddress(input.from),
    to: [...new Set(input.to.map(normalizeAddress))],
    subject: input.subject,
    text: input.text,
    attachments: sourceAttachments.map((attachment): SendAttachment => ({
      filename: attachment.filename,
      contentType: attachment.contentType.toLowerCase(),
      content: Buffer.from(attachment.content),
    })),
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
  return { status: 'unknown', detail: 'Relay delivery result is uncertain; inspect before resending' };
}

export class OutboundService implements OutboundSender {
  private readonly transport: OutboundTransport;
  private readonly store: OutboundAttachmentStore;
  private readonly maxMessageBytes: number;
  private readonly maxAttachments: number;
  private readonly maxAttachmentBytes: number;
  private readonly composer = nodemailer.createTransport({
    streamTransport: true, buffer: true, newline: 'windows',
    disableFileAccess: true, disableUrlAccess: true,
  });

  constructor(
    private readonly repository: MailRepository,
    relay: AppConfig['relay'],
    transport?: OutboundTransport,
    options: OutboundOptions = {},
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 1) {
      throw new Error('maxMessageBytes must be a positive integer');
    }
    this.maxAttachments = options.maxAttachments === undefined ? DEFAULT_MAX_ATTACHMENTS : options.maxAttachments;
    if (!Number.isInteger(this.maxAttachments) || this.maxAttachments < 0 || this.maxAttachments > MAX_CONFIGURED_ATTACHMENTS) {
      throw new Error('maxAttachments must be an integer between 0 and ' + MAX_CONFIGURED_ATTACHMENTS);
    }
    this.maxAttachmentBytes = options.maxAttachmentBytes === undefined ? this.maxMessageBytes : options.maxAttachmentBytes;
    if (!Number.isSafeInteger(this.maxAttachmentBytes) || this.maxAttachmentBytes < 1 || this.maxAttachmentBytes > this.maxMessageBytes) {
      throw new Error('maxAttachmentBytes must be a positive integer no greater than maxMessageBytes');
    }
    this.store = new OutboundAttachmentStore(options.storageDir ?? '.data/mail');
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
    const mail = normalizeInput(input, this.maxMessageBytes, this.maxAttachments, this.maxAttachmentBytes);
    const mailbox = await this.repository.findMailbox(mail.from);
    if (!mailbox || mailbox.userId !== userId) {
      throw new OutboundError('The sender mailbox does not belong to this user', 403);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const envelope = { from: mail.from, to: mail.to };
    const compiled = await this.composer.sendMail({
      from: mail.from, to: mail.to, subject: mail.subject, text: mail.text,
      date: new Date(createdAt),
      messageId: '<' + id + '@' + mail.from.split('@')[1] + '>',
      envelope,
      attachments: mail.attachments.map((attachment) => ({
        filename: attachment.filename, contentType: attachment.contentType, content: attachment.content,
      })),
    });
    if (!Buffer.isBuffer(compiled.message)) throw new Error('MIME composition did not return a buffer');
    const raw = compiled.message;
    if (raw.length > this.maxMessageBytes) {
      throw new OutboundError('Message exceeds the configured size limit', 413);
    }

    const saved = await this.store.save(mail.attachments);
    const record: OutboundRecord = {
      id, userId, from: mail.from, to: mail.to, subject: mail.subject, text: mail.text,
      createdAt, status: 'pending', error: null,
      attachments: saved.attachments.map(({ id, filename, contentType, size }) => ({ id, filename, contentType, size })),
    };
    try {
      await this.repository.createOutbound(record, saved.attachments);
    } catch (error) {
      // A lost COMMIT response may already expose the record and its attachments.
      if (!(error instanceof Error && 'persistenceUncertain' in error && error.persistenceUncertain === true)) {
        try { await saved.discard(); }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Outbound persistence failed and new files could not be removed', { cause: cleanupError });
        }
      }
      throw error;
    }

    let status: OutboundStatus;
    let detail: string | undefined;
    try {
      // Send the exact MIME bytes checked above, with the same stable Message-ID.
      const result = await this.transport.sendMail({ raw, envelope });
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

    // Failed or uncertain deliveries retain their attachment files and are never auto-retried.
    await this.repository.setOutboundStatus(record.id, userId, status, detail);
    return { ...record, status, error: detail ?? null };
  }
}
