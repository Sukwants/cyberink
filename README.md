# Cyberink

Cyberink 是一个简易的自托管邮箱服务，提供 SMTP 收信和 Web 邮箱，通过第三方 SMTP Relay 发送邮件。账号、邮件索引和状态保存在 MariaDB 中，原始邮件及附件保存在本地文件系统中。

支持收件箱、已发邮件、主题和联系人搜索、未读筛选、邮件详情、附件下载、已读状态、删除，以及带附件的纯文本写信。

## 快速开始

以下命令在项目根目录执行，Shell 示例使用 Bash。

### 1. 准备依赖

- Node.js 22 或以上。
- pnpm 10.19.0。
- 已启动且可连接的 MariaDB。

### 2. 安装并配置数据库

安装项目依赖，首次使用时复制配置文件：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
```

在 MariaDB 中创建数据库和专用账号。例如，由数据库管理员执行：

```sql
CREATE DATABASE cyberink
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'cyberink'@'127.0.0.1'
  IDENTIFIED BY 'replace-with-a-strong-password';

GRANT ALL PRIVILEGES ON cyberink.*
  TO 'cyberink'@'127.0.0.1';
```

将示例密码替换为自己的密码，并在 `.env` 中填写对应配置：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=cyberink
DB_USER=cyberink
DB_PASSWORD=replace-with-a-strong-password
```

初始化表结构：

```bash
pnpm db:init
```

`db:init` 创建应用所需的表并补充新增字段，数据库和数据库账号需要提前准备。

### 3. 创建邮箱账号

默认托管域名为 `example.test`。创建该域名下的邮箱：

```bash
read -r -s -p "邮箱密码: " MAIL_PASSWORD
printf '\n'
export MAIL_PASSWORD
pnpm user:add alice@example.test
unset MAIL_PASSWORD
```

密码长度为 12 至 256 个字符。命令会创建登录账号和同地址的邮箱；邮箱域名必须包含在 `MAIL_DOMAINS` 中。

如需使用自己的域名，先修改配置，再创建对应地址的账号：

```dotenv
MAIL_DOMAINS=example.com
```

多个托管域名以英文逗号分隔，例如 `example.com,example.org`。

### 4. 启动服务

默认配置将出站邮件交给本地邮件捕获服务。使用默认配置体验发信时，先在一个终端启动：

```bash
pnpm relay:local
```

该服务监听 `127.0.0.1:2526`，将邮件保存到 `.data/relay/*.eml`，不会投递到外部邮箱。如果已经配置第三方 Relay，可跳过这一步。

在另一个终端构建并启动 Cyberink：

```bash
pnpm build
pnpm start
```

默认服务地址：

