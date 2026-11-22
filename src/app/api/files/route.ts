// Serves a privately stored file for a valid, unexpired signed link (local storage only).
// The permission check and audit entry happen when the link is created (openDocument).
import { NextResponse, type NextRequest } from "next/server";
import { getStorage, verifyLocal, LocalStorageAdapter } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const key = p.get("key") ?? "", name = p.get("name") ?? "", type = p.get("type") ?? "", sig = p.get("sig") ?? "";
  const exp = Number(p.get("exp"));
  const storage = getStorage();
  if (!(storage instanceof LocalStorageAdapter) || !verifyLocal(key, exp, name, type, sig)) {
    return new NextResponse("This link has expired. Open the document again from RedClinic.", { status: 403 });
  }
  const bytes = await storage.get(key).catch(() => null);
  if (!bytes) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
