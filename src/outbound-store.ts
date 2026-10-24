import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentRecord, SendAttachment } from './contracts.js';

export interface SavedOutboundAttachments {
  attachments: AttachmentRecord[];
  discard(): Promise<void>;
}

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

/** Only generated names reach the filesystem; original filenames remain display metadata. */
export class OutboundAttachmentStore {
  private readonly directory: string;

  constructor(storageDir: string) {
    this.directory = path.join(path.resolve(storageDir), 'outbound');
  }

  async save(attachments: readonly SendAttachment[]): Promise<SavedOutboundAttachments> {
    if (attachments.length === 0) return { attachments: [], discard: async () => {} };

    const firstCreated = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (firstCreated) {
      const existingParent = path.dirname(firstCreated);
      for (let directory = this.directory; ; directory = path.dirname(directory)) {
        await syncDirectory(directory);
        if (directory === existingParent) break;
      }
    }
    const deliveryDir = await mkdtemp(path.join(this.directory, 'request-'));
    const discard = async () => {
      await rm(deliveryDir, { recursive: true, force: true });
      await syncDirectory(this.directory);
    };
    try {
      await syncDirectory(this.directory);
      const records: AttachmentRecord[] = [];
      for (const attachment of attachments) {
        const id = randomUUID();
        const attachmentPath = path.join(deliveryDir, id);
        await durableWrite(attachmentPath, attachment.content);
        records.push({
          id, filename: attachment.filename, contentType: attachment.contentType,
          size: attachment.content.length, path: attachmentPath,
        });
      }
      await syncDirectory(deliveryDir);
      return { attachments: records, discard };
    } catch (error) {
      try { await discard(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Outbound attachment storage failed and new files could not be removed', { cause: cleanupError });
      }
      throw error;
    }
  }
}
