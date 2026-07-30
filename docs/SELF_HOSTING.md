# Docker 自托管指南

## 1. 架构

```text
浏览器
  ├─ https://pyq.example.com ── Caddy ── frontend / backend(/api)
  └─ https://s3.pyq.example.com ─ Caddy ── private MinIO S3 API

backend ── MySQL
backend ── MinIO / R2 / NAS S3
```

MySQL、后端、前端和 MinIO Console 只位于 Docker 内部网络。外部只访问 Caddy 的 80/443。

## 2. 前置条件

- 一台安装 Docker Engine 与 Docker Compose v2 的 Linux 服务器；
- 至少 2 GB 内存，媒体较多时建议 4 GB 以上；
- 公网部署准备两个域名并指向服务器：站点域名和 S3 子域名；
- 防火墙开放 TCP 80、TCP/UDP 443，不要开放 3306、4000、9000、9001。

## 3. 环境变量

```bash
cp .env.docker.example .env
```

至少替换以下值：

```env
MYSQL_PASSWORD=...
MYSQL_ROOT_PASSWORD=...
MINIO_ROOT_PASSWORD=...
S3_SECRET_ACCESS_KEY=...
JWT_SECRET=...
ADMIN_PASSWORD=...
REVALIDATE_SECRET=...
CRON_SECRET=...
```

`MINIO_ROOT_PASSWORD` 和默认 MinIO 的 `S3_SECRET_ACCESS_KEY` 必须填写同一个值。随机密钥可以用 `openssl rand -hex 32` 生成。

### 本机 HTTP 验证

```env
SITE_ADDRESS=http://localhost
SITE_URL=http://localhost
S3_ADDRESS=http://s3.localhost
S3_ENDPOINT=http://minio:9000
S3_PRESIGN_ENDPOINT=http://s3.localhost
SESSION_COOKIE_SECURE=false
```

### 公网 HTTPS

假设域名为 `pyq.example.com` 和 `s3.pyq.example.com`：

```env
SITE_ADDRESS=pyq.example.com
SITE_URL=https://pyq.example.com
S3_ADDRESS=s3.pyq.example.com
S3_ENDPOINT=http://minio:9000
S3_PRESIGN_ENDPOINT=https://s3.pyq.example.com
SESSION_COOKIE_SECURE=true
```

Caddy 会自动申请和续期证书。首次签发前需确认两个域名均已解析到服务器，并且 80/443 可从公网访问。

## 4. 首次启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 db-init minio-init backend frontend caddy
```

`db-init` 和 `minio-init` 正常状态是执行成功后退出。其他五个长期服务应为 running/healthy。

`minio-init` 还会确保 `staging/` 暂存对象按 `S3_STAGING_EXPIRY_DAYS` 自动过期，默认保留一天。上传成功确认后暂存对象会立即删除；该规则主要清理由于断网、关闭页面等原因未完成确认的上传。

打开 `SITE_URL`，使用初始管理员登录。注册默认关闭，可在后台站点设置中开启。开启后新账号仍需管理员审核。

如果升级前已经上传过媒体，可以选择运行一次哈希回填，让后续重复上传复用已有媒体。该命令只填写 SHA-256 并报告已有重复项，不会删除或合并文件：

```bash
docker compose run --rm backend node dist/scripts/backfill-media-hashes.js
```

## 5. 数据持久化

Compose 使用以下命名卷：

- `pyq_mysql_data`：数据库；
- `pyq_minio_data`：媒体对象；
- `pyq_caddy_data`：证书和 ACME 数据；
- `pyq_caddy_config`：Caddy 运行配置。

重建容器不会删除卷。不要使用 `docker compose down -v`，除非明确要删除全部数据库、媒体和证书数据。

## 6. 更新

先备份，再更新：

```bash
RCLONE_SOURCE=pyq-minio:pyq-media ./scripts/backup.sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

数据库初始化是 additive、可重复执行的；Compose 会先完成 `db-init` 再启动后端。

## 7. 切换到 R2 或 NAS S3

应用读取以下 provider-neutral 配置：

```env
S3_ENDPOINT=...
S3_PRESIGN_ENDPOINT=...
S3_REGION=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=...
S3_FORCE_PATH_STYLE=...
```

R2 示例：

```env
S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
S3_PRESIGN_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=pyq-media
S3_FORCE_PATH_STYLE=false
```

NAS S3 示例：

```env
S3_ENDPOINT=http://nas-s3.internal:9000
S3_PRESIGN_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=pyq-media
S3_FORCE_PATH_STYLE=true
```

`S3_ENDPOINT` 是后端可访问的地址；`S3_PRESIGN_ENDPOINT` 必须是用户浏览器可访问的地址。两者可以不同。

切换到 R2 或 NAS S3 时，也应在对应存储服务中为 `staging/` 前缀配置生命周期过期规则。`S3_STAGING_EXPIRY_DAYS` 只由 Compose 内置的 MinIO 初始化服务自动应用，不会替你修改外部 Bucket。

复制对象并验证后，只需修改这组变量并重启：

```bash
docker compose up -d --force-recreate backend frontend caddy
```

内置 MinIO 可以暂时继续运行但保持只读，确认迁移无误后再单独下线。详细流程见 [STORAGE_MIGRATION.md](STORAGE_MIGRATION.md)。

## 8. 故障排查

```bash
docker compose ps
docker compose logs --tail=200 backend
docker compose logs --tail=200 frontend
docker compose logs --tail=200 caddy
docker compose logs --tail=200 minio
```

- 登录后仍是未登录：检查 `SITE_URL`、`SESSION_COOKIE_SECURE` 和 HTTPS。
- 写请求返回 `INVALID_ORIGIN`：检查 `SITE_URL` 是否与浏览器地址完全一致。
- 上传 PUT CORS 失败：检查 MinIO/R2 的 Allowed Origin 是否包含 `SITE_URL`。
- 上传签名地址不可达：检查 `S3_PRESIGN_ENDPOINT` 是浏览器可访问地址，而不是 Docker 内部服务名。
- 媒体 404：先确认用户拥有帖子查看权限，再运行 `./scripts/check-media-integrity.sh`。
