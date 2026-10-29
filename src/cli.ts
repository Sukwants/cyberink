import { loadConfig } from './config.js';
import { Repository } from './repository.js';
import { hashPassword } from './auth.js';
const config = loadConfig();
const repository = new Repository(config.db);
try {
 if (process.argv[2] === 'init') {
  await repository.initialize();
  console.log('Initialized ' + config.db.database);
 } else if (process.argv[2] === 'user') {
  const email = (process.argv[3] ?? '').trim().toLowerCase();
  const password = process.env.MAIL_PASSWORD ?? '';
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(email) || !config.domains.includes(email.split('@')[1])) throw new Error('Supply a hosted email address');
  const passwordHash = await hashPassword(password);
  if (await repository.findUserByEmail(email)) throw new Error('User already exists');
  const user = await repository.createUser(email,passwordHash);
  await repository.createMailbox(user.id,email);
  console.log('Created mailbox ' + email);
 } else throw new Error('Usage: npm run db:init | MAIL_PASSWORD=... npm run user:add -- alice@example.test');
} catch (error) {
 console.error(error instanceof Error ? error.message : 'Command failed');
 process.exitCode = 1;
} finally { await repository.close(); }
