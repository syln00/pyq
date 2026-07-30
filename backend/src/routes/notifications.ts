import { Router, Response } from "express";
import { Op } from "sequelize";
import { Comment, Like, Post, User } from "../models";
import { authenticateOptional, type AuthRequest } from "../middleware/auth";
import { canViewPost } from "../services/post-access-service";

const router = Router();

interface NotificationItem {
  id: string;
  type: "like" | "comment" | "reply";
  actor: string;
  actorEmail: string;
  content: string;
  postPreview: string;
  postType: "music" | "image" | "link" | "text" | "video";
  postImage: string;
  postId: string;
  shortId?: string;
  isArticle?: boolean;
  commentId?: string;
  replyTo?: string | null;
  createdAt: string;
  isLive?: boolean;
}

const POST_ATTRIBUTES = [
  "id",
  "shortId",
  "userId",
  "type",
  "content",
  "images",
  "music",
  "linkCard",
  "video",
  "cover",
  "status",
  "visibility",
  "publishedAt",
] as const;

function preview(text: string) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  return normalized.length > 30 ? `${normalized.slice(0, 30)}…` : normalized;
}

function getPostThumb(post: any, defaultCover = ""): { type: "music" | "image" | "link" | "text" | "video"; image: string; isLive: boolean } {
  if (post.type === "article") return { type: "image", image: post.cover || defaultCover || "", isLive: false };
  if (post.music) return { type: "music", image: post.music.cover || post.music.artwork || "", isLive: false };
  if (post.video) return { type: "video", image: post.video.cover || "", isLive: false };
  if (Array.isArray(post.images) && post.images.length > 0) {
    const first = post.images[0];
    const isObject = typeof first === "object" && first !== null;
    return {
      type: "image",
      image: isObject ? first.src || "" : String(first),
      isLive: Boolean(isObject && first.video),
    };
  }
  if (post.linkCard?.image) return { type: "link", image: post.linkCard.image, isLive: false };
  return { type: "text", image: "", isLive: false };
}

function normalizeEmail(email?: string | null) {
  return (email || "").trim().toLowerCase();
}

function paginate(items: NotificationItem[], page: number, limit: number) {
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const total = items.length;
  const start = (page - 1) * limit;
  const end = start + limit;
  return { data: items.slice(start, end), pagination: { page, limit, total, hasMore: end < total } };
}

function notificationBase(post: Post, defaultCover: string) {
  const thumb = getPostThumb(post, defaultCover);
  return {
    postPreview: preview(post.content || "（图片动态）"),
    postType: thumb.type,
    postImage: thumb.image,
    isLive: thumb.isLive,
    postId: post.id,
    shortId: post.shortId,
    isArticle: post.type === "article",
  };
}

/**
 * 登录用户收到自己内容上的互动，以及明确回复给自己的评论。
 * 未登录邮箱兼容入口只允许查询公开帖子的回复，避免通过邮箱探测私密内容。
 */
router.get("/", authenticateOptional, async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.max(1, Math.min(50, Number.parseInt(String(req.query.limit || "10"), 10) || 10));

    if (req.user) {
      const currentUser = await User.findByPk(req.user.id, { attributes: ["nickname", "cover"] });
      const currentNickname = currentUser?.nickname || "";
      const defaultCover = currentUser?.cover || "";
      const ownPosts = await Post.findAll({
        where: { userId: req.user.id },
        attributes: [...POST_ATTRIBUTES],
      });
      const ownPostMap = new Map(ownPosts.map((post) => [post.id, post]));
      const ownPostIds = ownPosts.map((post) => post.id);

      const [likes, ownPostComments, directReplies] = await Promise.all([
        ownPostIds.length
          ? Like.findAll({ where: { postId: { [Op.in]: ownPostIds }, status: "like" }, order: [["createdAt", "DESC"]], limit: 200 })
          : Promise.resolve([]),
        ownPostIds.length
          ? Comment.findAll({ where: { postId: { [Op.in]: ownPostIds } }, order: [["createdAt", "DESC"]], limit: 200 })
          : Promise.resolve([]),
        Comment.findAll({
          where: { replyToUserId: req.user.id },
          order: [["createdAt", "DESC"]],
          limit: 200,
          include: [{ model: Post, as: "post", attributes: [...POST_ATTRIBUTES] }],
        }),
      ]);

      const exposeEmail = req.user.role === "admin";
      const items: NotificationItem[] = [];
      for (const like of likes) {
        const post = ownPostMap.get(like.postId);
        if (!post || like.userId === req.user.id || (!like.userId && like.name === currentNickname)) continue;
        items.push({
          id: `like-${like.id}`,
          type: "like",
          actor: like.name || "访客",
          actorEmail: exposeEmail ? like.email || "" : "",
          content: "",
          ...notificationBase(post, defaultCover),
          createdAt: like.createdAt.toISOString(),
        });
      }

      const seenComments = new Set<string>();
      for (const comment of ownPostComments) {
        const post = comment.postId ? ownPostMap.get(comment.postId) : undefined;
        if (!post || comment.userId === req.user.id || (!comment.userId && comment.authorName === currentNickname)) continue;
        seenComments.add(comment.id);
        items.push({
          id: `comment-${comment.id}`,
          type: comment.replyTo ? "reply" : "comment",
          actor: comment.authorName || "访客",
          actorEmail: exposeEmail ? comment.email || "" : "",
          content: comment.content || "",
          ...notificationBase(post, defaultCover),
          commentId: comment.id,
          replyTo: comment.replyTo || null,
          createdAt: comment.createdAt.toISOString(),
        });
      }

      for (const comment of directReplies) {
        if (seenComments.has(comment.id) || comment.userId === req.user.id) continue;
        const post = comment.post;
        if (!post || !(await canViewPost(post, req.user))) continue;
        items.push({
          id: `reply-${comment.id}`,
          type: "reply",
          actor: comment.authorName || "访客",
          actorEmail: exposeEmail ? comment.email || "" : "",
          content: comment.content || "",
          ...notificationBase(post, defaultCover),
          commentId: comment.id,
          replyTo: comment.replyTo || null,
          createdAt: comment.createdAt.toISOString(),
        });
      }

      res.json(paginate(items, page, limit));
      return;
    }

    const email = normalizeEmail(req.query.email as string);
    if (!email) {
      res.status(401).json({ message: "请先登录" });
      return;
    }

    const comments = await Comment.findAll({
      where: { replyToEmail: email },
      order: [["createdAt", "DESC"]],
      limit: 200,
      include: [{
        model: Post,
        as: "post",
        required: true,
        where: { visibility: "public", status: "published", publishedAt: { [Op.lte]: new Date() } },
        attributes: [...POST_ATTRIBUTES],
      }],
    });
    const adminUser = await User.findOne({ where: { role: "admin" }, attributes: ["cover"] });
    const items = comments
      .filter((comment) => normalizeEmail(comment.email) !== email && comment.post)
      .map((comment): NotificationItem => ({
        id: `reply-${comment.id}`,
        type: "reply",
        actor: comment.authorName || "访客",
        actorEmail: "",
        content: comment.content || "",
        ...notificationBase(comment.post!, adminUser?.cover || ""),
        commentId: comment.id,
        replyTo: comment.replyTo || null,
        createdAt: comment.createdAt.toISOString(),
      }));
    res.json(paginate(items, page, limit));
  } catch (error) {
    console.error("[notifications] error:", error);
    res.status(500).json({ message: "获取通知失败" });
  }
});

export default router;
