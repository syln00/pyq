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

## Docker 快速启动

要求 Linux 服务器已安装 Docker Engine 和 Docker Compose v2。

```bash
cp .env.docker.example .env
```

修改 `.env` 中所有密码和密钥。本机测试可保留 `http://localhost`；公网部署必须配置站点域名、S3 子域名，并设置：

```env
SESSION_COOKIE_SECURE=true
```

启动完整栈：

```bash
docker compose up -d --build
docker compose ps
```

默认包含：

- Caddy：只对外开放 80/443；
- Next.js 前端；
- Express 后端；
- MySQL 8 持久卷；
- 私有 MinIO 持久卷；
- 一次性 `db-init` 和 `minio-init`。

首次初始化会使用 `.env` 的 `ADMIN_EMAIL`、`ADMIN_USERNAME`、`ADMIN_PASSWORD` 创建管理员。已有管理员不会被重置密码。

完整步骤见 [Docker 自托管指南](docs/SELF_HOSTING.md)。

## 存储迁移与备份

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
