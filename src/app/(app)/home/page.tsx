import { requireUser } from "@/lib/auth/session-cookie";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Today · RedClinic" };

// Replaced by the full Today screen in Phase 3.
export default async function HomePage({ searchParams }: { searchParams: Promise<{ welcome?: string; denied?: string }> }) {
  const user = await requireUser();
  const { welcome, denied } = await searchParams;
  return (
    <>
      {denied && <div className="alert alert-error" role="alert">You don't have access to that page. Ask your clinic admin if you need it.</div>}
      {welcome === "dental" && <div className="alert alert-success" role="status">Dental workflows are ready. Review and edit them in Workflows.</div>}
      <PageHeader title={`Hello, ${user.displayName}`} />
    </>
  );
}
