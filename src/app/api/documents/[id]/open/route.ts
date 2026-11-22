// Opens a document: checks the signed-in user's permission, logs the access, then redirects to a short-lived link.
import { NextResponse, type NextRequest } from "next/server";
import { currentUser } from "@/lib/auth/session-cookie";
import { openDocument } from "@/lib/documents/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in first.", { status: 401 });
  const r = await openDocument(user, (await params).id);
  if (!r.ok) return new NextResponse(r.error, { status: 404 });
  return NextResponse.redirect(r.value.url, { status: 303, headers: { "Cache-Control": "no-store" } });
}
