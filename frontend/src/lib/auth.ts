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
