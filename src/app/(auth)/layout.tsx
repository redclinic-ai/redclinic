import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="auth-brand" aria-label="RedClinic">
        <span className="logo-mark" aria-hidden>R</span> RedClinic
      </div>
      <div className="card auth-card">{children}</div>
      <p className="auth-foot">Help: hello@redclinic.ai · 9954674179</p>
    </main>
  );
}
