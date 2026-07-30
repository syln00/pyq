import { Op, Transaction, WhereOptions, literal } from "sequelize";
import sequelize from "../config/database";
import { Media, Post, PostMedia, PostVisibleUser, User } from "../models";
import type { TokenPayload } from "../utils/jwt";

export type PostVisibility = "public" | "authenticated" | "selected";

export function publishedPostWhere(viewer?: TokenPayload, extra: WhereOptions = {}): WhereOptions {
  const clauses: any[] = [extra, { status: "published", publishedAt: { [Op.lte]: new Date() } }];
  if (viewer?.role === "admin") return { [Op.and]: clauses };
  if (!viewer) {
    clauses.push({ visibility: "public" });
    return { [Op.and]: clauses };
  }
  const userId = sequelize.escape(viewer.id);
  clauses.push({
    [Op.or]: [
      { visibility: "public" },
      { visibility: "authenticated" },
      { userId: viewer.id },
      literal(`EXISTS (SELECT 1 FROM post_visible_users pvu WHERE pvu.post_id = Post.id AND pvu.user_id = ${userId})`),
    ],
  });
  return { [Op.and]: clauses };
}

export async function canViewPost(post: Post, viewer?: TokenPayload): Promise<boolean> {
  if (viewer?.role === "admin" || viewer?.id === post.userId) return true;
  if (post.status !== "published" || post.publishedAt.getTime() > Date.now()) return false;
  if (post.visibility === "public") return true;
  if (!viewer) return false;
  if (post.visibility === "authenticated") return true;
  return Boolean(await PostVisibleUser.findOne({ where: { postId: post.id, userId: viewer.id } }));
}

export function canManagePost(post: Post, viewer?: TokenPayload): boolean {
  return Boolean(viewer && (viewer.role === "admin" || viewer.id === post.userId));
}

export async function validateSelectedUsers(ids: unknown, ownerId: string): Promise<string[]> {
  if (!Array.isArray(ids)) return [];
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ownerId))];
  if (unique.length === 0) return [];
  const users = await User.findAll({
    attributes: ["id"],
    where: { id: { [Op.in]: unique }, accountStatus: "active" },
  });
  if (users.length !== unique.length) throw new Error("指定用户中包含不存在或未通过审核的账号");
  return unique;
}

export async function replaceVisibleUsers(postId: string, userIds: string[], transaction?: Transaction) {
  await PostVisibleUser.destroy({ where: { postId }, transaction });
  if (userIds.length > 0) {
    await PostVisibleUser.bulkCreate(userIds.map((userId) => ({ postId, userId })), { transaction });
  }
}

export async function validateMediaIds(ids: unknown, uploaderId: string, isAdmin: boolean): Promise<string[]> {
  if (!Array.isArray(ids)) return [];
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (unique.length === 0) return [];
  const where: any = { id: { [Op.in]: unique } };
  if (!isAdmin) where.uploaderId = uploaderId;
  const media = await Media.findAll({ attributes: ["id"], where });
  if (media.length !== unique.length) throw new Error("媒体列表中包含不存在或无权使用的文件");
  return unique;
}

export async function replacePostMedia(postId: string, mediaIds: string[], transaction?: Transaction) {
  await PostMedia.destroy({ where: { postId }, transaction });
  if (mediaIds.length > 0) {
    await PostMedia.bulkCreate(mediaIds.map((mediaId) => ({ postId, mediaId })), { transaction });
    await Media.update({ accessClass: "post_bound" }, { where: { id: { [Op.in]: mediaIds }, accessClass: "owner_only" }, transaction });
  }
}

export function hasExternalMedia(value: unknown): boolean {
  const text = JSON.stringify(value ?? "");
  const urls = text.match(/https?:\\?\/\\?\/[^\s"'<>]+/gi) || [];
  return urls.some((raw) => {
    const url = raw.replace(/\\\//g, "/");
    return !url.includes("/api/media/");
  });
}
