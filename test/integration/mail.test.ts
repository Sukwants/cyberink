import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import mariadb from 'mariadb';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { loadConfig, buildConfig } from '../../src/config.js';
import { hashPassword } from '../../src/auth.js';
import { Repository } from '../../src/repository.js';
import { MailStore } from '../../src/mail-store.js';
import { createSmtpServer } from '../../src/smtp.js';
import { OutboundService } from '../../src/outbound.js';
import { buildWeb } from '../../src/web.js';
import type { AppConfig, InboundDelivery, MessageDetail, OutboundStatus, Mailbox, OutboundRecord, OutboundSummary } from '../../src/contracts.js';

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
 let sentForDeletion:OutboundRecord;

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
  web=await buildWeb({config,repository,outbound:new OutboundService(repository,config.relay,undefined,{storageDir:config.storageDir,maxMessageBytes:config.maxMessageBytes,maxAttachments:config.maxAttachments,maxAttachmentBytes:config.maxAttachmentBytes})});
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
  await t.test('real local reverse proxy accepts forwarded HTTPS origin and persists protected mutations',async()=>{
   const proxied=await buildWeb({
    config:{...config,trustedProxies:['127.0.0.1'],secureCookies:true},
    repository,outbound:new OutboundService(repository,config.relay,undefined,{storageDir:config.storageDir,maxMessageBytes:config.maxMessageBytes,maxAttachments:config.maxAttachments,maxAttachmentBytes:config.maxAttachmentBytes})
   });
   const upstream=new URL(await proxied.listen({host:'127.0.0.1',port:0}));
   const externalHost='mail.example.test:8443';
   // This local HTTP proxy models the headers Nginx overwrites after TLS termination.
   const proxy=createServer((req,res)=>{
    const forwarded=httpRequest({
     hostname:'127.0.0.1',port:upstream.port,path:req.url,method:req.method,
     headers:{...req.headers,host:upstream.host,
      'x-forwarded-host':externalHost,'x-forwarded-proto':'https',
      'x-forwarded-for':req.socket.remoteAddress}
    },incoming=>{res.writeHead(incoming.statusCode!,incoming.headers);incoming.pipe(res);});
    forwarded.on('error',()=>{res.writeHead(502);res.end();});
    req.pipe(forwarded);
   });
   try {
    await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
    const proxyBase='http://127.0.0.1:'+(proxy.address() as AddressInfo).port;
    const origin='https://'+externalHost;
    const response=await fetch(proxyBase+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email,password})});
    assert.equal(response.status,200);
    const login=await response.json() as {csrfToken:string};
    assert.match(response.headers.get('set-cookie')!,/; Secure(?:;|$)/);
    const cookie=response.headers.get('set-cookie')!.split(';')[0];
    const headers={origin,cookie,'content-type':'application/json'};
    const noCsrf=await fetch(proxyBase+'/api/messages/'+received.id,{method:'PATCH',headers,body:JSON.stringify({isRead:false})});
    assert.equal(noCsrf.status,403);
    const update=await fetch(proxyBase+'/api/messages/'+received.id,{method:'PATCH',headers:{...headers,'x-csrf-token':login.csrfToken},body:JSON.stringify({isRead:false})});
    assert.equal(update.status,200);
    const rows=await inspect.query('SELECT is_read FROM messages WHERE id=?',[received.id]);
    assert.equal(Boolean(rows[0].is_read),false);
    const rejected=await fetch(proxyBase+'/api/logout',{method:'POST',headers:{...headers,origin:'https://attacker.test','x-csrf-token':login.csrfToken}});
    assert.equal(rejected.status,403);
   } finally {
    if(proxy.listening) await new Promise<void>(resolve=>proxy.close(()=>resolve()));
    await proxied.close();
   }
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
  await t.test('multipart attachments arrive intact at local relay and appear in owner-only sent list and details',async()=>{
   const bytes=Buffer.from([0,1,2,127,128,254,255,10,13,42]);
   const form=new FormData();
   // File parts may precede fields.
   form.append('attachments',new Blob([bytes],{type:'application/octet-stream'}),'报告.bin');
   form.append('attachments',new Blob([],{type:'text/plain'}),'empty.txt');
   form.append('from',email);form.append('to',JSON.stringify(['recipient@external.test']));
   form.append('subject','With attachments 中文');form.append('text','Multipart body 正文');
   const auth=session.get('alice')!;
   const before=captured.length;
   const response=await fetch(httpBase+'/api/send',{method:'POST',headers:{cookie:auth.cookie,'x-csrf-token':auth.csrfToken},body:form});
   assert.equal(response.status,201);
   const record=await response.json() as OutboundRecord;
   assert.equal(record.status,'sent');
   sentForDeletion=record;
   assert.equal(record.attachments.length,2);
   assert.ok(record.createdAt);
   assert.equal(captured.length,before+1);
   const mime=await simpleParser(captured.at(-1)!);
   assert.equal(mime.subject,'With attachments 中文');
   assert.match(mime.text!,/Multipart body 正文/);
   assert.deepEqual(mime.attachments.find(a=>a.filename==='报告.bin')!.content,bytes);
   assert.equal(mime.attachments.find(a=>a.filename==='empty.txt')!.content.length,0);
   const sent=await (await request('/api/sent')).json() as {messages:OutboundSummary[]};
   assert.ok(sent.messages.some(m=>m.id===record.id));
   assert.ok(sent.messages.every(m=>m.status==='sent' && m.userId===aliceId));
   assert.equal((await request('/api/sent','GET',undefined,'none')).status,401);
   const other=await (await request('/api/sent','GET',undefined,'bob')).json() as {messages:OutboundSummary[]};
   assert.equal(other.messages.some(m=>m.id===record.id),false);
   const detail=await (await request('/api/outbound/'+record.id)).json() as {message:OutboundRecord};
   assert.equal(detail.message.text,'Multipart body 正文');
   assert.equal((await request('/api/outbound/'+record.id,'GET',undefined,'bob')).status,404);
   for(const attachment of detail.message.attachments) {
    assert.equal('path' in attachment,false);assert.equal('content' in attachment,false);
    const download=await request('/api/outbound/attachments/'+attachment.id);
    assert.equal(download.status,200);
    assert.match(download.headers.get('content-disposition')!,/^attachment;/);
    const actual=Buffer.from(await download.arrayBuffer());
    assert.deepEqual(actual,attachment.filename==='报告.bin'?bytes:Buffer.alloc(0));
    assert.equal((await request('/api/outbound/attachments/'+attachment.id,'GET',undefined,'bob')).status,404);
    assert.equal((await request('/api/outbound/attachments/'+attachment.id,'GET',undefined,'none')).status,401);
    const rows=await inspect.query('SELECT storage_path FROM outbound_attachments WHERE id=?',[attachment.id]);
    assert.deepEqual(await readFile(rows[0].storage_path),actual);
    assert.equal((await stat(rows[0].storage_path)).mode & 0o777,0o600);
   }
   // Reinitialization adds missing tables without replacing existing messages.
   const fresh=new Repository(config.db);
   try {
    await fresh.initialize();
    assert.equal((await fresh.getOutbound(aliceId,record.id))!.attachments.length,2);
    assert.ok((await fresh.listSent(aliceId)).some(m=>m.id===record.id));
   } finally {await fresh.close();}
   await web!.close();web=undefined;
   web=await buildWeb({config,repository,outbound:new OutboundService(repository,config.relay,undefined,{storageDir:config.storageDir,maxMessageBytes:config.maxMessageBytes,maxAttachments:config.maxAttachments,maxAttachmentBytes:config.maxAttachmentBytes})});
   httpBase=await web.listen({host:'127.0.0.1',port:0});
   session.clear();await login('alice',email);await login('bob',bobEmail);
   assert.equal((await request('/api/outbound/'+record.id)).status,200);
   assert.equal((await request('/api/outbound/attachments/'+record.attachments[0].id)).status,200);
  });
  await t.test('sent deletion is owner-only and survives restart without changing relay status or files',async()=>{
   const record=sentForDeletion;
   const url='/api/sent/'+record.id;
   const auth=session.get('alice')!;
   const calls=relayConnections;
   const deliveries=captured.length;
   const attachmentRows=await inspect.query('SELECT id,storage_path FROM outbound_attachments WHERE outbound_id=?',[record.id]);
   const storedFiles=await Promise.all(attachmentRows.map(async(row:{id:string;storage_path:string})=>({
    id:row.id,path:row.storage_path,bytes:await readFile(row.storage_path)
   })));
   assert.equal(storedFiles.length,2);
   assert.equal((await request(url,'DELETE',undefined,'none')).status,401);
   assert.equal((await fetch(httpBase+url,{method:'DELETE',headers:{cookie:auth.cookie}})).status,403);
   assert.equal((await request(url,'DELETE',undefined,'alice',{origin:'https://attacker.test'})).status,403);
   assert.equal((await request(url,'DELETE',undefined,'alice',{'sec-fetch-site':'cross-site'})).status,403);
   assert.equal((await request('/api/sent/%3Cinvalid%3E','DELETE')).status,400);
   assert.equal((await request('/api/sent/missing-'+run,'DELETE')).status,404);
   assert.equal((await request(url,'DELETE',undefined,'bob')).status,404);
   assert.equal((await request('/api/outbound/'+record.id)).status,200);
   const unchanged=await inspect.query('SELECT status,is_deleted FROM outbound_messages WHERE id=?',[record.id]);
   assert.equal(unchanged[0].status,'sent');assert.equal(Boolean(unchanged[0].is_deleted),false);
   const result=await request(url,'DELETE');
   assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true});
   assert.equal((await request(url,'DELETE')).status,404);
   const persisted=await inspect.query('SELECT status,is_deleted FROM outbound_messages WHERE id=?',[record.id]);
   assert.equal(persisted.length,1);
   assert.equal(persisted[0].status,'sent');assert.equal(Boolean(persisted[0].is_deleted),true);
   assert.equal((await request('/api/outbound/'+record.id)).status,404);
   const sent=await (await request('/api/sent')).json() as {messages:OutboundSummary[]};
   assert.equal(sent.messages.some(message=>message.id===record.id),false);
   for(const file of storedFiles) {
    assert.equal((await request('/api/outbound/attachments/'+file.id)).status,404);
    assert.deepEqual(await readFile(file.path),file.bytes);
   }
   const metadata=await inspect.query('SELECT id FROM outbound_attachments WHERE outbound_id=?',[record.id]);
   assert.equal(metadata.length,storedFiles.length);
   const fresh=new Repository(config.db);
   try {
    await fresh.initialize();
    assert.equal(await fresh.getOutbound(aliceId,record.id),undefined);
    assert.equal((await fresh.listSent(aliceId)).some(message=>message.id===record.id),false);
    for(const file of storedFiles) assert.equal(await fresh.getOutboundAttachment(aliceId,file.id),undefined);
   } finally {await fresh.close();}
   await web!.close();web=undefined;
   web=await buildWeb({config,repository,outbound:new OutboundService(repository,config.relay,undefined,{storageDir:config.storageDir,maxMessageBytes:config.maxMessageBytes,maxAttachments:config.maxAttachments,maxAttachmentBytes:config.maxAttachmentBytes})});
   httpBase=await web.listen({host:'127.0.0.1',port:0});
   session.clear();await login('alice',email);await login('bob',bobEmail);
   assert.equal((await request('/api/outbound/'+record.id)).status,404);
   assert.equal((await request(url,'DELETE')).status,404);
   const afterRestart=await (await request('/api/sent')).json() as {messages:OutboundSummary[]};
   assert.equal(afterRestart.messages.some(message=>message.id===record.id),false);
   for(const file of storedFiles) {
    assert.equal((await request('/api/outbound/attachments/'+file.id)).status,404);
    assert.deepEqual(await readFile(file.path),file.bytes);
   }
   assert.equal(relayConnections,calls);assert.equal(captured.length,deliveries);
  });
  await t.test('multipart authorization, CSRF, file count and encoded MIME limits prevent delivery',async()=>{
   const auth=session.get('alice')!;
   const before=await inspect.query('SELECT COUNT(*) AS n FROM outbound_messages WHERE user_id=?',[aliceId]);
   const connections=relayConnections;
   function form(fileCount=1,bytes=Buffer.from('small'),from=email) {
    const body=new FormData();
    body.append('from',from);body.append('to',JSON.stringify(['recipient@external.test']));
    body.append('subject','Rejected upload');body.append('text','Not delivered');
    for(let i=0;i<fileCount;i++) body.append('attachments',new Blob([bytes]),'file-'+i+'.bin');
    return body;
   }
   const headers={cookie:auth.cookie,'x-csrf-token':auth.csrfToken};
   assert.equal((await fetch(httpBase+'/api/send',{method:'POST',headers:{cookie:auth.cookie},body:form()})).status,403);
   assert.equal((await fetch(httpBase+'/api/send',{method:'POST',headers:{...headers,origin:'https://attacker.test'},body:form()})).status,403);
   assert.equal((await fetch(httpBase+'/api/send',{method:'POST',headers,body:form(1,Buffer.from('small'),bobEmail)})).status,403);
   assert.equal((await fetch(httpBase+'/api/send',{method:'POST',headers,body:form(11)})).status,413);
   assert.equal((await fetch(httpBase+'/api/send',{method:'POST',headers,body:form(1,Buffer.alloc(config.maxMessageBytes+1))})).status,413);
   // Raw upload fits, base64 MIME encoding does not.
   assert.equal((await fetch(httpBase+'/api/send',{method:'POST',headers,body:form(1,Buffer.alloc(Math.floor(config.maxMessageBytes*0.8)))})).status,413);
   const wrongField=new FormData();wrongField.append('path','/etc/passwd');
   assert.equal((await fetch(httpBase+'/api/send',{method:'POST',headers,body:wrongField})).status,400);
   assert.equal((await request('/api/send','POST',{from:email,to:['recipient@external.test'],subject:'No paths',text:'No paths',attachments:[{path:'/etc/passwd'}]})).status,400);
   const after=await inspect.query('SELECT COUNT(*) AS n FROM outbound_messages WHERE user_id=?',[aliceId]);
   assert.equal(String(after[0].n),String(before[0].n));
   assert.equal(relayConnections,connections);
  });
  await t.test('failed attachment sends retain private records but never enter successful sent list',async()=>{
   const form=new FormData();
   form.append('from',email);form.append('to',JSON.stringify(['recipient@external.test']));
   form.append('subject','Rejected attachment');form.append('text','Relay failure');
   form.append('attachments',new Blob(['retain private bytes']),'retained.txt');
   relayMode='permanent';
   let record:OutboundRecord;
   try {
    const auth=session.get('alice')!;
    const response=await fetch(httpBase+'/api/send',{method:'POST',headers:{cookie:auth.cookie,'x-csrf-token':auth.csrfToken},body:form});
    assert.equal(response.status,201);
    record=await response.json() as OutboundRecord;
    assert.equal(record.status,'permanent_failed');
   } finally {relayMode='ok';}
   assert.equal((await repository.getOutbound(aliceId,record.id))!.status,'permanent_failed');
   const sent=await (await request('/api/sent')).json() as {messages:OutboundSummary[]};
   assert.equal(sent.messages.some(m=>m.id===record.id),false);
   const download=await request('/api/outbound/attachments/'+record.attachments[0].id);
   assert.equal(await download.text(),'retain private bytes');
  });
  await t.test('configured count and per-file limits govern HTTP uploads, transport and exposed UI limits',async()=>{
   for(const maxAttachments of [2,0]) {
    const custom=buildConfig({...process.env,MAX_ATTACHMENTS:String(maxAttachments),MAX_ATTACHMENT_BYTES:'8',
     STORAGE_DIR:config.storageDir,RELAY_PORT:String(config.relay.port)});
    const app=await buildWeb({config:custom,repository,outbound:new OutboundService(repository,custom.relay,undefined,{
     storageDir:custom.storageDir,maxMessageBytes:custom.maxMessageBytes,maxAttachments:custom.maxAttachments,maxAttachmentBytes:custom.maxAttachmentBytes})});
    try {
     const base=await app.listen({host:'127.0.0.1',port:0});
     const loginResponse=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
     assert.equal(loginResponse.status,200);
     const data=await loginResponse.json() as {csrfToken:string;limits:{maxAttachments:number;maxAttachmentBytes:number;maxMessageBytes:number}};
     assert.deepEqual(data.limits,{maxAttachments,maxAttachmentBytes:8,maxMessageBytes:config.maxMessageBytes});
     const headers={cookie:loginResponse.headers.get('set-cookie')!.split(';')[0],'x-csrf-token':data.csrfToken};
     const me=await (await fetch(base+'/api/me',{headers})).json() as {limits:unknown};
     assert.deepEqual(me.limits,data.limits);
     const form=(count:number,bytes:number)=>{
      const body=new FormData();
      body.append('from',email);body.append('to',JSON.stringify(['recipient@external.test']));
      body.append('subject','Configured attachments');body.append('text','Limits');
      for(let i=0;i<count;i++) body.append('attachments',new Blob([Buffer.alloc(bytes,42)]),'file-'+i+'.bin');
      return body;
     };
     const before=captured.length;
     if(maxAttachments>0) {
      const result=await fetch(base+'/api/send',{method:'POST',headers,body:form(2,8)});
      assert.equal(result.status,201);
      const sent=await result.json() as OutboundRecord;
      assert.equal(sent.status,'sent');assert.deepEqual(sent.attachments.map(a=>a.size),[8,8]);
      assert.equal(captured.length,before+1);
      const mime=await simpleParser(captured.at(-1)!);
      assert.equal(mime.attachments.length,2);
      assert.ok(mime.attachments.every(a=>a.content.equals(Buffer.alloc(8,42))));
     } else {
      const result=await fetch(base+'/api/send',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({from:email,to:['recipient@external.test'],subject:'Text only',text:'Attachments disabled'})});
      assert.equal(result.status,201);assert.equal((await result.json() as OutboundRecord).status,'sent');
     }
     const records=await inspect.query('SELECT COUNT(*) AS n FROM outbound_messages WHERE user_id=?',[aliceId]);
     const calls=relayConnections;
     assert.equal((await fetch(base+'/api/send',{method:'POST',headers,body:form(maxAttachments+1,1)})).status,413);
     assert.equal((await fetch(base+'/api/send',{method:'POST',headers,body:form(1,9)})).status,413);
     const after=await inspect.query('SELECT COUNT(*) AS n FROM outbound_messages WHERE user_id=?',[aliceId]);
     assert.equal(String(after[0].n),String(records[0].n));assert.equal(relayConnections,calls);
    } finally {await app.close();}
   }
  });
  await t.test('legacy outbound rows remain readable without attachment metadata',async()=>{
   const id=randomUUID();
   await inspect.query('INSERT INTO outbound_messages (id,user_id,from_address,to_addresses,subject,text_body,status,error_message) VALUES (?,?,?,?,?,?,?,?)',
    [id,aliceId,email,JSON.stringify(['recipient@external.test']),'Legacy sent mail','Preserved text','sent',null]);
   await repository.initialize();
   await repository.initialize();
   const rows=await inspect.query('SELECT is_deleted FROM outbound_messages WHERE id=?',[id]);
   assert.equal(Boolean(rows[0].is_deleted),false);
   const old=await repository.getOutbound(aliceId,id);
   assert.equal(old!.text,'Preserved text');assert.deepEqual(old!.attachments,[]);
   assert.ok((await repository.listSent(aliceId)).some(m=>m.id===id));
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
  await t.test('sent deletion rejects pending, failed and uncertain delivery records without changing them',async()=>{
   const pending:OutboundRecord={id:randomUUID(),userId:aliceId,from:email,to:['recipient@external.test'],
    subject:'Pending record',text:'Never submitted',status:'pending',error:null,createdAt:new Date().toISOString(),attachments:[]};
   await repository.createOutbound(pending);
   const records=await inspect.query('SELECT id,status,is_deleted FROM outbound_messages WHERE user_id=? AND status<>?', [aliceId,'sent']);
   assert.deepEqual(new Set(records.map((record:{status:OutboundStatus})=>record.status)),new Set(['pending','temp_failed','permanent_failed','unknown']));
   const calls=relayConnections;
   for(const record of records) {
    assert.equal(Boolean(record.is_deleted),false);
    assert.equal((await request('/api/sent/'+record.id,'DELETE')).status,404);
    assert.equal((await repository.getOutbound(aliceId,record.id))!.status,record.status);
    const rows=await inspect.query('SELECT status,is_deleted FROM outbound_messages WHERE id=?',[record.id]);
    assert.equal(rows[0].status,record.status);assert.equal(Boolean(rows[0].is_deleted),false);
   }
   assert.equal(relayConnections,calls);
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
   web=await buildWeb({config,repository,outbound:new OutboundService(repository,config.relay,undefined,{storageDir:config.storageDir,maxMessageBytes:config.maxMessageBytes,maxAttachments:config.maxAttachments,maxAttachmentBytes:config.maxAttachmentBytes})});
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
