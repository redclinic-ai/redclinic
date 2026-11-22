import Link from "next/link";
import { SignupForm } from "./signup-form";
import { TERMS_WORDING } from "@/lib/terms";

export const metadata = { title: "Create your clinic account · RedClinic" };

export default function SignupPage() {
  return (
    <>
      <h1>Create your clinic account</h1>
      <p className="muted">Takes about a minute. You can add your staff afterwards.</p>
      <SignupForm termsWording={TERMS_WORDING} />
      <p className="auth-links"><span>Already have an account? <Link href="/login">Sign in</Link></span></p>
    </>
  );
}
