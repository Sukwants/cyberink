import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import type { AttachmentRecord, InboundDelivery, Mailbox, MailRepository, StoredMessage } from './contracts.js';

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function durableWrite(filename: string, content: Buffer): Promise<void> {
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Durable files precede the database commit. Known failures remove only this delivery's files. */
export class MailStore implements InboundDelivery {
  private readonly storageDir: string;

  constructor(storageDir: string, private readonly repository: MailRepository) {
    this.storageDir = path.resolve(storageDir);
  }

  async deliver(raw: Buffer, from: string, recipients: Mailbox[]): Promise<void> {
    const mailboxes = [...new Map(recipients.map((recipient) => [recipient.id, recipient])).values()];
    if (mailboxes.length === 0) throw new Error('Delivery requires at least one local recipient');

    // mailparser also derives plain text from HTML-only mail; the API only exposes this text.
    const parsed = await simpleParser(raw, { skipTextToHtml: true });
    const firstCreated = await mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    if (firstCreated) {
      // Persist all newly created storage ancestors, including the first new entry in its parent.
      const existingParent = path.dirname(firstCreated);
      for (let directory = this.storageDir; ; directory = path.dirname(directory)) {
        await syncDirectory(directory);
        if (directory === existingParent) break;
      }
    }
    const deliveryDir = await mkdtemp(path.join(this.storageDir, 'delivery-'));
    try {
      await syncDirectory(this.storageDir);
      const rawPath = path.join(deliveryDir, 'message.eml');
      await durableWrite(rawPath, raw);
      const savedAttachments: AttachmentRecord[] = [];
      for (const attachment of parsed.attachments) {
        const id = randomUUID();
        const attachmentPath = path.join(deliveryDir, id);
        await durableWrite(attachmentPath, attachment.content);
        savedAttachments.push({
          id,
          filename: (attachment.filename || 'attachment').slice(0, 1024),
          contentType: (attachment.contentType || 'application/octet-stream').slice(0, 255),
          size: attachment.content.length,
          path: attachmentPath,
        });
      }
      const createdAt = new Date();
      const messages: StoredMessage[] = mailboxes.map((mailbox) => ({
        id: randomUUID(),
        mailboxId: mailbox.id,
        fromAddress: from,
        toAddress: mailbox.address,
        subject: parsed.subject || '',
        textBody: parsed.text || '',
        htmlBody: typeof parsed.html === 'string' ? parsed.html : '',
        rawPath,
        createdAt,
        // Each recipient has an independently scoped attachment ID, while bytes are shared.
        attachments: savedAttachments.map((attachment) => ({ ...attachment, id: randomUUID() })),
      }));
      await syncDirectory(deliveryDir);
      await this.repository.saveIncoming(messages);
    } catch (error) {
      // A lost COMMIT response may already have created visible records. Preserve their bytes.
      if (error instanceof Error && 'persistenceUncertain' in error && error.persistenceUncertain === true) {
        throw error;
      }
      try {
        await rm(deliveryDir, { recursive: true, force: true });
        await syncDirectory(this.storageDir);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Delivery failed and new mail files could not be removed', { cause: cleanupError });
      }
      throw error;
    }
  }
}
