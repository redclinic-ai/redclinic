// Helpers for server actions: get the signed-in user, read form fields, map Results to form state.
import "server-only";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "./auth/session-cookie";
import type { Result } from "./auth/service";
import type { ActionState } from "@/components/action-form";

export { requireUser };
export const field = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
export const checked = (f: FormData, k: string) => f.get(k) === "on";

/** On failure: return the error to the form. On success: revalidate and either redirect or return a message. */
export function finish<T>(r: Result<T>, success: { redirect?: string | ((v: T) => string); message?: string; revalidate?: string[] }): ActionState {
  if (!r.ok) return { error: r.error, field: r.field };
  for (const p of success.revalidate ?? []) revalidatePath(p);
  if (success.redirect) redirect(typeof success.redirect === "function" ? success.redirect(r.value) : success.redirect);
  return { message: success.message ?? "Saved.", ok: Date.now() };
}

/** Only same-site paths: "/inbox?x=1" yes; "https://…", "//evil" or "javascript:" no. */
export function safePath(p: string, fallback = "/home"): string {
  return /^\/(?![\/\\])[\w\-./?=&%#:]*$/.test(p) ? p : fallback;
}
