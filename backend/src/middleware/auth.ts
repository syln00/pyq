import { Request, Response, NextFunction } from "express";
import { verifyToken, TokenPayload } from "../utils/jwt";
import { User } from "../models";
import { requestToken } from "../utils/session";

export interface AuthRequest extends Request {
  user?: TokenPayload;
  authSource?: "bearer" | "cookie";
  /** WP Ulike cookie 访客 ID（由 visitor-cookie 中间件挂载） */
  visitorId?: string;
}

export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const auth = requestToken(req);
  if (!auth) {
    res.status(401).json({ message: "未提供认证令牌" });
    return;
  }

  try {
    const payload = verifyToken(auth.token);
    // 验证用户是否仍然存在（防止用户被删除后旧 token 仍然有效）
    const user = await User.findByPk(payload.id, {
      attributes: ["id", "email", "role", "accountStatus", "canPublish"],
    });
    if (!user) {
      res.status(401).json({ message: "用户不存在，请重新登录" });
      return;
    }
    if (user.role !== "admin" && user.accountStatus !== "active") {
      res.status(403).json({ message: "账号尚未通过审核或已被停用", code: `ACCOUNT_${user.accountStatus.toUpperCase()}` });
      return;
    }
    // 使用数据库中最新的 role，防止 token 里的 role 过期
    req.user = {
      id: user.id,
      email: user.email || payload.email,
      role: user.role,
      canPublish: user.role === "admin" || user.canPublish,
      accountStatus: user.accountStatus,
    };
    req.authSource = auth.source;
    next();
  } catch {
    res.status(401).json({ message: "无效的认证令牌" });
  }
}

/** 可选认证：有 token 则验证，无 token 则作为匿名用户继续 */
export async function authenticateOptional(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const auth = requestToken(req);
  if (!auth) {
    return next();
  }
  try {
    const payload = verifyToken(auth.token);
    const user = await User.findByPk(payload.id, {
      attributes: ["id", "email", "role", "accountStatus", "canPublish"],
    });
    if (user && (user.role === "admin" || user.accountStatus === "active")) {
      req.user = {
        id: user.id,
        email: user.email || payload.email,
        role: user.role,
        canPublish: user.role === "admin" || user.canPublish,
        accountStatus: user.accountStatus,
      };
      req.authSource = auth.source;
    }
  } catch {
    // 无效 token，作为匿名用户继续
  }
  next();
}

export function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "需要管理员权限" });
    return;
  }
  next();
}

export function requirePublisher(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.user?.role !== "admin" && !req.user?.canPublish) {
    res.status(403).json({ message: "需要发布权限", code: "PUBLISH_PERMISSION_REQUIRED" });
    return;
  }
  next();
}