| 服务 | 地址 |
| --- | --- |
| Web 邮箱 | [http://localhost:3000](http://localhost:3000) |
| SMTP 收信 | `127.0.0.1:2525` |

打开 Web 邮箱，使用刚创建的邮箱地址和密码登录。按 Ctrl+C 停止服务。

修改源码时可以使用 `pnpm dev`，该命令会在文件变化后自动重启应用。不要与 `pnpm start` 同时占用相同端口。

## 使用 Web 邮箱

- **查看邮件**：点击邮件打开详情，邮件会自动标记为已读。
- **查找邮件**：通过搜索框查找发件人或主题，或切换到“未读邮件”。
- **下载附件**：在邮件详情底部点击附件名称。
- **修改状态**：在详情中将邮件标记为已读或未读。
- **删除邮件**：在收件箱或已发送邮件详情中点击“删除邮件”，邮件会从相应列表中隐藏。
- **发送邮件**：点击“写邮件”，填写收件人、主题和正文，可选择附件后发送。发件人必须是当前账号拥有的邮箱。
- **查看已发邮件**：点击侧栏“已发邮件”，可按收件人或主题搜索，打开邮件查看正文、收件人、发送时间和附件，并下载已发送的附件。

删除采用软删除，正文、原始邮件和附件仍保留在服务器中；当前没有回收站或恢复入口。删除已发送邮件仅隐藏当前账号在 Cyberink 中的副本，不能撤回已投递的邮件或删除收件人的副本。

默认一次最多发送 **10 个附件**，可在发送前移除选中的文件。附件数量、单文件大小及整封邮件大小均可在 `.env` 中配置，例如：

```dotenv
MAX_ATTACHMENTS=20
MAX_ATTACHMENT_BYTES=5242880
MAX_MESSAGE_BYTES=26214400
```

以上设置允许最多 20 个附件，单文件原始大小不超过 5 MiB，整封邮件编码后不超过 25 MiB。`MAX_ATTACHMENTS` 支持 0～1000，设为 `0` 可关闭附件发送；`MAX_ATTACHMENT_BYTES` 必须为正整数且不能超过 `MAX_MESSAGE_BYTES`。未设置单文件上限时，默认与整封邮件上限相同。

`MAX_MESSAGE_BYTES` 包含正文、MIME 头和附件编码，支持最大 50 MiB，默认 10 MiB。附件编码会增大邮件体积，文件原始大小合计小于上限也可能超限。修改配置后重启服务并刷新页面，页面会自动显示新限制。

“已发邮件”仅展示 Relay 已确认接受的邮件；失败、等待中或结果不确定的发送记录不会显示为已发送。已发送只代表 Relay 已接收，不代表外部邮箱最终投递成功。

## 接收邮件

Cyberink 仅接受已创建的托管邮箱地址，拒绝不存在的邮箱和非托管域名，不提供任意地址转发。

使用 SMTP 客户端将邮件发送到配置的收信地址。已安装 `swaks` 时，可以发送第一封邮件：

```bash
swaks \
  --server 127.0.0.1 \
  --port 2525 \
  --from sender@example.test \
  --to alice@example.test \
  --header "Subject: Hello Cyberink" \
  --body "Your first message."
```

随后在 Web 邮箱中刷新收件箱查看。收件人应替换为已经创建的邮箱，端口应与 `SMTP_PORT` 一致。

默认端口 `2525` 用于直接连接此服务。若要接收公网邮件，还需要使用自己的域名，配置 MX 记录，并让邮件入口通过标准 SMTP 端口 `25` 接收和转交邮件。

## 配置 SMTP 发信

向外部邮箱发送邮件时，在 `.env` 中配置第三方 SMTP Relay。例如，使用提供隐式 TLS 的 SMTP 服务：

```dotenv
RELAY_HOST=smtp.example.com
RELAY_PORT=465
RELAY_SECURE=true
RELAY_USER=your-relay-account
RELAY_PASSWORD=your-relay-password
```

将这些值替换为服务商提供的连接信息，并确认发件人地址已经获得该服务商的发送授权。保存配置后重启 Cyberink。

`RELAY_SECURE=true` 表示连接时直接使用 TLS，通常对应端口 `465`。`NODE_ENV=production` 要求此选项为 `true`，并且必须提供 Relay 用户名和密码。

页面提示已提交至发送服务器，表示 Relay 已接受邮件，并不代表收件箱最终收到。出现临时失败、永久失败或结果不确定时，页面会显示对应说明及记录编号。系统不会自动重试；结果不确定时，应先核查发送记录和 Relay 日志，再决定是否重新发送。

## 配置参考

应用默认读取项目根目录的 `.env`，已有环境变量优先于文件中的值。也可以在启动前通过 `MAIL_ENV_FILE` 指定其他配置文件。修改配置后需要重启服务。

| 配置项 | 默认值或说明 |
| --- | --- |
| `NODE_ENV` | 默认 `development`；正式运行模式为 `production` |
| `HOST` | `127.0.0.1`，同时控制 HTTP 和 SMTP 的监听地址 |
| `TRUST_PROXY` | 默认留空；可信反向代理的 IP，多个地址用英文逗号分隔 |
| `HTTP_PORT` | `3000` |
| `SMTP_PORT` | `2525` |
| `MAIL_DOMAINS` | `example.test`，多个域名以英文逗号分隔 |
| `MAX_MESSAGE_BYTES` | `10485760`，收信及发送邮件的 MIME 大小上限，单位为字节，最大 50 MiB |
| `MAX_ATTACHMENTS` | `10`，每封出站邮件的附件数量上限，范围 0～1000，0 表示禁用 |
| `MAX_ATTACHMENT_BYTES` | 单个出站附件的原始字节数上限，未设置时与 `MAX_MESSAGE_BYTES` 相同 |
| `STORAGE_DIR` | `.data/mail`，原始邮件和附件的保存目录 |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` |
| `DB_DATABASE` / `DB_USER` / `DB_PASSWORD` | 必填，与创建的数据库和账号保持一致 |
| `RELAY_HOST` / `RELAY_PORT` | `127.0.0.1` / `2526` |
| `RELAY_SECURE` | 默认 `false`；隐式 TLS 连接使用 `true` |
| `RELAY_USER` / `RELAY_PASSWORD` | Relay 认证信息 |

`.env` 包含数据库和 Relay 密码，应保存在本机，不要提交到版本库。服务进程需要拥有 `STORAGE_DIR` 的读写权限。

使用反向代理时，请为附件上传设置合适的请求体上限。例如，默认邮件大小上限为 10 MiB 时，可在 Nginx 中配置 `client_max_body_size 11m;`，为表单边界预留空间；应用仍会按 `MAX_MESSAGE_BYTES` 校验最终邮件大小。

## Nginx HTTPS 反向代理

Nginx 终止 HTTPS、再通过 HTTP 转发到 Cyberink 时，需要将外部协议与访问域名传给应用，并显式配置可信代理。否则浏览器的 Origin 与后端识别的地址不同，登录或修改邮件时会返回“请求来源无效”。

以下示例适用于 Nginx 与 Cyberink 同机运行。在 `.env` 中设置：

```dotenv
HOST=127.0.0.1
HTTP_PORT=3000
TRUST_PROXY=127.0.0.1
```

在已有的 Nginx HTTPS `server` 中配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Connection "";
    proxy_next_upstream off;
}
```

`$http_host` 保留外部域名及非标准端口，例如 `mail.example.com:8443`。Nginx 应覆盖这些转发头，保留浏览器原始的 Origin 和 CSRF 请求头。

`TRUST_PROXY` 填写 Nginx 连接应用时的源 IP，而非浏览器 IP；支持多个明确的 IPv4 或 IPv6 地址，例如 `127.0.0.1,::1`。Nginx 在其他主机上时，填写对应代理地址，并将应用 HTTP 端口限制为仅允许该代理连接。

更新代码后执行 `pnpm build` 并重启应用；修改 Nginx 配置后，检查配置并重载。生产模式仍需通过 HTTPS 访问，并配置带认证的 TLS Relay。

## 数据保存与备份

原始邮件保存为 `STORAGE_DIR/delivery-*/message.eml`，附件与原始邮件保存在同一投递目录中。出站附件保存在 `STORAGE_DIR/outbound/request-*/` 中，文件名由服务器生成。MariaDB 保存账号、邮箱、邮件索引、正文、附件关联和发送状态。

备份时需要同时保留 MariaDB 数据和 `STORAGE_DIR`，并保持二者一致。恢复时应保持邮件目录的绝对路径不变，因为数据库中保存了文件路径。

构建运行需要保留 `dist/`、`public/` 和运行依赖。Web 静态资源位于 `public/`，不会复制到 `dist/`。

## 当前限制

- Web 邮箱以纯文本显示正文；当前不提供富文本邮件编辑。
- 登录会话保存在内存中，有效期为 8 小时，服务重启后需要重新登录。
- 不提供 IMAP、POP3、入站 SMTP AUTH 或入站 STARTTLS。
- 内置 HTTP 服务不直接提供 TLS；HTTPS 访问由 Nginx 等可信反向代理提供。生产模式使用 Secure Cookie，需要通过 HTTPS 访问。
- 不包含垃圾邮件过滤、DKIM 签名、自动重试队列或邮件物理清理功能。

## 更新已有部署

更新源码后，在项目根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm db:init
pnpm build
```

随后重启 Cyberink 并刷新浏览器。

## 许可证

本项目使用 [MIT License](LICENSE)。
