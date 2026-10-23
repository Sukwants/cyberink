import { readFile } from 'node:fs/promises';
import mariadb, { type Pool } from 'mariadb';
import type {
  AppConfig, AttachmentInfo, AttachmentRecord, Mailbox, MailRepository, MessageDetail,
  MessageSummary, OutboundRecord, OutboundStatus, StoredMessage, User,
} from './contracts.js';

interface UserRow { id: number; email: string; password_hash: string }
interface MailboxRow { id: number; user_id: number; address: string }
interface MessageRow {
  id: string; from_address: string; to_address: string; subject: string;
  created_at: Date; is_read: number; text_body?: string;
}
interface AttachmentRow { id: string; filename: string; content_type: string; byte_size: number; storage_path: string }
interface OutboundRow {
  id: string; user_id: number; from_address: string; to_addresses: string | string[];
  subject: string; text_body: string; status: OutboundStatus; error_message: string | null;
}
interface ChangeResult { affectedRows: number; insertId: number | bigint }

function userFromRow(row: UserRow): User {
  return { id: row.id, email: row.email, passwordHash: row.password_hash };
}
function mailboxFromRow(row: MailboxRow): Mailbox {
  return { id: row.id, userId: row.user_id, address: row.address };
}
function summaryFromRow(row: MessageRow): MessageSummary {
  return {
    id: row.id, fromAddress: row.from_address, toAddress: row.to_address,
    subject: row.subject, createdAt: new Date(row.created_at).toISOString(), isRead: Boolean(row.is_read),
  };
}
function attachmentFromRow(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id, filename: row.filename, contentType: row.content_type,
    size: row.byte_size, path: row.storage_path,
  };
}

export class PersistenceUncertainError extends Error {
  readonly persistenceUncertain = true;

  constructor(cause: unknown) {
    super('Database commit outcome is unknown; retain received mail files for reconciliation', { cause });
    this.name = 'PersistenceUncertainError';
  }
}

export class Repository implements MailRepository {
  private readonly pool: Pool;

  constructor(config: AppConfig['db']) {
    this.pool = mariadb.createPool({
      ...config,
      insertIdAsNumber: true,
      timezone: 'Z',
      charset: 'utf8mb4',
      multipleStatements: false,
    });
  }

