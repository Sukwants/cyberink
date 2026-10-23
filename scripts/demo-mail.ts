import nodemailer from 'nodemailer';
const transport=nodemailer.createTransport({host:'127.0.0.1',port:2525,secure:false,ignoreTLS:true});
const result=await transport.sendMail({
 from:'welcome@example.test',to:'alice@example.test',subject:'欢迎使用 Cyberink · WSL 收信验证',
 text:'这封邮件通过 WSL 中的本地 SMTP 2525 端口实际发送。\n\n原始邮件已保存为 .eml，正文和附件记录存放在独立的 MariaDB 开发库中。你可以下载附件、标记未读或删除邮件。\n\n写信功能默认使用本地捕获 Relay，所有出站邮件只保存在本机。',
 attachments:[{filename:'welcome.txt',content:'Cyberink local mail server\nReal WSL SMTP + MariaDB + EML storage verified.\n',contentType:'text/plain'}]
});
console.log(result.response);
