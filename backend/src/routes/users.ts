import { Router, Request, Response } from "express";
import { User } from "../models";
import { authenticate, requirePublisher, AuthRequest } from "../middleware/auth";

const router = Router();

// GET /api/users/owner - public owner profile for the blog cover
router.get("/owner", async (_req: Request, res: Response) => {
  const owner = await User.findOne({
    where: { role: "admin" },
    order: [["createdAt", "ASC"]],
    attributes: ["id", "email", "username", "nickname", "avatar", "cover", "bio", "website"],
  });

  if (!owner) {
    res.status(404).json({ message: "未找到博主资料" });
    return;
  }

  res.json(owner);
});

// GET /api/users/selectable - active users available for selected visibility.
router.get("/selectable", authenticate, requirePublisher, async (req: AuthRequest, res: Response) => {
  const users = await User.findAll({
    where: { accountStatus: "active" },
    attributes: ["id", "nickname", "username", "avatar"],
    order: [["nickname", "ASC"]],
  });
  res.setHeader("Cache-Control", "no-store");
  res.json(users.filter((user) => user.id !== req.user!.id));
});

export default router;
