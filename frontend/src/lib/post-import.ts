import type { CellValue, Worksheet } from "exceljs";
import type { FileEntry, ZipReader } from "@zip.js/zip.js";

export const IMPORT_MAX_ZIP_BYTES = 1024 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 100;
export const IMPORT_MAX_IMAGES = 500;
export const IMPORT_MAX_IMAGES_PER_ROW = 9;

const WORKBOOK_NAME = "moments.xlsx";
const SHEET_NAME = "动态";
const REQUIRED_HEADERS = [
  "动态文案",
  "图片文件",
  "发布时间",
  "可见性",
  "指定用户邮箱",
  "地点名称",
  "城市",
  "详细地址",
  "经度(GCJ-02)",
  "纬度(GCJ-02)",
] as const;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export interface ImportLocationDraft {
  name: string;
  city: string;
  address: string;
  lng: string;
  lat: string;
}

export interface ImportDraftRow {
  rowNumber: number;
  content: string;
  imageFiles: string[];
  publishedAt: string | null;
  visibility: string;
  visibleUserEmails: string[];
  location: ImportLocationDraft | null;
  localErrors: string[];
}

export interface ImportImageAsset {
  path: string;
  size: number;
  toFile: () => Promise<File>;
}

export interface ParsedImportPackage {
  rows: ImportDraftRow[];
  images: Map<string, ImportImageAsset>;
  imageCount: number;
  totalImageBytes: number;
  close: () => Promise<void>;
}

export interface ServerNormalizedRow {
  rowNumber: number;
  content: string;
  imageFiles: string[];
  publishedAt: string | null;
  visibility: "public" | "authenticated" | "selected";
  visibleUserEmails: string[];
  location: {
    name: string;
    city: string;
    address?: string;
    lng?: number;
    lat?: number;
  } | null;
}

export interface ImportValidationResult {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  normalized: ServerNormalizedRow;
}

export interface ImportResultRow {
  rowNumber: number;
  status: "created" | "duplicate" | "failed";
  postId?: string;
  errors?: string[];
}

function cellText(value: CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (value instanceof Date) return formatExcelDate(value);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || "").join("").trim();
    }
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value) return cellText(value.result as CellValue);
    if ("hyperlink" in value && typeof value.hyperlink === "string") return value.hyperlink.trim();
  }
  return "";
}

function formatExcelDate(value: Date) {
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

function splitList(value: string, pattern: RegExp) {
  return [...new Set(value.split(pattern).map((item) => item.trim()).filter(Boolean))];
}

function safeZipPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

function normalizeImageReference(value: string) {
  const path = safeZipPath(value);
  if (!path) return null;
  return path.includes("/") ? path : `images/${path}`;
}

function imageMime(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() || "";
  return IMAGE_MIME_BY_EXTENSION[extension] || "";
}

function rowIsEmpty(sheet: Worksheet, rowNumber: number, headerColumns: Map<string, number>) {
  return REQUIRED_HEADERS.every((header) => !cellText(sheet.getRow(rowNumber).getCell(headerColumns.get(header) || 1).value));
}

function buildHeaderColumns(sheet: Worksheet) {
  const columns = new Map<string, number>();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const header = cellText(cell.value);
    if (header) columns.set(header, columnNumber);
  });
  const missing = REQUIRED_HEADERS.filter((header) => !columns.has(header));
  if (missing.length > 0) throw new Error(`Excel 缺少列：${missing.join("、")}`);
  return columns;
}

function parseWorksheetRows(sheet: Worksheet) {
  if (sheet.getImages().length > 0) throw new Error("Excel 中检测到内嵌图片；请把图片放入 ZIP 的 images/ 文件夹，并在图片文件列填写文件名。");
  const columns = buildHeaderColumns(sheet);
  const rows: ImportDraftRow[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber++) {
    if (rowIsEmpty(sheet, rowNumber, columns)) continue;
    const row = sheet.getRow(rowNumber);
    const value = (header: typeof REQUIRED_HEADERS[number]) => cellText(row.getCell(columns.get(header)!).value);
    const imageFiles = splitList(value("图片文件"), /[|;；\n]+/);
    const visibleUserEmails = splitList(value("指定用户邮箱"), /[;,，；\n]+/).map((email) => email.toLowerCase());
    const name = value("地点名称");
    const city = value("城市");
    const address = value("详细地址");
    const lng = value("经度(GCJ-02)");
    const lat = value("纬度(GCJ-02)");
    const localErrors: string[] = [];
    if (imageFiles.length > IMPORT_MAX_IMAGES_PER_ROW) localErrors.push(`每条动态最多 ${IMPORT_MAX_IMAGES_PER_ROW} 张图片`);
    rows.push({
      rowNumber,
      content: value("动态文案"),
      imageFiles,
      publishedAt: value("发布时间") || null,
      visibility: value("可见性"),
      visibleUserEmails,
      location: name || city || address || lng || lat ? { name, city, address, lng, lat } : null,
      localErrors,
    });
  }
  if (rows.length === 0) throw new Error("动态工作表中没有可导入的数据");
  if (rows.length > IMPORT_MAX_ROWS) throw new Error(`每批最多导入 ${IMPORT_MAX_ROWS} 条动态`);
  return rows;
}

