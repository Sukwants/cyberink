export interface User { id: number; email: string; passwordHash: string }
export interface Mailbox { id: number; userId: number; address: string }
export interface AttachmentRecord { id: string; filename: string; contentType: string; size: number; path: string }
export type AttachmentInfo = Omit<AttachmentRecord, 'path'>;
export interface StoredMessage { id: string; mailboxId: number; fromAddress: string; toAddress: string; subject: string; textBody: string; htmlBody: string; rawPath: string; createdAt: Date; attachments: AttachmentRecord[] }
export interface MessageSummary { id: string; fromAddress: string; toAddress: string; subject: string; createdAt: string; isRead: boolean }
export interface MessageDetail extends MessageSummary { textBody: string; attachments: AttachmentInfo[] }
export type OutboundStatus = 'pending' | 'sent' | 'temp_failed' | 'permanent_failed' | 'unknown';
export interface SendAttachment { filename: string; contentType: string; content: Buffer }
export interface SendInput { from: string; to: string[]; subject: string; text: string; attachments?: SendAttachment[] }
export interface OutboundSummary { id: string; userId: number; from: string; to: string[]; subject: string; status: OutboundStatus; error: string | null; createdAt: string }
export interface OutboundRecord extends OutboundSummary { text: string; attachments: AttachmentInfo[] }
export interface MailRepository {
 initialize(): Promise<void>; close(): Promise<void>;
 findUserByEmail(email: string): Promise<User | undefined>;
 getUser(id: number): Promise<User | undefined>;
 createUser(email: string, passwordHash: string): Promise<User>;
 createMailbox(userId: number, address: string): Promise<Mailbox>;
 findMailbox(address: string): Promise<Mailbox | undefined>;
 listMailboxes(userId: number): Promise<Mailbox[]>;
 saveIncoming(messages: StoredMessage[]): Promise<void>;
 listMessages(userId: number): Promise<MessageSummary[]>;
 getMessage(userId: number, id: string): Promise<MessageDetail | undefined>;
 setRead(userId: number, id: string, isRead: boolean): Promise<boolean>;
 deleteMessage(userId: number, id: string): Promise<boolean>;
 getAttachment(userId: number, id: string): Promise<AttachmentRecord | undefined>;
 createOutbound(record: OutboundRecord, attachments?: AttachmentRecord[]): Promise<void>;
 listSent(userId: number): Promise<OutboundSummary[]>;
 deleteSent(userId: number, id: string): Promise<boolean>;
 getOutboundAttachment(userId: number, id: string): Promise<AttachmentRecord | undefined>;
 setOutboundStatus(id: string, userId: number, status: OutboundStatus, error?: string): Promise<void>;
 getOutbound(userId: number, id: string): Promise<OutboundRecord | undefined>;
}
export interface InboundDelivery { deliver(raw: Buffer, from: string, recipients: Mailbox[]): Promise<void> }
export interface OutboundSender { send(userId: number, input: SendInput): Promise<OutboundRecord> }
export interface AppConfig {
 env: 'development' | 'production'; host: string; httpPort: number; smtpPort: number;
 domains: string[]; maxMessageBytes: number; maxAttachments: number; maxAttachmentBytes: number; storageDir: string;
 db: { host: string; port: number; user: string; password: string; database: string; connectionLimit: number };
 relay: { host: string; port: number; secure: boolean; user?: string; password?: string };
 sessionTtlMs: number; secureCookies: boolean; trustedProxies?: string[];
}
