// Review link redirect: records that a review request link was opened, then sends the patient to the clinic's
// Google review page. The token is random; nothing about the patient is in the address.
import { NextResponse, type NextRequest } from "next/server";
import { withoutUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const url: string | null = await withoutUser(async (c) => (await c.query("SELECT rc_review_click($1) AS url", [token])).rows[0].url);
  if (!url || !/^https:\/\//.test(url)) return new NextResponse("This link has expired.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return NextResponse.redirect(url, 302);
}
