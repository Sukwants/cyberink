import { SMTPServer } from 'smtp-server';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const output = path.resolve('.data/relay');
await mkdir(output,{recursive:true});
const server = new SMTPServer({
 authOptional: true, disabledCommands:['AUTH','STARTTLS'], size: 10 * 1024 * 1024,
 onData(stream,_session,callback) {
  const chunks: Buffer[] = [];
  stream.on('data',(chunk:Buffer)=>{if(!stream.sizeExceeded) chunks.push(chunk);});
  stream.on('error',callback);
  stream.on('end',()=>{
   if(stream.sizeExceeded) { callback(Object.assign(new Error('Too large'),{responseCode:552})); return; }
   const id = randomUUID();
   void writeFile(path.join(output,id+'.eml'),Buffer.concat(chunks),{flag:'wx',mode:0o600})
    .then(()=>{console.log('Captured local outgoing mail: '+id);callback();},()=>callback(new Error('Capture failed')));
  });
 }
});
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
server.listen(2526,'127.0.0.1',()=>console.log('Local capture relay: 127.0.0.1:2526'));
process.once('SIGTERM',()=>server.close());
process.once('SIGINT',()=>server.close());
