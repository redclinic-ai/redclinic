import Link from "next/link";
import { PageHeader } from "@/components/ui";

// Replaced by the full clinic list in Phase 7.
export default function AdminHome() {
  return (
    <>
      <PageHeader title="RedClinic admin" />
      <p><Link href="/admin/policies">Global policies</Link></p>
    </>
  );
}
