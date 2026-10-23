import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string): Promise<string> {
 if (password.length < 12 || password.length > 256) throw new Error('Password must contain 12 to 256 characters');
 const salt = randomBytes(16).toString('hex');
 const key = await scrypt(password, salt, 64) as Buffer;
 return 'scrypt$' + salt + '$' + key.toString('hex');
}
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
 if (typeof password !== 'string' || password.length > 256) return false;
 const parts = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(storedHash);
 if (!parts) return false;
 const actual = await scrypt(password, parts[1],64) as Buffer;
 return timingSafeEqual(actual,Buffer.from(parts[2],'hex'));
}
