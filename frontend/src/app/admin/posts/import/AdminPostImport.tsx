"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Download,
  FileArchive,
  FileSpreadsheet,
  Loader2,
  UploadCloud,
} from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { refreshSessionUser } from "@/lib/auth";
import { uploadDirect } from "@/lib/upload";
import {
  downloadImportResults,
  downloadImportTemplate,
  formatBytes,
  parseImportZip,
  type ImportResultRow,
  type ImportValidationResult,
  type ParsedImportPackage,
} from "@/lib/post-import";

interface PreparedRow {
  validation: ImportValidationResult;
  errors: string[];
  valid: boolean;
}

type Phase = "idle" | "parsing" | "ready" | "uploading" | "importing" | "done";

async function responseMessage(response: Response, fallback: string) {
  const data = await response.json().catch(() => null);
  return typeof data?.message === "string" ? data.message : fallback;
}

export default function AdminPostImport() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const packageRef = useRef<ParsedImportPackage | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [filename, setFilename] = useState("");
  const [preparedRows, setPreparedRows] = useState<PreparedRow[]>([]);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<ImportResultRow[]>([]);
  const [uploadProgress, setUploadProgress] = useState({ completed: 0, total: 0 });
  const [packageStats, setPackageStats] = useState({ imageCount: 0, totalImageBytes: 0 });

  useEffect(() => {
    void refreshSessionUser().then((user) => {
      if (!user) router.replace("/admin/login");
      else if (user.role !== "admin") router.replace("/admin/posts");
    });
    return () => {
      void packageRef.current?.close();
      packageRef.current = null;
    };
  }, [router]);

  const summary = useMemo(() => ({
    valid: preparedRows.filter((row) => row.valid).length,
    invalid: preparedRows.filter((row) => !row.valid).length,
  }), [preparedRows]);

  const resultSummary = useMemo(() => ({
    created: results.filter((row) => row.status === "created").length,
    duplicate: results.filter((row) => row.status === "duplicate").length,
    failed: results.filter((row) => row.status === "failed").length,
  }), [results]);

  const resetPackage = async () => {
    const current = packageRef.current;
    packageRef.current = null;
    if (current) await current.close().catch(() => {});
    setPreparedRows([]);
    setResults([]);
    setUploadProgress({ completed: 0, total: 0 });
    setPackageStats({ imageCount: 0, totalImageBytes: 0 });
    setMessage("");
  };

  const handleFile = async (file: File) => {
    await resetPackage();
    setFilename(file.name);
    setPhase("parsing");
    try {
      const parsed = await parseImportZip(file);
      packageRef.current = parsed;
      setPackageStats({ imageCount: parsed.imageCount, totalImageBytes: parsed.totalImageBytes });
      const response = await apiFetch("/admin/post-imports/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: parsed.rows.map((row) => ({
            rowNumber: row.rowNumber,
            content: row.content,
            imageFiles: row.imageFiles,
            publishedAt: row.publishedAt,
            visibility: row.visibility,
            visibleUserEmails: row.visibleUserEmails,
            location: row.location,
          })),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, "服务器校验失败"));
      const data = await response.json() as { rows: ImportValidationResult[] };
      const localErrors = new Map(parsed.rows.map((row) => [row.rowNumber, row.localErrors]));
      const merged = data.rows.map((validation) => {
        const errors = [...(localErrors.get(validation.rowNumber) || []), ...validation.errors];
        return { validation, errors: [...new Set(errors)], valid: validation.valid && errors.length === 0 };
      });
      setPreparedRows(merged);
      setPhase("ready");
    } catch (error) {
      await packageRef.current?.close().catch(() => {});
      packageRef.current = null;
      setPhase("idle");
      setMessage(error instanceof Error ? error.message : "解析导入包失败");
    }
  };

  const uploadAssets = async (paths: string[]) => {
    const parsed = packageRef.current;
    if (!parsed) throw new Error("导入包已经关闭，请重新选择文件");
    const mediaIds = new Map<string, string>();
    const failures = new Map<string, string>();
    let cursor = 0;
    let completed = 0;
    setUploadProgress({ completed: 0, total: paths.length });

    const worker = async () => {
      while (cursor < paths.length) {
        const index = cursor++;
        const path = paths[index];
        const asset = parsed.images.get(path);
        if (!asset) {
          failures.set(path, "ZIP 中找不到图片");
          completed += 1;
          setUploadProgress({ completed, total: paths.length });
          continue;
        }
        try {
          const file = await asset.toFile();
          const uploaded = await uploadDirect(file, "", "image");
          mediaIds.set(path, uploaded.id);
        } catch (error) {
          failures.set(path, error instanceof Error ? error.message : "图片上传失败");
        } finally {
          completed += 1;
          setUploadProgress({ completed, total: paths.length });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(3, paths.length) }, () => worker()));
    return { mediaIds, failures };
  };

  const startImport = async () => {
    const parsed = packageRef.current;
    if (!parsed || summary.valid === 0) return;
    setMessage("");
    setResults([]);
    const invalidResults: ImportResultRow[] = preparedRows
      .filter((row) => !row.valid)
      .map((row) => ({ rowNumber: row.validation.rowNumber, status: "failed", errors: row.errors }));
    const validRows = preparedRows.filter((row) => row.valid);
    const paths = [...new Set(validRows.flatMap((row) => row.validation.normalized.imageFiles))];

    setPhase("uploading");
    try {
      const { mediaIds, failures } = await uploadAssets(paths);
      const uploadFailed: ImportResultRow[] = [];
      const readyRows = validRows.filter((row) => {
        const failedPaths = row.validation.normalized.imageFiles.filter((path) => failures.has(path));
        if (failedPaths.length === 0) return true;
        uploadFailed.push({
          rowNumber: row.validation.rowNumber,
          status: "failed",
          errors: failedPaths.map((path) => `${path}：${failures.get(path)}`),
        });
        return false;
      });

      let imported: ImportResultRow[] = [];
      if (readyRows.length > 0) {
        setPhase("importing");
        const response = await apiFetch("/admin/post-imports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rows: readyRows.map((row) => ({
              ...row.validation.normalized,
              mediaIds: row.validation.normalized.imageFiles.map((path) => mediaIds.get(path)),
            })),
          }),
        });
        if (!response.ok) throw new Error(await responseMessage(response, "批量导入失败"));
        const data = await response.json() as { results: ImportResultRow[] };
        imported = data.results;
      }
      setResults([...invalidResults, ...uploadFailed, ...imported].sort((a, b) => a.rowNumber - b.rowNumber));
      setPhase("done");
    } catch (error) {
      setResults(invalidResults);
      setPhase("ready");
      setMessage(error instanceof Error ? error.message : "批量导入失败");
    }
  };

  const busy = phase === "parsing" || phase === "uploading" || phase === "importing";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/posts" className="mb-2 inline-flex items-center gap-1 text-sm text-adm-text-secondary hover:text-adm-text">
            <ArrowLeft className="h-4 w-4" />返回动态管理
          </Link>
          <h1 className="text-xl font-bold text-adm-text">Excel 批量导入动态</h1>
          <p className="mt-1 text-sm text-adm-text-secondary">上传 ZIP 后先校验，再自动并发上传图片并逐行导入。</p>
        </div>
        <button
          type="button"
          onClick={() => void downloadImportTemplate()}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-adm-border bg-adm-card px-4 py-2 text-sm font-medium text-adm-text hover:bg-adm-card-hover disabled:opacity-50"
        >
          <Download className="h-4 w-4" />下载模板 ZIP
        </button>
      </div>

      <div className="rounded-2xl border border-adm-border bg-adm-card p-5">
        <div className="grid gap-4 md:grid-cols-3">
          <Instruction icon={<FileSpreadsheet className="h-5 w-5" />} title="填写 Excel" text="编辑 moments.xlsx，图片列填写文件名，不要把图片嵌入表格。" />
          <Instruction icon={<FileArchive className="h-5 w-5" />} title="整理 ZIP" text="moments.xlsx 放根目录，图片放 images/；单批最多 100 条、500 图。" />
          <Instruction icon={<UploadCloud className="h-5 w-5" />} title="校验并导入" text="正确行继续导入，错误行会跳过并可下载结果报告。" />
        </div>
      </div>

      <div className="rounded-2xl border border-adm-border bg-adm-card p-5">
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-adm-border px-6 py-10 text-center transition-colors hover:border-adm-text-tertiary hover:bg-adm-card-hover disabled:opacity-50"
        >
          {phase === "parsing" ? <Loader2 className="mb-3 h-8 w-8 animate-spin text-adm-text-secondary" /> : <FileArchive className="mb-3 h-8 w-8 text-adm-text-secondary" />}
          <span className="font-medium text-adm-text">{phase === "parsing" ? "正在解析并校验…" : filename || "选择 ZIP 导入包"}</span>
          <span className="mt-1 text-xs text-adm-text-tertiary">ZIP 最大 1GB；图片会直接上传到当前 S3 存储</span>
        </button>
        {message && <div className="mt-3 flex items-start gap-2 rounded-lg bg-adm-danger-bg px-3 py-2 text-sm text-adm-danger"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{message}</div>}
      </div>

      {preparedRows.length > 0 && (
        <div className="space-y-4 rounded-2xl border border-adm-border bg-adm-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-adm-text">导入预览</h2>
              <p className="mt-1 text-sm text-adm-text-secondary">
                {preparedRows.length} 条动态，{packageStats.imageCount} 个图片文件（{formatBytes(packageStats.totalImageBytes)}）；
                <span className="text-emerald-600"> {summary.valid} 条可导入</span>，
                <span className={summary.invalid ? "text-adm-danger" : ""}> {summary.invalid} 条有问题</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => void startImport()}
              disabled={busy || summary.valid === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-white dark:text-gray-900"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {phase === "uploading" ? `上传图片 ${uploadProgress.completed}/${uploadProgress.total}` : phase === "importing" ? "正在写入动态…" : "开始导入正确行"}
            </button>
          </div>

          <div className="max-h-[460px] overflow-auto rounded-xl border border-adm-border">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="sticky top-0 bg-adm-card-hover text-xs text-adm-text-secondary">
                <tr><th className="px-3 py-2">行号</th><th className="px-3 py-2">动态文案</th><th className="px-3 py-2">图片</th><th className="px-3 py-2">发布时间</th><th className="px-3 py-2">可见性</th><th className="px-3 py-2">校验</th></tr>
              </thead>
              <tbody className="divide-y divide-adm-border">
                {preparedRows.map((row) => (
                  <tr key={row.validation.rowNumber} className="align-top">
                    <td className="px-3 py-2 text-adm-text-tertiary">{row.validation.rowNumber}</td>
                    <td className="max-w-[300px] px-3 py-2 text-adm-text"><p className="line-clamp-3 whitespace-pre-wrap">{row.validation.normalized.content || "（仅图片）"}</p></td>
                    <td className="px-3 py-2 text-adm-text-secondary">{row.validation.normalized.imageFiles.length} 张</td>
                    <td className="whitespace-nowrap px-3 py-2 text-adm-text-secondary">{row.validation.normalized.publishedAt ? new Date(row.validation.normalized.publishedAt).toLocaleString("zh-CN", { hour12: false }) : "导入时当前时间"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-adm-text-secondary">{visibilityLabel(row.validation.normalized.visibility)}</td>
                    <td className="max-w-[320px] px-3 py-2">
                      {row.valid ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-4 w-4" />通过</span> : <ul className="space-y-1 text-xs text-adm-danger">{row.errors.map((error) => <li key={error}>• {error}</li>)}</ul>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="rounded-2xl border border-adm-border bg-adm-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-adm-text">导入完成</h2>
              <p className="mt-1 text-sm text-adm-text-secondary">成功 {resultSummary.created} 条，重复跳过 {resultSummary.duplicate} 条，失败 {resultSummary.failed} 条。</p>
            </div>
            <button type="button" onClick={() => void downloadImportResults(results)} className="inline-flex items-center gap-2 rounded-lg border border-adm-border px-4 py-2 text-sm text-adm-text hover:bg-adm-card-hover">
              <Download className="h-4 w-4" />下载导入结果
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Instruction({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="flex gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-adm-card-hover text-adm-text-secondary">{icon}</div><div><h3 className="text-sm font-medium text-adm-text">{title}</h3><p className="mt-1 text-xs leading-5 text-adm-text-tertiary">{text}</p></div></div>;
}

function visibilityLabel(value: "public" | "authenticated" | "selected") {
  if (value === "public") return "公开";
  if (value === "selected") return "指定用户可见";
  return "登录用户可见";
}