function createAsset(entry: FileEntry): ImportImageAsset {
  const path = entry.filename;
  const mime = imageMime(path);
  return {
    path,
    size: entry.uncompressedSize,
    async toFile() {
      const { BlobWriter } = await import("@zip.js/zip.js");
      const blob = await entry.getData(new BlobWriter(mime));
      const name = path.split("/").pop() || "image";
      return new File([blob], name, { type: mime, lastModified: entry.lastModDate?.getTime() || Date.now() });
    },
  };
}

export async function parseImportZip(file: File): Promise<ParsedImportPackage> {
  if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("请选择 ZIP 导入包");
  if (file.size <= 0 || file.size > IMPORT_MAX_ZIP_BYTES) throw new Error("ZIP 导入包不能为空且不能超过 1GB");

  const { BlobReader, BlobWriter, ZipReader: BrowserZipReader } = await import("@zip.js/zip.js");
  const reader: ZipReader<Blob> = new BrowserZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    if (entries.length > 600) throw new Error("ZIP 文件数量过多，请拆分后导入");
    const uncompressedBytes = entries.reduce((sum, entry) => sum + Number(entry.uncompressedSize || 0), 0);
    if (uncompressedBytes > 2 * IMPORT_MAX_ZIP_BYTES) throw new Error("ZIP 解压后的总大小超过 2GB，可能存在异常压缩内容");

    const files = entries.filter((entry): entry is FileEntry => !entry.directory);
    for (const entry of files) {
      if (!safeZipPath(entry.filename)) throw new Error(`ZIP 中包含不安全路径：${entry.filename}`);
      if (entry.encrypted) throw new Error(`不支持加密 ZIP 文件：${entry.filename}`);
    }

    const workbookEntry = files.find((entry) => entry.filename.toLowerCase() === WORKBOOK_NAME);
    if (!workbookEntry) throw new Error(`ZIP 根目录缺少 ${WORKBOOK_NAME}`);
    if (workbookEntry.uncompressedSize > 10 * 1024 * 1024) throw new Error("moments.xlsx 不能超过 10MB");

    const imageEntries = files.filter((entry) => entry.filename.startsWith("images/") && Boolean(imageMime(entry.filename)));
    if (imageEntries.length > IMPORT_MAX_IMAGES) throw new Error(`每批最多包含 ${IMPORT_MAX_IMAGES} 张图片`);
    const images = new Map<string, ImportImageAsset>();
    const basenameMatches = new Map<string, string[]>();
    for (const entry of imageEntries) {
      if (images.has(entry.filename)) throw new Error(`ZIP 中存在重复图片路径：${entry.filename}`);
      images.set(entry.filename, createAsset(entry));
      const basename = entry.filename.split("/").pop()!.toLowerCase();
      basenameMatches.set(basename, [...(basenameMatches.get(basename) || []), entry.filename]);
    }

    const workbookBlob = await workbookEntry.getData(new BlobWriter("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    await workbook.xlsx.load(await workbookBlob.arrayBuffer());
    const sheet = workbook.getWorksheet(SHEET_NAME);
    if (!sheet) throw new Error(`moments.xlsx 缺少“${SHEET_NAME}”工作表`);
    const rows = parseWorksheetRows(sheet);

    for (const row of rows) {
      const resolved: string[] = [];
      for (const reference of row.imageFiles) {
        const normalized = normalizeImageReference(reference);
        if (!normalized) {
          row.localErrors.push(`图片路径无效：${reference}`);
          continue;
        }
        let matched = images.has(normalized) ? normalized : null;
        if (!matched && !reference.includes("/") && !reference.includes("\\")) {
          const candidates = basenameMatches.get(reference.toLowerCase()) || [];
          if (candidates.length === 1) matched = candidates[0];
          else if (candidates.length > 1) row.localErrors.push(`图片文件名不唯一，请填写完整路径：${reference}`);
        }
        if (!matched) row.localErrors.push(`ZIP 中找不到图片：${reference}`);
        else if (!resolved.includes(matched)) resolved.push(matched);
      }
      row.imageFiles = resolved;
    }

    return {
      rows,
      images,
      imageCount: imageEntries.length,
      totalImageBytes: imageEntries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
      close: () => reader.close(),
    };
  } catch (error) {
    await reader.close().catch(() => {});
    throw error;
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function styleHeader(sheet: Worksheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  header.alignment = { vertical: "middle", horizontal: "center" };
  header.height = 24;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

export async function downloadImportTemplate() {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();
  workbook.creator = "pyq";
  workbook.created = new Date();

  const instructions = workbook.addWorksheet("说明");
  instructions.columns = [{ width: 24 }, { width: 92 }];
  instructions.addRows([
    ["项目", "说明"],
    ["目录结构", "ZIP 根目录放 moments.xlsx，图片统一放入 images/ 文件夹。"],
    ["图片文件", "填写图片文件名或 images/ 下的相对路径；多张用 |、分号或换行分隔，最多 9 张。"],
    ["发布时间", "支持 Excel 日期、YYYY-MM-DD HH:mm:ss 或 ISO；无时区时间按 Asia/Shanghai 解释，留空表示导入时当前时间。"],
    ["可见性", "可填：公开、登录用户可见、指定用户可见；留空默认登录用户可见。"],
    ["指定用户", "指定用户可见时填写 active 用户邮箱，多个邮箱用逗号、分号或换行分隔。"],
    ["地址", "地点名称、城市、详细地址均可选；经纬度必须成对填写，坐标系使用 GCJ-02。"],
    ["图片格式", "支持 JPG、PNG、GIF、WebP、HEIC/HEIF。HEIC/HEIF 上传时会转换为 JPEG。"],
    ["内嵌图片", "不支持把图片粘贴或插入 Excel 单元格，请使用 images/ 文件夹。"],
  ]);
  styleHeader(instructions);
  instructions.getColumn(1).font = { bold: true };

  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.columns = [
    { header: "动态文案", key: "content", width: 48 },
    { header: "图片文件", key: "images", width: 34 },
    { header: "发布时间", key: "publishedAt", width: 22 },
    { header: "可见性", key: "visibility", width: 18 },
    { header: "指定用户邮箱", key: "emails", width: 34 },
    { header: "地点名称", key: "location", width: 20 },
    { header: "城市", key: "city", width: 14 },
    { header: "详细地址", key: "address", width: 36 },
    { header: "经度(GCJ-02)", key: "lng", width: 18 },
    { header: "纬度(GCJ-02)", key: "lat", width: 18 },
  ];
  styleHeader(sheet);
  sheet.getColumn(3).numFmt = "yyyy-mm-dd hh:mm:ss";
  for (let rowNumber = 2; rowNumber <= 101; rowNumber++) {
    sheet.getCell(`D${rowNumber}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"公开,登录用户可见,指定用户可见"'],
    };
  }

  const xlsx = await workbook.xlsx.writeBuffer();
  const xlsxBlob = new Blob([xlsx], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const { BlobReader, BlobWriter, TextReader, ZipWriter } = await import("@zip.js/zip.js");
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  await writer.add(WORKBOOK_NAME, new BlobReader(xlsxBlob));
  await writer.add("images/请将图片放在此目录.txt", new TextReader("Excel 的“图片文件”列填写这里的图片文件名。\n"));
  const zip = await writer.close();
  downloadBlob(zip, "pyq-dynamics-import-template.zip");
}

export async function downloadImportResults(results: ImportResultRow[]) {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet("导入结果");
  sheet.columns = [
    { header: "Excel 行号", key: "rowNumber", width: 14 },
    { header: "状态", key: "status", width: 14 },
    { header: "动态 ID", key: "postId", width: 40 },
    { header: "失败原因", key: "error", width: 72 },
  ];
  const statusLabels = { created: "已创建", duplicate: "重复跳过", failed: "失败" } as const;
  for (const result of results) {
    sheet.addRow({
      rowNumber: result.rowNumber,
      status: statusLabels[result.status],
      postId: result.postId || "",
      error: result.errors?.join("；") || "",
    });
  }
  styleHeader(sheet);
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "导入结果.xlsx");
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
