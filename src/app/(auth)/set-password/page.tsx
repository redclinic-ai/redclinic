import Link from "next/link";
import { checkSetPasswordToken } from "@/lib/auth/service";
import { SetPasswordForm } from "./set-password-form";

export const metadata = { title: "Choose a password · RedClinic" };

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const info = await checkSetPasswordToken(token);
  if (!info) {
    return (
      <>
        <h1>This link doesn't work</h1>
        <p className="muted">It may have expired or already been used.</p>
        <p className="auth-links"><Link href="/forgot-password">Get a new link</Link></p>
      </>
    );
  }
  return (
    <>
      <h1>{info.purpose === "invite" ? `Welcome, ${info.displayName}` : "Choose a new password"}</h1>
      <p className="muted">For {info.email}</p>
      <SetPasswordForm token={token} />
    </>
  );
}
