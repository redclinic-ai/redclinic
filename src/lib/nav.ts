// Navigation items per role/capability. The server decides what each person sees.
import type { SignedInUser } from "./auth/service";
import { withContext } from "./db";
import { contextOf } from "./auth/service";

export interface NavItem { href: string; label: string; icon: string; primary?: boolean }

export async function capabilitiesOf(user: SignedInUser): Promise<Set<string>> {
  if (!user.clinicId) return new Set();
  return withContext(contextOf(user), async (c) => {
    const r = await c.query(
      "SELECT code FROM capabilities WHERE rc_has_capability(code)",
    );
    return new Set(r.rows.map((x) => x.code as string));
  });
}

export function navFor(user: SignedInUser, caps: Set<string>): NavItem[] {
  if (user.isSuperAdmin) {
    return [
      { href: "/admin", label: "Clinics", icon: "building", primary: true },
      { href: "/admin/usage", label: "Usage", icon: "chart", primary: true },
      { href: "/admin/policies", label: "Policies", icon: "shield", primary: true },
      { href: "/admin/plans", label: "Plans", icon: "card", primary: true },
    ];
  }
  const items: NavItem[] = [{ href: "/home", label: "Today", icon: "sun", primary: true }];
  if (caps.has("manage_appointments") || caps.has("view_patients")) items.push({ href: "/appointments", label: "Appointments", icon: "calendar", primary: true });
  if (caps.has("view_patients")) items.push({ href: "/patients", label: "Patients", icon: "users", primary: true });
  if (caps.has("manage_attention") || caps.has("view_approvals")) items.push({ href: "/inbox", label: "Needs attention", icon: "inbox", primary: true });
  if (caps.has("view_calls")) items.push({ href: "/calls", label: "Calls", icon: "phone" });
  if (caps.has("view_patient_history")) items.push({ href: "/assistant", label: "Assistant", icon: "spark" });
  if (caps.has("edit_workflow") || caps.has("manage_settings")) items.push({ href: "/workflows", label: "Workflows", icon: "flow" });
  if (caps.has("view_results")) items.push({ href: "/results", label: "Results", icon: "chart" });
  if (caps.has("manage_settings") || caps.has("manage_staff") || caps.has("manage_billing")) items.push({ href: "/settings", label: "Settings", icon: "gear" });
  return items;
}

/** For pages: send people without the capability back to Today. The server actions check again. */
export async function requirePageCap(user: SignedInUser, ...anyOf: string[]): Promise<Set<string>> {
  const caps = await capabilitiesOf(user);
  if (!user.isSuperAdmin && !anyOf.some((c) => caps.has(c))) {
    const { redirect } = await import("next/navigation");
    redirect("/home?denied=1");
  }
  return caps;
}