  async initialize(): Promise<void> {
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) {
      await this.pool.query(statement);
    }
  }

  async close(): Promise<void> { await this.pool.end(); }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const rows = await this.pool.query<UserRow[]>('SELECT id, email, password_hash FROM users WHERE email = ?', [email.toLowerCase()]);
    return rows[0] ? userFromRow(rows[0]) : undefined;
  }

  async getUser(id: number): Promise<User | undefined> {
    const rows = await this.pool.query<UserRow[]>('SELECT id, email, password_hash FROM users WHERE id = ?', [id]);
    return rows[0] ? userFromRow(rows[0]) : undefined;
  }

  async createUser(email: string, passwordHash: string): Promise<User> {
    const normalized = email.toLowerCase();
    const result = await this.pool.query<ChangeResult>('INSERT INTO users (email, password_hash) VALUES (?, ?)', [normalized, passwordHash]);
    return { id: Number(result.insertId), email: normalized, passwordHash };
  }

  async createMailbox(userId: number, address: string): Promise<Mailbox> {
    const normalized = address.toLowerCase();
    const result = await this.pool.query<ChangeResult>('INSERT INTO mailboxes (user_id, address) VALUES (?, ?)', [userId, normalized]);
    return { id: Number(result.insertId), userId, address: normalized };
  }

  async findMailbox(address: string): Promise<Mailbox | undefined> {
    const rows = await this.pool.query<MailboxRow[]>('SELECT id, user_id, address FROM mailboxes WHERE address = ?', [address.toLowerCase()]);
    return rows[0] ? mailboxFromRow(rows[0]) : undefined;
  }

  async listMailboxes(userId: number): Promise<Mailbox[]> {
    const rows = await this.pool.query<MailboxRow[]>('SELECT id, user_id, address FROM mailboxes WHERE user_id = ? ORDER BY id', [userId]);
    return rows.map(mailboxFromRow);
  }

  async saveIncoming(messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) throw new Error('An inbound delivery must have recipients');
    const connection = await this.pool.getConnection();
    let commitAttempted = false;
    try {
      await connection.beginTransaction();
      for (const message of messages) {
        await connection.query(
          'INSERT INTO messages (id, mailbox_id, from_address, to_address, subject, text_body, html_body, raw_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [message.id, message.mailboxId, message.fromAddress, message.toAddress, message.subject, message.textBody, message.htmlBody, message.rawPath, message.createdAt],
        );
        for (const attachment of message.attachments) {
          await connection.query(
            'INSERT INTO attachments (id, message_id, filename, content_type, byte_size, storage_path) VALUES (?, ?, ?, ?, ?, ?)',
            [attachment.id, message.id, attachment.filename, attachment.contentType, attachment.size, attachment.path],
          );
        }
      }
      commitAttempted = true;
      await connection.commit();
    } catch (error) {
      if (commitAttempted) throw new PersistenceUncertainError(error);
      try { await connection.rollback(); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Inbound transaction and rollback failed', { cause: rollbackError }); }
      throw error;
    } finally {
      try { await connection.release(); }
      catch {
        // Pool bookkeeping cannot invalidate a committed delivery or mask the original failure.
        connection.destroy();
      }
    }
  }

  async listMessages(userId: number): Promise<MessageSummary[]> {
    const rows = await this.pool.query<MessageRow[]>(
      'SELECT m.id, m.from_address, m.to_address, m.subject, m.created_at, m.is_read FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ? AND m.is_deleted = FALSE ORDER BY m.created_at DESC, m.id DESC',
      [userId],
    );
    return rows.map(summaryFromRow);
  }

  async getMessage(userId: number, id: string): Promise<MessageDetail | undefined> {
    const rows = await this.pool.query<MessageRow[]>(
      'SELECT m.id, m.from_address, m.to_address, m.subject, m.created_at, m.is_read, m.text_body FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ? AND m.id = ? AND m.is_deleted = FALSE',
      [userId, id],
    );
    if (!rows[0]) return undefined;
    const attachments = await this.pool.query<AttachmentRow[]>('SELECT id, filename, content_type, byte_size, storage_path FROM attachments WHERE message_id = ? ORDER BY id', [id]);
    const safeAttachments: AttachmentInfo[] = attachments.map((attachment) => ({
      id: attachment.id, filename: attachment.filename, contentType: attachment.content_type, size: attachment.byte_size,
    }));
    return { ...summaryFromRow(rows[0]), textBody: rows[0].text_body || '', attachments: safeAttachments };
  }

  async setRead(userId: number, id: string, isRead: boolean): Promise<boolean> {
    const result = await this.pool.query<ChangeResult>(
      'UPDATE messages m JOIN mailboxes b ON b.id = m.mailbox_id SET m.is_read = ? WHERE b.user_id = ? AND m.id = ? AND m.is_deleted = FALSE',
      [isRead, userId, id],
    );
    if (result.affectedRows > 0) return true;
    const rows = await this.pool.query<Array<{ id: string }>>(
      'SELECT m.id FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ? AND m.id = ? AND m.is_deleted = FALSE',
      [userId, id],
    );
    return rows.length > 0;
  }

  async deleteMessage(userId: number, id: string): Promise<boolean> {
    const result = await this.pool.query<ChangeResult>(
      'UPDATE messages m JOIN mailboxes b ON b.id = m.mailbox_id SET m.is_deleted = TRUE WHERE b.user_id = ? AND m.id = ? AND m.is_deleted = FALSE',
      [userId, id],
    );
    return result.affectedRows > 0;
  }

  async getAttachment(userId: number, id: string): Promise<AttachmentRecord | undefined> {
    const rows = await this.pool.query<AttachmentRow[]>(
      'SELECT a.id, a.filename, a.content_type, a.byte_size, a.storage_path FROM attachments a JOIN messages m ON m.id = a.message_id JOIN mailboxes b ON b.id = m.mailbox_id WHERE b.user_id = ? AND a.id = ? AND m.is_deleted = FALSE',
      [userId, id],
    );
    return rows[0] ? attachmentFromRow(rows[0]) : undefined;
  }

  async createOutbound(record: OutboundRecord): Promise<void> {
    await this.pool.query(
      'INSERT INTO outbound_messages (id, user_id, from_address, to_addresses, subject, text_body, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [record.id, record.userId, record.from, JSON.stringify(record.to), record.subject, record.text, record.status, record.error],
    );
  }

  async setOutboundStatus(id: string, userId: number, status: OutboundStatus, error?: string): Promise<void> {
    const result = await this.pool.query<ChangeResult>(
      'UPDATE outbound_messages SET status = ?, error_message = ? WHERE id = ? AND user_id = ?',
      [status, error ?? null, id, userId],
    );
    if (result.affectedRows === 0 && !(await this.getOutbound(userId, id))) {
      throw new Error('Outbound message does not exist');
    }
  }

  async getOutbound(userId: number, id: string): Promise<OutboundRecord | undefined> {
    const rows = await this.pool.query<OutboundRow[]>(
      'SELECT id, user_id, from_address, to_addresses, subject, text_body, status, error_message FROM outbound_messages WHERE user_id = ? AND id = ?',
      [userId, id],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id, userId: row.user_id, from: row.from_address,
      to: typeof row.to_addresses === 'string' ? JSON.parse(row.to_addresses) as string[] : row.to_addresses,
      subject: row.subject, text: row.text_body, status: row.status, error: row.error_message,
    };
  }
}
