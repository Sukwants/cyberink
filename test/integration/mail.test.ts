import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import mariadb from 'mariadb';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { loadConfig } from '../../src/config.js';
import { hashPassword } from '../../src/auth.js';
import { Repository } from '../../src/repository.js';
import { MailStore } from '../../src/mail-store.js';
import { createSmtpServer } from '../../src/smtp.js';
import { OutboundService } from '../../src/outbound.js';
import { buildWeb } from '../../src/web.js';
import type { AppConfig, InboundDelivery, MessageDetail, OutboundStatus, Mailbox } from '../../src/contracts.js';

async function listenSmtp(server: SMTPServer, port = 0) {
 await new Promise<void>((resolve,reject)=>{ server.once('error',reject); server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();}); });
 return (server.server.address() as AddressInfo).port;
}
async function closeSmtp(server: SMTPServer) {
 await new Promise<void>(resolve=>server.close(()=>resolve()));
}
function localClient(port:number) {
 return nodemailer.createTransport({host:'127.0.0.1',port,secure:false,ignoreTLS:true,connectionTimeout:3000,socketTimeout:3000,disableFileAccess:true,disableUrlAccess:true});
}
const fixture = (to:string[]) => ({
 from:'sender@example.test', to, subject:'WSL SMTP Test 中文',
 text:'Hello from WSL. 正文已保存。',
 html:'<p>Hello from WSL. 正文已保存。</p>',
 attachments:[{filename:'hello.txt',content:'attachment bytes 123',contentType:'text/plain'}]
});
test('WSL real MariaDB + SMTP + HTTP end-to-end', {timeout:90_000}, async t=>{
 // A real config is mandatory. No skip, memory fallback, or production credentials.
 process.env.MAIL_ENV_FILE = '.env.test';
 const loaded = loadConfig();
 assert.equal(loaded.env,'test','integration requires NODE_ENV=test');
 const run = randomUUID().slice(0,8);
 const config: AppConfig = {...loaded, storageDir:path.join(loaded.storageDir,run)};
 const repository = new Repository(config.db);
 const inspect = mariadb.createPool({...config.db,bigIntAsNumber:true});
 const createdUsers:number[]=[];
 const email = 'alice-'+run+'@example.test';
 const bobEmail = 'bob-'+run+'@example.test';
 const password='WSL-integration-password-123';
 const session = new Map<string,{cookie:string;csrfToken:string}>();
 let smtp:SMTPServer|undefined;
 let web:Awaited<ReturnType<typeof buildWeb>>|undefined;
 let relay:SMTPServer|undefined;
 let httpBase='';
 let smtpPort=0;
 let relayMode:'ok'|'temporary'|'permanent'|'disconnect'='ok';
 const captured:Buffer[]=[];
 let relayConnections=0;
 let aliceId=0;
 let aliceMailbox:Mailbox;
 let received:MessageDetail;

 async function request(url:string,method='GET',body?:unknown,who='alice',extra:Record<string,string>={}) {
  const auth=session.get(who);
  return fetch(httpBase+url,{method,headers:{
   ...(body === undefined ? {} : {'content-type':'application/json'}),
   ...(auth ? {cookie:auth.cookie,'x-csrf-token':auth.csrfToken}:{}),...extra
  },body:body===undefined?undefined:JSON.stringify(body)});
 }
 async function login(who:string,address:string) {
  const response=await request('/api/login','POST',{email:address,password},'none');
  assert.equal(response.status,200);
  const body=await response.json() as {csrfToken:string;user:{email:string}};
  assert.equal(body.user.email,address);
  const cookie=response.headers.get('set-cookie')!;
  assert.match(cookie,/HttpOnly/i);
  assert.match(cookie,/SameSite=Strict/i);
  session.set(who,{cookie:cookie.split(';')[0],csrfToken:body.csrfToken});
 }
 async function startServices() {
  smtp=createSmtpServer({repository,store:new MailStore(config.storageDir,repository),domains:config.domains,maxMessageBytes:config.maxMessageBytes});
  smtpPort=await listenSmtp(smtp,config.smtpPort);
  web=await buildWeb({config,repository,outbound:new OutboundService(repository,config.relay)});
  httpBase=await web.listen({host:'127.0.0.1',port:0});
 }
 try {
  await repository.initialize();
  await mkdir(config.storageDir,{recursive:true});
  const hash=await hashPassword(password);
  const alice=await repository.createUser(email,hash); aliceId=alice.id;createdUsers.push(aliceId);
  const bob=await repository.createUser(bobEmail,hash);createdUsers.push(bob.id);
  aliceMailbox=await repository.createMailbox(aliceId,email);
  await repository.createMailbox(bob.id,bobEmail);
  relay=new SMTPServer({
   disabledCommands:['AUTH','STARTTLS'],authOptional:true,
   onConnect(_s,cb){relayConnections++;cb();},
   onRcptTo(_a,_s,cb) {
    if(relayMode==='temporary') cb(Object.assign(new Error('Try later'),{responseCode:451}));
    else if(relayMode==='permanent') cb(Object.assign(new Error('Rejected'),{responseCode:550}));
    else cb();
   },
   onData(stream,_s,cb) {
    const chunks:Buffer[]=[];
    stream.on('data',(chunk:Buffer)=>chunks.push(chunk));
    stream.on('end',()=>{
     captured.push(Buffer.concat(chunks));
     if(relayMode==='disconnect') { stream.emit('error',new Error('Connection lost')); return; }
     cb();
    });
   }
  });
  const relayPort=await listenSmtp(relay);
  config.relay={...config.relay,port:relayPort};
  await startServices();

  await t.test('SMTP accepts local mailbox, writes original EML, DB text and attachment bytes',async()=>{
   const result=await localClient(smtpPort).sendMail(fixture([email]));
   assert.match(result.response,/^250/);
   const messages=await repository.listMessages(aliceId);
   assert.equal(messages.length,1);
   received=(await repository.getMessage(aliceId,messages[0].id))!;
   assert.equal(received.subject,'WSL SMTP Test 中文');
   assert.match(received.textBody,/Hello from WSL/);
   assert.equal(received.attachments.length,1);
   const rows=await inspect.query('SELECT raw_path,text_body FROM messages WHERE id=?',[received.id]);
   assert.match(rows[0].raw_path,/\.eml$/);
   const raw=await readFile(rows[0].raw_path);
   assert.match(raw.toString(),/MIME-Version:/);
   const attachment=await repository.getAttachment(aliceId,received.attachments[0].id);
   assert.equal((await readFile(attachment!.path)).toString(),'attachment bytes 123');
   assert.equal((await stat(rows[0].raw_path)).mode & 0o777,0o600);
  });
  await t.test('unknown recipients and external relay targets return SMTP550',async()=>{
   for(const address of ['missing-'+run+'@example.test','outside@unhosted.test']) {
    await assert.rejects(localClient(smtpPort).sendMail(fixture([address])),(error:unknown)=>
     typeof error==='object' && error!==null && 'responseCode' in error && error.responseCode===550);
   }
   assert.equal((await repository.listMessages(aliceId)).length,1);
  });
  await t.test('oversized DATA rejected without saved messages',async()=>{
   await assert.rejects(localClient(smtpPort).sendMail({...fixture([email]),text:'X'.repeat(config.maxMessageBytes*2)}),(error:unknown)=>
    typeof error==='object' && error!==null && 'responseCode' in error && error.responseCode===552);
   assert.equal((await repository.listMessages(aliceId)).length,1);
  });
  await t.test('raw file failure returns SMTP451 and does not add a database record',async()=>{
   const blocked=path.join(config.storageDir,'blocked-file');
   await writeFile(blocked,'not a directory');
   const failed=createSmtpServer({repository,store:new MailStore(blocked,repository),domains:config.domains,maxMessageBytes:config.maxMessageBytes});
   try {
    const port=await listenSmtp(failed);
    await assert.rejects(localClient(port).sendMail(fixture([email])),(e:unknown)=>typeof e==='object'&&e!==null&&'responseCode' in e&&e.responseCode===451);
    assert.equal((await repository.listMessages(aliceId)).length,1);
   } finally {await closeSmtp(failed);}
  });
  await t.test('real DB constraint failure rolls back all recipients and removes newly created EML',async()=>{
   const failureDir=path.join(config.storageDir,'db-failure');
   const realStore=new MailStore(failureDir,repository);
   const invalid:InboundDelivery={deliver:(raw,from,recipients)=>realStore.deliver(raw,from,[...recipients,{...aliceMailbox,id:4294967294}])};
   const failed=createSmtpServer({repository,store:invalid,domains:config.domains,maxMessageBytes:config.maxMessageBytes});
   try {
    const port=await listenSmtp(failed);
    await assert.rejects(localClient(port).sendMail(fixture([email])),(e:unknown)=>typeof e==='object'&&e!==null&&'responseCode' in e&&e.responseCode===451);
    assert.equal((await repository.listMessages(aliceId)).length,1);
    assert.deepEqual(await readdir(failureDir),[]);
   } finally {await closeSmtp(failed);}
  });
  await t.test('HTTP login success/failure, static UI, unauthorized and malformed requests',async()=>{
   assert.equal((await fetch(httpBase+'/')).status,200);
   assert.match(await (await fetch(httpBase+'/')).text(),/<title>Cyberink<\/title>/);
   assert.equal((await request('/api/inbox','GET',undefined,'none')).status,401);
   assert.equal((await request('/api/login','POST',{email,password:'wrong'},'none')).status,401);
   assert.equal((await request('/api/login','POST',{email,password},'none',{origin:'http://attacker.test'})).status,403);
   await login('alice',email);await login('bob',bobEmail);
   const malformed=await fetch(httpBase+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:'{'});
   assert.equal(malformed.status,400);
   assert.equal((await request('/api/messages/%3Cinvalid%3E')).status,400);
  });
  await t.test('HTTP inbox/detail/attachment read actual DB mail; cross-user reads denied',async()=>{
   const inbox=await (await request('/api/inbox')).json() as {messages:{id:string}[]};
   assert.equal(inbox.messages[0].id,received.id);
   const detail=await (await request('/api/messages/'+received.id)).json() as {message:MessageDetail};
   assert.match(detail.message.textBody,/正文已保存/);
   assert.equal('htmlBody' in detail.message,false);
   const attachmentId=received.attachments[0].id;
   const attachment=await request('/api/attachments/'+attachmentId);
   assert.equal(attachment.status,200);
   assert.match(attachment.headers.get('content-disposition')!,/^attachment;/);
   assert.equal(await attachment.text(),'attachment bytes 123');
   assert.equal((await request('/api/messages/'+received.id,'GET',undefined,'bob')).status,404);
   assert.equal((await request('/api/attachments/'+attachmentId,'GET',undefined,'bob')).status,404);
   assert.equal((await request('/api/messages/'+received.id,'PATCH',{isRead:true},'bob')).status,404);
   assert.equal((await request('/api/messages/'+received.id,'DELETE',undefined,'bob')).status,404);
  });
  await t.test('CSRF and input validation; read/unread changes persist in MariaDB',async()=>{
   const noCsrf=await fetch(httpBase+'/api/messages/'+received.id,{method:'PATCH',headers:{cookie:session.get('alice')!.cookie,'content-type':'application/json'},body:JSON.stringify({isRead:true})});
   assert.equal(noCsrf.status,403);
   assert.equal((await request('/api/messages/'+received.id,'PATCH',{isRead:'yes'})).status,400);
   for(const isRead of [true,false,true]) {
    assert.equal((await request('/api/messages/'+received.id,'PATCH',{isRead})).status,200);
    const rows=await inspect.query('SELECT is_read FROM messages WHERE id=?',[received.id]);
    assert.equal(Boolean(rows[0].is_read),isRead);
   }
  });
  await t.test('restarting SMTP, HTTP and repository preserves original files and mail states',async()=>{
   const rows=await inspect.query('SELECT raw_path FROM messages WHERE id=?',[received.id]);
   await closeSmtp(smtp!); smtp=undefined;
   await web!.close();web=undefined;
   // New DB connection confirms committed state independently.
   const fresh=new Repository(config.db);
   try {assert.equal((await fresh.getMessage(aliceId,received.id))!.isRead,true);}
   finally {await fresh.close();}
   await startServices();
   session.clear();await login('alice',email);await login('bob',bobEmail);
   const detail=await (await request('/api/messages/'+received.id)).json() as {message:MessageDetail};
   assert.equal(detail.message.isRead,true);
   assert.match((await readFile(rows[0].raw_path)).toString(),/MIME-Version/);
   assert.match((await localClient(smtpPort).sendMail({...fixture([email]),subject:'After restart'})).response,/^250/);
  });
  await t.test('Web send requires sender ownership; successful local relay capture is persisted',async()=>{
   const input={from:email,to:['recipient@external.test'],subject:'Outbound local test',text:'Captured in WSL only'};
   assert.equal((await request('/api/send','POST',{...input,from:bobEmail})).status,403);
   const before=captured.length;
   const response=await request('/api/send','POST',input);
   assert.equal(response.status,201);
   const record=await response.json() as {id:string;status:OutboundStatus};
   assert.equal(record.status,'sent');
   assert.equal(captured.length,before+1);
   assert.match(captured.at(-1)!.toString(),/Captured in WSL only/);
   assert.equal((await repository.getOutbound(aliceId,record.id))!.status,'sent');
   assert.equal((await request('/api/outbound/'+record.id,'GET',undefined,'bob')).status,404);
  });
  await t.test('local SMTP 451/550 failures persist distinct failed statuses, never sent',async()=>{
   for(const [mode,status] of [['temporary','temp_failed'],['permanent','permanent_failed']] as const) {
    relayMode=mode;
    const response=await request('/api/send','POST',{from:email,to:['recipient@external.test'],subject:'Relay failure',text:'Never external'});
    assert.equal(response.status,201);
    const record=await response.json() as {id:string;status:OutboundStatus};
    assert.equal(record.status,status);
    assert.equal((await repository.getOutbound(aliceId,record.id))!.status,status);
   }
   relayMode='ok';
  });
  await t.test('unknown timeout delivery stays unknown and is not retried',async()=>{
   let attempts=0;
   const service=new OutboundService(repository,config.relay,{sendMail:async()=>{attempts++;throw Object.assign(new Error('timeout after DATA'),{code:'ETIMEDOUT'});}});
   const record=await service.send(aliceId,{from:email,to:['recipient@external.test'],subject:'Uncertain',text:'Mock transport, no network'});
   assert.equal(record.status,'unknown');
   assert.equal((await repository.getOutbound(aliceId,record.id))!.status,'unknown');
   await new Promise(resolve=>setTimeout(resolve,100));
   assert.equal(attempts,1);
   assert.ok(relayConnections>=3);
  });
  await t.test('multi-recipient delivery has independent scoped message and attachment identities',async()=>{
   const result=await localClient(smtpPort).sendMail({...fixture([email,bobEmail,email]),subject:'Shared delivery'});
   assert.match(result.response,/^250/);
   const aliceCopy=(await repository.listMessages(aliceId)).find(message=>message.subject==='Shared delivery')!;
   const bobUser=(await repository.findUserByEmail(bobEmail))!;
   const bobCopy=(await repository.listMessages(bobUser.id)).find(message=>message.subject==='Shared delivery')!;
   assert.notEqual(aliceCopy.id,bobCopy.id);
   const a=(await repository.getMessage(aliceId,aliceCopy.id))!;
   const b=(await repository.getMessage(bobUser.id,bobCopy.id))!;
   assert.notEqual(a.attachments[0].id,b.attachments[0].id);
   assert.equal((await request('/api/attachments/'+b.attachments[0].id,'GET',undefined,'bob')).status,200);
   assert.equal((await request('/api/attachments/'+a.attachments[0].id,'GET',undefined,'bob')).status,404);
   assert.equal((await request('/api/messages/'+bobCopy.id,'GET',undefined,'alice')).status,404);
   assert.equal((await repository.listMessages(aliceId)).filter(message=>message.subject==='Shared delivery').length,1);
  });
  await t.test('delete state survives restart, hides mail/attachment; logout revokes session',async()=>{
   assert.equal((await request('/api/messages/'+received.id,'DELETE')).status,200);
   const rows=await inspect.query('SELECT is_deleted FROM messages WHERE id=?',[received.id]);
   assert.equal(Boolean(rows[0].is_deleted),true);
   await web!.close();web=undefined;
   web=await buildWeb({config,repository,outbound:new OutboundService(repository,config.relay)});
   httpBase=await web.listen({host:'127.0.0.1',port:0});
   session.clear();await login('alice',email);
   assert.equal((await request('/api/messages/'+received.id)).status,404);
   assert.equal((await request('/api/attachments/'+received.attachments[0].id)).status,404);
   assert.equal((await request('/api/logout','POST')).status,200);
   assert.equal((await request('/api/inbox')).status,401);
  });
 } finally {
  if(smtp) await closeSmtp(smtp);
  if(web) await web.close();
  if(relay) await closeSmtp(relay);
  // Delete only this run's rows, never reset schemas or other tests' data.
  for(const userId of createdUsers) {
   await inspect.query('DELETE a FROM attachments a JOIN messages m ON m.id=a.message_id JOIN mailboxes b ON b.id=m.mailbox_id WHERE b.user_id=?',[userId]);
   await inspect.query('DELETE m FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE b.user_id=?',[userId]);
   await inspect.query('DELETE FROM outbound_messages WHERE user_id=?',[userId]);
   await inspect.query('DELETE FROM mailboxes WHERE user_id=?',[userId]);
   await inspect.query('DELETE FROM users WHERE id=?',[userId]);
  }
  await inspect.end();await repository.close();
 }
});
