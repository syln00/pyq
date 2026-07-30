# pyq · 私密朋友圈博客

一个微信朋友圈风格的多用户博客，支持动态、长文章、历史发布时间、地理位置、评论点赞和私有媒体。

本分支重点增加了可审核注册、普通发布者、按用户可见和可迁移私有 S3。新内容默认仅登录用户可见，注册默认关闭。

## 核心能力

- 动态和文章统一支持 `public`、`authenticated`、`selected` 三种可见性。
- 指定用户内容只有作者、管理员和被选中的有效用户可以查看；无权详情统一返回 404。
- 管理员可以关闭注册、审核或拒绝申请、停用账号，以及授予普通用户发布权限。
- 普通发布者只能编辑和删除自己的动态、文章与媒体，不能置顶、管理广告或修改全站设置。
- 发布时间与实际录入时间分离，可选择当前或过去时间，排序、归档、搜索和 RSS 均使用发布时间。
- 媒体 Bucket 始终私有，数据库只保存 provider-neutral `objectKey`，读取通过稳定的 `/api/media/:id/content` 鉴权地址。
- MinIO、Cloudflare R2 和 NAS S3 使用同一套 `S3_*` 配置，迁移时无需批量改写帖子 URL。
- 同时支持 Docker 自托管和 Vercel + 托管 MySQL + R2。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Next.js 16、React 19、Tailwind CSS 4、Zustand |
| 后端 | Express 5、Sequelize 6、TypeScript |
| 数据库 | MySQL 8 或兼容数据库 |
| 媒体 | 私有 S3 API：MinIO、Cloudflare R2、NAS S3 |
| 自托管入口 | Caddy，同源 `/api`，自动 HTTPS |

## Docker 服务器部署

项目已经包含 Next.js、Express、MySQL 8、MinIO 和 Caddy 的完整 Compose。Caddy 只对外开放 80/443，MySQL、MinIO Console 和应用容器保留在 Docker 内部网络。

### 1. 准备服务器和域名

- 安装 Docker Engine 和 Docker Compose v2 的 Linux 服务器；
- 至少 2 GB 内存，推荐 4 GB；
- 准备站点域名和 S3 子域名，例如 `pyq.example.com`、`s3.pyq.example.com`；
- 将两个域名的 A/AAAA 记录指向服务器；
- 防火墙开放 TCP 80、TCP/UDP 443，不要开放 3306、9000、9001。

### 2. 下载项目

```bash
git clone https://github.com/syln00/pyq.git
cd pyq
```

### 3. 配置环境变量

```bash
cp .env.docker.example .env
```

公网 HTTPS 部署的核心配置示例：

```env
SITE_ADDRESS=pyq.example.com
SITE_URL=https://pyq.example.com
S3_ADDRESS=s3.pyq.example.com
SESSION_COOKIE_SECURE=true

MYSQL_DATABASE=moment_blog
MYSQL_USER=pyq
MYSQL_PASSWORD=replace-with-a-long-database-password
MYSQL_ROOT_PASSWORD=replace-with-a-different-root-password

MINIO_ROOT_USER=pyq-minio
MINIO_ROOT_PASSWORD=replace-with-a-long-minio-password

S3_ENDPOINT=http://minio:9000
S3_PRESIGN_ENDPOINT=https://s3.pyq.example.com
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=pyq-minio
S3_SECRET_ACCESS_KEY=replace-with-the-same-minio-password
S3_BUCKET=pyq-media
S3_FORCE_PATH_STYLE=true
S3_SIGNED_GET_TTL_SECONDS=300

JWT_SECRET=replace-with-at-least-32-random-characters
JWT_EXPIRES_IN=7d
ADMIN_EMAIL=admin@example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-admin-password
REVALIDATE_SECRET=replace-with-a-random-revalidate-secret
CRON_SECRET=replace-with-a-random-cron-secret
```

`SITE_ADDRESS`、`S3_ADDRESS` 不带协议，`SITE_URL`、`S3_PRESIGN_ENDPOINT` 必须带 `https://`。使用内置 MinIO 时，`MINIO_ROOT_USER` 与 `S3_ACCESS_KEY_ID` 相同，`MINIO_ROOT_PASSWORD` 与 `S3_SECRET_ACCESS_KEY` 相同。

