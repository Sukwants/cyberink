import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config.js';
import { hashPassword, verifyPassword } from '../src/auth.js';
const testEnv = { NODE_ENV:'test', DB_USER:'mail_platform_test', DB_DATABASE:'mail_platform_test', DB_PASSWORD:'test-only', STORAGE_DIR:'.test-data/config', MAIL_DOMAINS:'example.test' };
test('test config refuses production DB, remote services, storage escape and relay credentials',()=>{
 assert.equal(buildConfig(testEnv).env,'test');
 for(const patch of [
  {DB_DATABASE:'mail_platform_dev'}, {DB_USER:'root'}, {DB_HOST:'db.example.com'},
  {RELAY_HOST:'smtp.example.com'}, {STORAGE_DIR:'.data/mail'}, {STORAGE_DIR:'.test-data'},
  {STORAGE_DIR:'.test-data/../../escape'}, {RELAY_USER:'real-credentials'}, {MAIL_DOMAINS:'example.com'},
  {SMTP_PORT:'25.5'}, {MAX_MESSAGE_BYTES:'-1'}
 ]) assert.throws(()=>buildConfig({...testEnv,...patch}));
});
test('salted password hashes verify without storing plaintext',async()=>{
 const hash = await hashPassword('correct-test-password');
 assert.equal(await verifyPassword('correct-test-password',hash),true);
 assert.equal(await verifyPassword('wrong-password',hash),false);
 assert.equal(await verifyPassword('correct-test-password','invalid'),false);
 assert.notEqual(hash,await hashPassword('correct-test-password'));
 await assert.rejects(hashPassword('short'));
});

test('proxy trust is opt-in and accepts only explicit proxy IP addresses',()=>{
 assert.deepEqual(buildConfig(testEnv).trustedProxies,[]);
 assert.deepEqual(buildConfig({...testEnv,TRUST_PROXY:'127.0.0.1, ::1'}).trustedProxies,['127.0.0.1','::1']);
 for(const address of ['true','*','proxy.example.test','0.0.0.0/0']) {
  assert.throws(()=>buildConfig({...testEnv,TRUST_PROXY:address}),/TRUST_PROXY/);
 }
});
