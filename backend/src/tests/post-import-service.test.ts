import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPostImportKey,
  normalizeImportPublishedAt,
  validateImportRowFields,
  type NormalizedImportRow,
} from "../services/post-import-service";

const NOW = new Date("2026-07-31T12:00:00.000Z");

test("无时区发布时间按 Asia/Shanghai 转换为 UTC", () => {
  assert.equal(
    normalizeImportPublishedAt("2024-02-29 12:30:00", NOW),
    "2024-02-29T04:30:00.000Z"
  );
  assert.throws(() => normalizeImportPublishedAt("2024-02-30 12:30:00", NOW), /发布时间格式无效/);
  assert.throws(() => normalizeImportPublishedAt("2027-01-01 00:00:00", NOW), /不能晚于当前时间/);
  assert.equal(normalizeImportPublishedAt("", NOW), null);
});

test("规范化可见性、图片路径和文字地址", () => {
  const result = validateImportRowFields({
    rowNumber: 2,
    content: "  一条历史动态  ",
    imageFiles: ["one.jpg", "images/two.heic"],
    publishedAt: "2024-01-02 03:04:05",
    visibility: "指定用户可见",
    visibleUserEmails: "A@example.com；b@example.com",
    location: { name: "", city: "武汉", address: "光谷广场", lng: "114.40", lat: "30.50" },
  }, 0, NOW);

  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.content, "一条历史动态");
  assert.deepEqual(result.normalized.imageFiles, ["images/one.jpg", "images/two.heic"]);
  assert.equal(result.normalized.visibility, "selected");
  assert.deepEqual(result.normalized.visibleUserEmails, ["a@example.com", "b@example.com"]);
  assert.deepEqual(result.normalized.location, {
    name: "光谷广场",
    city: "武汉",
    address: "光谷广场",
    lng: 114.4,
    lat: 30.5,
  });
});

test("拒绝不安全图片路径、空动态和错误坐标", () => {
  const result = validateImportRowFields({
    rowNumber: 3,
    content: "",
    imageFiles: ["../secret.jpg", "/absolute.png", "script.svg"],
    location: { name: "地点", lng: 200, lat: "" },
  }, 1, NOW);

  assert.match(result.errors.join("|"), /图片路径无效/);
  assert.match(result.errors.join("|"), /绝对路径/);
  assert.match(result.errors.join("|"), /不支持的图片格式/);
  assert.match(result.errors.join("|"), /动态文案和图片不能同时为空/);
  assert.match(result.errors.join("|"), /经度和纬度必须同时填写/);
  assert.match(result.errors.join("|"), /经度必须在 -180 到 180 之间/);
});

test("限制每条动态最多九张图片", () => {
  const result = validateImportRowFields({
    rowNumber: 4,
    imageFiles: Array.from({ length: 10 }, (_, index) => `${index}.jpg`),
  }, 2, NOW);
  assert.match(result.errors.join("|"), /最多 9 张图片/);
  assert.equal(result.normalized.imageFiles.length, 9);
});

test("导入幂等键忽略指定用户顺序但保留图片顺序", () => {
  const row: NormalizedImportRow = {
    rowNumber: 2,
    content: "相同内容",
    imageFiles: ["images/a.jpg", "images/b.jpg"],
    publishedAt: "2024-01-01T00:00:00.000Z",
    visibility: "selected",
    visibleUserEmails: ["a@example.com", "b@example.com"],
    location: { name: "武汉", city: "武汉" },
  };
  const first = buildPostImportKey(row, ["user-b", "user-a"], ["hash-a", "hash-b"]);
  const same = buildPostImportKey(row, ["user-a", "user-b"], ["hash-a", "hash-b"]);
  const reorderedImages = buildPostImportKey(row, ["user-a", "user-b"], ["hash-b", "hash-a"]);
  assert.equal(first, same);
  assert.notEqual(first, reorderedImages);
});
