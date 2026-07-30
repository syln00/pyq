# Vercel + 托管 MySQL + 私有 R2 部署

该方案创建两个 Vercel 项目，共用同一仓库：

- 前端：Root Directory 选择 `frontend`，Framework 选择 Next.js；
- 后端：Root Directory 选择 `backend`，Framework 选择 Other；
- 数据库：TiDB Cloud、云厂商 RDS 或其他公网可访问的 MySQL 兼容服务；
- 媒体：Cloudflare R2 私有 Bucket。

## 1. 初始化数据库

先在数据库服务商处创建数据库，再在本地或受信任的维护环境执行：

```bash
cd backend
cp .env.example .env
npm install
npm run db:init
```

`db:init` 创建缺失表、执行 additive migration、创建站点设置和首个管理员。它可重复运行，不删除数据，也不会重置已有管理员密码。

不要在 Vercel 冷启动中设置 `DB_SYNC_ON_BOOT=true`，不要使用 `sync({ alter: true })`。

## 2. 后端环境变量

```env
NODE_ENV=production

DB_HOST=...
DB_PORT=3306
DB_USER=...
DB_PASSWORD=...
DB_NAME=moment_blog
DB_SSL=true

JWT_SECRET=...
JWT_EXPIRES_IN=7d
CLIENT_URL=https://pyq.example.com
CORS_ALLOWED_ORIGINS=https://pyq.example.com
REVALIDATE_SECRET=...
CRON_SECRET=...

STORAGE_DRIVER=s3
S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
S3_PRESIGN_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=pyq-media
S3_FORCE_PATH_STYLE=false
S3_SIGNED_GET_TTL_SECONDS=300
```

托管数据库是否需要 `DB_SSL` 和证书校验，以服务商连接说明为准。

R2 Bucket 保持私有，不需要 `R2_PUBLIC_URL`、公开自定义域名或 `NEXT_PUBLIC_MEDIA_ORIGIN`。旧 `R2_*` 环境变量仍有一个兼容周期，但新部署应直接使用 `S3_*`。

## 3. R2 CORS

浏览器会把文件直接 PUT 到预签名 R2 URL。Bucket CORS 至少允许实际前端 Origin：

```json
[
  {
    "AllowedOrigins": ["https://pyq.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag", "cf-ray", "x-amz-request-id"],
    "MaxAgeSeconds": 3600
  }
]
```

不要在正式环境使用通配 Origin。若使用 Vercel Production 域名和自定义域名，需都加入 AllowedOrigins。

## 4. 前端环境变量

```env
NEXT_PUBLIC_API_URL=/api
BACKEND_URL=https://your-backend.vercel.app
NEXT_PUBLIC_SITE_URL=https://pyq.example.com
REVALIDATE_SECRET=...
```

`BACKEND_URL` 不带 `/api` 和结尾 `/`。`REVALIDATE_SECRET` 必须与后端一致。

浏览器始终请求前端同源 `/api`，Next.js 再转发到后端，因此 HttpOnly Cookie、Origin 校验和私有内容 SSR 能保持一致。

## 5. 部署后验证

1. 请求后端 `/api/health`；
2. 管理员登录，确认 `pyq_session` 为 HttpOnly、Secure、SameSite=Lax；
3. 注册默认关闭；开启后注册一个用户并验证待审核流程；
4. 创建公开、登录可见和指定用户可见内容，分别用匿名和不同账号验证；
5. 上传图片、视频和音频，确认 R2 Bucket 仍无匿名读取权限；
6. 确认 `/api/media/:id/content` 对无权限用户返回 404，对合法用户跳转短时签名 URL；
7. 确认 RSS 只包含公开内容。

## 6. Serverless 注意事项

- Vercel 文件系统不持久，所有媒体必须进入 S3/R2；
- 大文件必须使用项目现有的 presign → PUT → confirm 流程，不能改回 multipart 上传后端；
- Serverless 数据库连接池默认较小，可用 `DB_POOL_MAX`、`DB_POOL_IDLE` 调整；
- 内存限流不跨函数实例，如需严格全局限流应接入共享 Redis；
- 部署新版本前先备份数据库和 R2 对象。

