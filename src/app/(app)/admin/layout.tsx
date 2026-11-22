import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  if (!user.isSuperAdmin) redirect("/home?denied=1");
  return <>{children}</>;
}
