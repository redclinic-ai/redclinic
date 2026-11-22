import Link from "next/link";
import { ForgotForm } from "./forgot-form";

export const metadata = { title: "Reset password · RedClinic" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1>Reset your password</h1>
      <p className="muted">Enter your email. We'll send you a link to choose a new password.</p>
      <ForgotForm />
      <p className="auth-links"><Link href="/login">Back to sign in</Link></p>
    </>
  );
}
