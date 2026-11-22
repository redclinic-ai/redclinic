import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session-cookie";
import { capabilitiesOf, navFor } from "@/lib/nav";
import { BottomNav, SideNav } from "@/components/nav-links";
import { logoutAction } from "../(auth)/actions";

const ROLE: Record<string, string> = {
  super_admin: "RedClinic admin", clinic_admin: "Clinic admin", doctor: "Doctor", receptionist: "Receptionist", clinic_manager: "Clinic manager",
};

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const items = navFor(user, await capabilitiesOf(user));
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="auth-brand"><span className="logo-mark" aria-hidden>R</span> RedClinic</div>
        <SideNav items={items} />
        <div className="who">
          <strong>{user.displayName}</strong>
          <span className="muted">{ROLE[user.role]}{user.clinicName ? ` · ${user.clinicName}` : ""}</span>
          <form action={logoutAction}><button className="btn btn-ghost btn-sm" type="submit">Sign out</button></form>
        </div>
      </aside>
      <header className="mobile-top">
        <div className="auth-brand"><span className="logo-mark" aria-hidden>R</span> {user.clinicName ?? "RedClinic"}</div>
        <form action={logoutAction}><button className="btn btn-ghost btn-sm" type="submit">Sign out</button></form>
      </header>
      <main id="main" className="content">
        {user.clinicStatus === "suspended" && (
          <div className="alert alert-error" role="alert">This clinic's RedClinic account is paused. Please contact RedClinic on 9954674179.</div>
        )}
        {children}
      </main>
      <BottomNav items={items} />
    </div>
  );
}
