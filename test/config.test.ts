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

test('attachment limits default safely and can be configured independently',()=>{
 const defaults=buildConfig(testEnv);
 assert.equal(defaults.maxAttachments,10);
 assert.equal(defaults.maxAttachmentBytes,defaults.maxMessageBytes);
 const custom=buildConfig({...testEnv,MAX_MESSAGE_BYTES:'65536',MAX_ATTACHMENTS:'20',MAX_ATTACHMENT_BYTES:'4096'});
 assert.equal(custom.maxMessageBytes,65536);
 assert.equal(custom.maxAttachments,20);
 assert.equal(custom.maxAttachmentBytes,4096);
 assert.equal(buildConfig({...testEnv,MAX_ATTACHMENTS:'0'}).maxAttachments,0);
 assert.equal(buildConfig({...testEnv,MAX_MESSAGE_BYTES:'65536'}).maxAttachmentBytes,65536);
 for(const value of ['-1','1.5','1001','NaN','Infinity','']) {
  assert.throws(()=>buildConfig({...testEnv,MAX_ATTACHMENTS:value}),/MAX_ATTACHMENTS/);
 }
 for(const value of ['0','-1','1.5','65537','NaN','Infinity','']) {
  assert.throws(()=>buildConfig({...testEnv,MAX_MESSAGE_BYTES:'65536',MAX_ATTACHMENT_BYTES:value}),/MAX_ATTACHMENT_BYTES/);
 }
});
