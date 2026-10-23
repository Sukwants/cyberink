import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/auth.js';
import { Repository } from '../src/repository.js';
const config=loadConfig();
if(config.env !== 'development' || config.db.database !== 'mail_platform_dev') throw new Error('Demo seeding requires isolated development database');
const repository=new Repository(config.db);
try {
 await repository.initialize();
 const email='alice@example.test';
 if(await repository.findUserByEmail(email)) throw new Error('Demo account already exists; refusing to reset credentials');
 const password=randomBytes(18).toString('base64url');
 const user=await repository.createUser(email,await hashPassword(password));
 await repository.createMailbox(user.id,email);
 await writeFile('.local-dev-credentials.txt','Local WSL development only\nURL: http://localhost:3000\nEmail: '+email+'\nPassword: '+password+'\n',{flag:'wx',mode:0o600});
 console.log('Created development mailbox. Credentials: .local-dev-credentials.txt');
} finally {await repository.close();}
