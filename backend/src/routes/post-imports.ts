import { Router, Response } from "express";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";
import { getClientIp } from "../utils/ip";
import { triggerRevalidate } from "../utils/revalidate";
import {
  importPostRows,
  publicValidationRows,
  validateImportRows,
} from "../services/post-import-service";

const router = Router();

router.post("/validate", authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const rows = await validateImportRows(req.body?.rows, req.user!);
    const publicRows = publicValidationRows(rows);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      total: publicRows.length,
      valid: publicRows.filter((row) => row.valid).length,
      invalid: publicRows.filter((row) => !row.valid).length,
      rows: publicRows,
    });
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "导入校验失败" });
  }
});

router.post("/", authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const result = await importPostRows(req.body?.rows, req.user!, getClientIp(req));
    if (result.created > 0) void triggerRevalidate();
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "批量导入失败" });
  }
});

export default router;