随机密钥可以用以下命令生成：

```bash
openssl rand -hex 32
```

这些数据库密码和程序密钥不需要人工记忆，建议保存在密码管理器中。服务器上的 `.env` 应限制为仅当前用户可读写，并且绝不能提交到 Git：

```bash
chmod 600 .env
```

### 4. 启动服务

先验证配置是否完整：

```bash
docker compose config --quiet
```

构建并启动完整服务：

```bash
docker compose up -d --build
docker compose ps
```

查看首次初始化日志：

```bash
docker compose logs --tail=100 db-init minio-init backend frontend caddy
```

`db-init` 和 `minio-init` 正常情况下会执行成功后退出；MySQL、MinIO、后端、前端和 Caddy 应保持 running/healthy。Caddy 会在域名解析和 80/443 可访问后自动申请 HTTPS 证书。

### 5. 首次登录

访问 `https://pyq.example.com/admin/login`，使用 `.env` 中的 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 登录。首次初始化会创建管理员；管理员已经存在时，修改 `.env` 不会自动修改其密码。

注册默认关闭。管理员可以在后台开启注册、审核新用户并授予普通用户发布权限。

### 6. 部署后验证（可选）

建议在正式发布内容前测试管理员登录、用户审核、三种可见性、历史发布时间和图片/音视频上传。还可以重启 Compose，确认数据库和媒体对象仍然存在：

```bash
docker compose restart
```

### 7. 配置备份（可选）

在服务器安装并配置 `rclone` 后，可以同时备份 MySQL 和 MinIO 对象：

```bash
RCLONE_SOURCE=pyq-minio:pyq-media \
  ./scripts/backup.sh /mnt/backups/pyq
```

建议将备份复制到 NAS、另一台服务器或其他存储介质，不要只保留在当前服务器硬盘上。

### 8. 更新版本

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
```

不要执行 `docker compose down -v`，除非明确要删除数据库、媒体对象和 Caddy 证书卷。

完整说明见 [Docker 自托管指南](docs/SELF_HOSTING.md)。

## 存储迁移（可选）

项目按原始 `objectKey` 管理对象。MinIO 迁往 R2、NAS S3 或另一台服务器时，复制对象并修改 `S3_*` 环境变量即可。

```bash
# 先预演，不写入目标端
./scripts/migrate-storage.sh source:bucket destination:bucket

# 确认后实际复制并校验
./scripts/migrate-storage.sh source:bucket destination:bucket --apply

# 检查数据库媒体记录对应的对象是否存在、大小是否一致
./scripts/check-media-integrity.sh
```

备份、恢复、rclone 配置和停机迁移流程见 [备份与存储迁移指南](docs/STORAGE_MIGRATION.md)。

## Vercel 部署

Vercel 部署使用两个项目：

- 前端 Root Directory：`frontend`
- 后端 Root Directory：`backend`
- 数据库：公网可访问的托管 MySQL/TiDB
- 媒体：私有 Cloudflare R2

R2 不需要公开 Bucket 或公开媒体域名。浏览器通过预签名 URL 上传，站内读取仍使用稳定的鉴权媒体地址。

详见 [后端 Vercel 部署指南](backend/VERCEL_DEPLOYMENT.md)。

## 本地开发

后端：

```bash
cd backend
npm install
cp .env.example .env
npm run db:init
npm run dev
```

前端：

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

默认地址：前端 `http://localhost:3000`，后端 `http://localhost:4000`。

## 验证命令

```bash
(cd backend && npm run build)
(cd frontend && npx tsc --noEmit && npm run build)
git diff --check
```

全仓库 ESLint 仍包含上游遗留规则错误，应优先对本次修改文件做定向检查。

## 安全说明

- 不要提交 `.env`、数据库密码、JWT 密钥或 S3 Secret Key。
- 正式环境必须使用 HTTPS 和 `SESSION_COOKIE_SECURE=true`。
- MinIO Console 默认不对公网开放，Bucket 默认禁止匿名访问。
- 私密帖子中的外部图片、视频或音频直链无法被本站 ACL 保护；发布时必须显式确认风险。
- RSS 永远只输出公开内容。
