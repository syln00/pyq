import { clearSessionUser, getSessionUser } from "./auth";

export const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

function getBackendOrigin() {
  return (process.env.BACKEND_URL || "http://localhost:4000").replace(/\/+$/, "");
}

export function getApiUrl() {
  if (typeof window === "undefined" && PUBLIC_API_URL.startsWith("/")) {
    return `${getBackendOrigin()}${PUBLIC_API_URL}`;
  }
  return PUBLIC_API_URL;
}

/** @deprecated Authentication is held in an HttpOnly cookie. */
export function getToken(): string | null {
  return getSessionUser() ? "cookie-session" : null;
}

export function clearAuth() {
  clearSessionUser();
}

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(`${getApiUrl()}${path}`, {
    ...options,
    credentials: "include",
    cache: options?.cache ?? "no-store",
    headers: { ...(options?.headers || {}) },
  });
  if (res.status === 401) {
    clearSessionUser();
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/admin") && window.location.pathname !== "/admin/login") {
      window.location.href = "/admin/login";
    }
  }
  return res;
}
