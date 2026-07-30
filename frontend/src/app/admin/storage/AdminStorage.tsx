"use client";

import { Cloud, ShieldCheck } from "lucide-react";

export default function AdminStorage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-adm-text">私有 S3 对象存储</h2>
        <p className="mt-1 text-sm text-adm-text-secondary">
          图片、视频、音频和文件可存储在 MinIO、Cloudflare R2 或 NAS S3。
        </p>
      </div>

      <section className="rounded-xl border border-adm-border bg-adm-card p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500">
            <Cloud className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-semibold text-adm-text">Provider-neutral S3</h3>
            <p className="mt-1 text-sm leading-6 text-adm-text-secondary">
              S3 凭据只保存在后端环境变量中。数据库保存对象键和稳定媒体 ID，不保存厂商域名。
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-lg bg-adm-input p-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-adm-text">
            <ShieldCheck className="h-4 w-4 text-green-500" />
            后端必需环境变量
          </p>
          <code className="mt-3 block whitespace-pre-wrap text-xs leading-6 text-adm-text-secondary">
{`STORAGE_DRIVER=s3
S3_ENDPOINT
S3_PRESIGN_ENDPOINT
S3_REGION
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
S3_BUCKET
S3_FORCE_PATH_STYLE
S3_SIGNED_GET_TTL_SECONDS`}
          </code>
        </div>

        <p className="mt-4 text-xs leading-5 text-adm-text-tertiary">
          Bucket 必须保持私有。浏览器通过短期签名地址直传，读取时由本站检查帖子权限后跳转到短时 GET 地址。
          `S3_ENDPOINT` 可使用内网地址，`S3_PRESIGN_ENDPOINT` 必须是浏览器可访问地址；切换供应商时保留原 objectKey 即可。
        </p>
      </section>
    </div>
  );
}
