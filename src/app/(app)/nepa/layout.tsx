import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { SubNav } from "@/components/sub-nav";

export default async function NepaLayout({ children }: { children: ReactNode }) {
  await requirePageCap(await requireUser(), "edit_workflow");
  return (
    <>
      <SubNav items={[["/nepa", "Clinic settings"], ["/nepa/agents", "Agents"], ["/nepa/test", "Test"]]} />
      {children}
    </>
  );
}
