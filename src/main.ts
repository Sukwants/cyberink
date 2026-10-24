import { loadConfig } from './config.js';
import { Repository } from './repository.js';
import { MailStore } from './mail-store.js';
import { createSmtpServer } from './smtp.js';
import { OutboundService } from './outbound.js';
import { buildWeb } from './web.js';
const config = loadConfig();
const repository = new Repository(config.db);
const smtp = createSmtpServer({repository,store: new MailStore(config.storageDir,repository),domains:config.domains,maxMessageBytes:config.maxMessageBytes});
const web = await buildWeb({config,repository,outbound:new OutboundService(repository,config.relay,undefined,{storageDir:config.storageDir,maxMessageBytes:config.maxMessageBytes,maxAttachments:config.maxAttachments,maxAttachmentBytes:config.maxAttachmentBytes})});
let stopping = false;
async function stop() {
 if (stopping) return;
 stopping = true;
 await new Promise<void>(resolve => smtp.close(() => resolve()));
 await web.close();
 await repository.close();
}
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
smtp.on('error', error => { console.error('SMTP error:', error.message); void stop().then(() => process.exit(1)); });
try {
 await repository.initialize();
 await web.listen({host:config.host,port:config.httpPort});
 await new Promise<void>((resolve,reject) => {
  smtp.once('error',reject);
  smtp.listen(config.smtpPort,config.host, () => { smtp.removeListener('error',reject); resolve(); });
 });
 console.log('Cyberink [' + config.env + '] HTTP ' + config.host + ':' + config.httpPort + ', SMTP ' + config.smtpPort);
} catch (error) {
 console.error(error instanceof Error ? error.message : 'Startup failed');
 await stop();
 process.exitCode = 1;
}
