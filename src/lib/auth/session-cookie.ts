import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { isProduction } from "../env";
import { resolveSession, type SignedInUser } from "./service";

export const SESSION_COOKIE = "rc_session";

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** The signed-in user for this request, or null. Cached per request. */
export const currentUser = cache(async (): Promise<SignedInUser | null> => resolveSession(await sessionToken()));

export async function requireUser(): Promise<SignedInUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  // Behind the hosting platform's proxy, the first x-forwarded-for entry is the client.
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return { ip, userAgent: h.get("user-agent") };
}
