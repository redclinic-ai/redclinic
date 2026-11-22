import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session-cookie";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · RedClinic" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  if (await currentUser()) redirect("/home");
  const { password } = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      {password === "set" && <div className="alert alert-success" role="status">Your password is set. Sign in with it now.</div>}
      <LoginForm />
      <p className="auth-links">
        <Link href="/forgot-password">Forgot password?</Link>
        <span>New clinic? <Link href="/signup">Create an account</Link></span>
      </p>
    </>
  );
}
