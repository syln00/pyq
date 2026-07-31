# 备份与存储迁移指南

## 1. 为什么迁移不需要改帖子 URL

新媒体记录保存的是对象键，例如：

```text
media/2026/07/550e8400-e29b-41d4-a716-446655440000.jpg
```

帖子保存媒体 ID，页面使用稳定的 `/api/media/:id/content`。后端根据当前 `S3_*` 配置同源流式读取原图和 `previews/` 派生对象，所以 MinIO、R2 或 NAS 间只要保留相同对象键即可切换。

## 2. rclone 远端

在执行脚本的维护机上安装 rclone，并用交互式配置创建源和目标 remote：

```bash
rclone config
```

MinIO/NAS 通常选择 `S3`、对应 provider 或 `Minio`，配置 endpoint，并启用 path-style。R2 选择 `Cloudflare R2`，region 使用 `auto`，endpoint 为账户 S3 API 地址。

先只读确认：

```bash
rclone lsd pyq-minio:
rclone size pyq-minio:pyq-media
rclone size pyq-r2:pyq-media
```

不要把 rclone 配置文件或密钥提交到仓库。

## 3. 完整备份

脚本会通过 Compose 内的 `mysqldump --single-transaction` 生成压缩 SQL，同时把 Bucket 复制到独立时间戳目录，并执行 rclone check。

```bash
RCLONE_SOURCE=pyq-minio:pyq-media ./scripts/backup.sh
```

默认输出到 `./backups/YYYYMMDDTHHMMSSZ/`：

```text
mysql.sql.gz
mysql.sql.gz.sha256
objects/
rclone-check.txt
source-size.json
backup-size.json
manifest.txt
```

可以指定备份根目录：

```bash
RCLONE_SOURCE=pyq-minio:pyq-media ./scripts/backup.sh /mnt/nas/pyq-backups
```

备份目录应复制到另一台机器或另一种存储介质，不能只放在同一块服务器硬盘上。

## 4. MinIO 迁移到 R2/NAS

### 4.1 预演

```bash
./scripts/migrate-storage.sh pyq-minio:pyq-media pyq-r2:pyq-media
```

默认只执行 `rclone copy --dry-run`，不会改变目标端。

### 4.2 维护窗口

1. 停止公网入口和写入：

   ```bash
   docker compose stop caddy frontend backend
   ```

2. 创建最后一次完整备份：

   ```bash
   RCLONE_SOURCE=pyq-minio:pyq-media ./scripts/backup.sh
   ```

3. 实际复制，不删除目标端已有对象：

   ```bash
   ./scripts/migrate-storage.sh pyq-minio:pyq-media pyq-r2:pyq-media --apply
   ```

4. 如果两端没有共同的服务端哈希能力，可做下载式逐字节校验：

   ```bash
   RCLONE_VERIFY_DOWNLOAD=true ./scripts/migrate-storage.sh pyq-minio:pyq-media pyq-r2:pyq-media --apply
   ```

5. 修改 `.env` 中的 `S3_*`，保持 `S3_BUCKET` 和对象键不变。
6. 重启应用：

   ```bash
   docker compose up -d --force-recreate backend frontend caddy
   ```

7. 检查数据库媒体记录：

   ```bash
   ./scripts/check-media-integrity.sh
   ```

8. 分别验证公开、登录用户、指定用户、作者和管理员的图片、视频 Range、音频播放。
9. 源存储保持只读至少数天；确认没有遗漏后再下线。

## 5. 完整恢复

恢复会删除并重建当前数据库，并使用 `rclone sync` 使目标 Bucket 与备份一致，属于破坏性操作，必须显式传入 `--yes`。

```bash
RCLONE_DESTINATION=pyq-minio:pyq-media \
  ./scripts/restore.sh ./backups/20260730T120000Z --yes
```

恢复前脚本会验证数据库压缩包 SHA-256，并停止公开服务。完成后会执行 additive `db-init`，再启动后端、前端和 Caddy。

建议先在隔离的测试实例恢复并验收，再对生产环境执行。

## 6. 完整性检查结果

```bash
./scripts/check-media-integrity.sh
```

输出 JSON，包括：

- `missingCount`：数据库存在记录但对象不存在；
- `missingPreviewCount`：数据库记录了预览对象，但目标存储中不存在；
- `missingPreviewMetadataCount`：图片尚未记录宽高，可运行预览图回填；
- `sizeMismatchCount`：数据库大小与对象大小不一致；
- `stalePostBoundCount`：标记为帖子媒体但当前没有 `post_media` 引用，仅作为警告。

缺失原对象、缺失已登记的预览对象或大小不一致会返回非零退出码，可接入定时任务或监控。
