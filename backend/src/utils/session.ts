import type { CookieOptions, Request } from "express";

export const SESSION_COOKIE_NAME = "pyq_session";

function durationMs(value: string): number {
  const match = value.trim().match(/^(\d+)\s*([smhd])?$/i);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const factor = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  return n * factor;
}

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: durationMs(process.env.JWT_EXPIRES_IN || "7d"),
  };
}

export function requestToken(req: Request): { token: string; source: "bearer" | "cookie" } | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return { token: authHeader.slice(7), source: "bearer" };
  }
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  return typeof token === "string" && token ? { token, source: "cookie" } : null;
}

export function allowedOrigins(): Set<string> {
  const raw = process.env.CORS_ALLOWED_ORIGINS || process.env.CLIENT_URL || "http://localhost:3000";
  return new Set(raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean));
}
