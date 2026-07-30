import "server-only";
import { cookies } from "next/headers";
import { getApiUrl } from "./api-fetch";

export async function serverApiFetch(path: string, options: RequestInit = {}) {
  const cookieHeader = (await cookies()).toString();
  return fetch(`${getApiUrl()}${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      ...(options.headers || {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });
}
