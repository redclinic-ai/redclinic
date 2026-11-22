import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session-cookie";

export default async function Root() {
  redirect((await currentUser()) ? "/home" : "/login");
}
