export interface SessionUser {
  id: string;
  nickname: string;
  email: string;
  username?: string;
  avatar?: string;
  cover?: string;
  bio?: string;
  website?: string;
  role: "admin" | "visitor";
  accountStatus: "pending" | "active" | "suspended" | "rejected";
  canPublish: boolean;
}

export interface CurrentUser {
  isLoggedIn: boolean;
  nickname: string;
  email: string;
  website: string;
  id?: string;
  role?: SessionUser["role"];
  canPublish?: boolean;
}

export function authErrorMessage(data: { code?: string; message?: string } | null | undefined, fallback = "操作失败") {
  switch (data?.code) {
    case "ACCOUNT_PENDING":
      return "账号已提交，正在等待管理员审核。审核通过后才能登录。";
    case "ACCOUNT_REJECTED":
      return "注册申请未通过审核，如有疑问请联系管理员。";
    case "ACCOUNT_SUSPENDED":
      return "账号已被停用，如有疑问请联系管理员。";
    case "REGISTER_DISABLED":
      return "管理员暂未开放新用户注册。";
    default:
      return data?.message || fallback;
  }
}

let sessionUser: SessionUser | null = null;
let refreshPromise: Promise<SessionUser | null> | null = null;

function emitAuthChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pyq-auth-changed", { detail: sessionUser }));
}

export function getSessionUser() {
  return sessionUser;
}

export function setSessionUser(user: SessionUser | null) {
  sessionUser = user;
  emitAuthChanged();
  return sessionUser;
}

export function clearSessionUser() {
  setSessionUser(null);
}

export async function refreshSessionUser(): Promise<SessionUser | null> {
  if (typeof window === "undefined") return null;
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch(`${process.env.NEXT_PUBLIC_API_URL || "/api"}/auth/me`, {
    credentials: "include",
    cache: "no-store",
  })
    .then(async (response) => {
      if (!response.ok) return setSessionUser(null);
      const data = await response.json();
      return setSessionUser(data.user || null);
    })
    .catch(() => setSessionUser(null))
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

export async function logoutSession() {
  if (typeof window !== "undefined") {
    await fetch(`${process.env.NEXT_PUBLIC_API_URL || "/api"}/auth/logout`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
  }
  clearSessionUser();
}

export function getCurrentUser(): CurrentUser | null {
  if (sessionUser) {
    return {
      isLoggedIn: true,
      id: sessionUser.id,
      nickname: sessionUser.nickname,
      email: sessionUser.email,
      website: sessionUser.website || "",
      role: sessionUser.role,
      canPublish: sessionUser.canPublish,
    };
  }
  if (typeof window === "undefined") return null;
  const nickname = localStorage.getItem("visitor_name");
  const email = localStorage.getItem("visitor_email");
  if (!nickname || !email) return null;
  return {
    isLoggedIn: false,
    nickname,
    email,
    website: localStorage.getItem("visitor_website") || "",
  };
}

/** Cookie credentials are sent automatically; retained for call-site compatibility. */
export function authFetchHeaders(): Record<string, string> {
  return {};
}
