import { requireUser } from "@/lib/auth/session-cookie";
import { logoutAction } from "../(auth)/actions";

export const metadata = { title: "Today · RedClinic" };

const ROLE_LABEL: Record<string, string> = {
  super_admin: "RedClinic admin",
  clinic_admin: "Clinic admin",
  doctor: "Doctor",
  receptionist: "Receptionist",
  clinic_manager: "Clinic manager",
};

// Placeholder home until the Today screen is built (Phase 3).
export default async function HomePage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const user = await requireUser();
  const { welcome } = await searchParams;
  const suspended = user.clinicStatus === "suspended";
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="auth-brand"><span className="logo-mark" aria-hidden>R</span> RedClinic</div>
        <form action={logoutAction}><button className="btn btn-ghost" type="submit">Sign out</button></form>
      </header>
      <main className="page">
        {suspended && (
          <div className="alert alert-error" role="alert">This clinic's RedClinic account is paused. Please contact RedClinic on 9954674179.</div>
        )}
        {welcome === "dental" && (
          <div className="alert alert-success" role="status">Dental workflows are ready. Review and edit them in Workflows.</div>
        )}
        <h1>Hello, {user.displayName}</h1>
        <p className="muted">{ROLE_LABEL[user.role]}{user.clinicName ? ` · ${user.clinicName}` : ""}</p>
        <div className="card">
          <p>Your Today screen will appear here.</p>
        </div>
      </main>
    </div>
  );
}
