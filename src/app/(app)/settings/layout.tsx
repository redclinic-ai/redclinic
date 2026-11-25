import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session-cookie";
import { capabilitiesOf } from "@/lib/nav";
import { SubNav } from "@/components/sub-nav";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const caps = await capabilitiesOf(await requireUser());
  const items: [string, string][] = [];
  if (caps.has("manage_settings")) items.push(["/settings", "Clinic"], ["/settings/services", "Services"], ["/settings/faqs", "Questions & answers"], ["/settings/consent", "Consent wording"], ["/settings/phone", "Phone number"], ["/settings/whatsapp", "WhatsApp"], ["/settings/leads", "Lead ads"], ["/settings/online", "Online consultations"], ["/settings/privacy", "Privacy & data"]);
  if (caps.has("manage_staff")) items.push(["/settings/staff", "Staff"]);
  if (caps.has("manage_billing")) items.push(["/settings/billing", "Plan & usage"]);
  return (
    <>
      <SubNav items={items} />
      {children}
    </>
  );
}
