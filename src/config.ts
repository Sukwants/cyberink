import path from 'node:path';
import dotenv from 'dotenv';
import { isIP } from 'node:net';
import { DEFAULT_MAX_ATTACHMENTS, MAX_CONFIGURED_ATTACHMENTS } from './limits.js';
import type { AppConfig } from './contracts.js';

function integer(value: string | undefined, fallback: number, max = 65535, min = 1, name = 'numeric configuration'): number {
 if (value !== undefined && value.trim() === '') throw new Error('Invalid ' + name);
 const n = Number(value ?? fallback);
 if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid ' + name);
 return n;
}
export function buildConfig(e: NodeJS.ProcessEnv): AppConfig {
 const env = e.NODE_ENV ?? 'development';
 if (!['development','production'].includes(env)) throw new Error('Invalid NODE_ENV');
 const trustedProxies = (e.TRUST_PROXY ?? '').split(',').map(value => value.trim()).filter(Boolean);
 if (trustedProxies.some(address => !isIP(address))) throw new Error('TRUST_PROXY must be a comma-separated list of proxy IP addresses');
 const maxMessageBytes = integer(e.MAX_MESSAGE_BYTES, 10 * 1024 * 1024, 50 * 1024 * 1024);
 const config: AppConfig = {
  env: env as AppConfig['env'], trustedProxies, host: e.HOST ?? '127.0.0.1',
  httpPort: integer(e.HTTP_PORT, 3000), smtpPort: integer(e.SMTP_PORT, 2525),
  domains: (e.MAIL_DOMAINS ?? 'example.test').split(',').map(s => s.trim().toLowerCase()),
  maxMessageBytes,
  maxAttachments: integer(e.MAX_ATTACHMENTS, DEFAULT_MAX_ATTACHMENTS, MAX_CONFIGURED_ATTACHMENTS, 0, 'MAX_ATTACHMENTS'),
  maxAttachmentBytes: integer(e.MAX_ATTACHMENT_BYTES, maxMessageBytes, maxMessageBytes, 1, 'MAX_ATTACHMENT_BYTES'),
  storageDir: path.resolve(e.STORAGE_DIR ?? '.data/mail'),
  db: { host: e.DB_HOST ?? '127.0.0.1', port: integer(e.DB_PORT,3306), user: e.DB_USER ?? '', password: e.DB_PASSWORD ?? '', database: e.DB_DATABASE ?? '', connectionLimit: 5 },
  relay: {host: e.RELAY_HOST ?? '127.0.0.1', port: integer(e.RELAY_PORT,2526), secure: e.RELAY_SECURE === 'true', user: e.RELAY_USER || undefined, password: e.RELAY_PASSWORD || undefined},
  sessionTtlMs: 8 * 60 * 60 * 1000, secureCookies: env === 'production'
 };
 if (!config.db.user || !config.db.database || !config.db.password) throw new Error('Database credentials are required');
 if (config.domains.some(d => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(d))) throw new Error('Invalid hosted domain');
 if (env === 'production' && (!config.relay.secure || !config.relay.user || !config.relay.password)) throw new Error('Production requires an authenticated TLS relay');
 return config;
}
export function loadConfig(): AppConfig {
 dotenv.config({path: process.env.MAIL_ENV_FILE ?? '.env', quiet: true});
 return buildConfig(process.env);
}
