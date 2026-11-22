import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { getResults, METRICS, type Period } from "@/lib/results/service";
import { Empty, PageHeader } from "@/components/ui";

export const metadata = { title: "Results · RedClinic" };

export default async function ResultsPage({ searchParams }: { searchParams: Promise<{ p?: string; sim?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "view_results");
  const sp = await searchParams;
  const period = (["today", "7d", "30d"].includes(sp.p ?? "") ? sp.p : "7d") as Period;
  const sim = sp.sim === "1";
  const r = await getResults(user, period, sim);
  if (!r.ok) return <p>{r.error}</p>;
  const res = r.value;
  const groups = [...new Set(METRICS.map((m) => m.group))];
  const show = (k: string) => {
    const v = res.values[k];
    if (v === null || v === undefined) return "—";
    return k === "confirmation_rate_pct" ? `${v}%` : k === "voice_minutes_used" && res.planMinutes ? `${v} of ${res.planMinutes}` : String(v);
  };
  return (
    <>
      <PageHeader title="Results" subtitle="Counted from your real calls and appointments. Tap any number to see how it is counted."
        actions={<a className="btn btn-ghost" href={`/api/results/export?p=${period}`}>Export CSV</a>} />
      <nav className="subnav" aria-label="Period">
        {(["today", "7d", "30d"] as const).map((p) => <Link key={p} href={`/results?p=${p}${sim ? "&sim=1" : ""}`} aria-current={p === period ? "page" : undefined}>{p === "today" ? "Today" : p === "7d" ? "Last 7 days" : "Last 30 days"}</Link>)}
      </nav>
      {sim && <div className="alert alert-sim">Including simulated (test) calls. These are not real results.</div>}
      {!res.hasCalls && <Empty title="Results appear after your first calls.">Appointment counts below are already live.</Empty>}
      {groups.map((g) => (
        <section key={g} className="card" aria-label={g}>
          <h2 className="h2">{g}</h2>
          <div className="metrics">
            {METRICS.filter((m) => m.group === g).map((m) => (
              <details key={m.key} className="metric">
                <summary><span className="metric-value">{show(m.key)}</span><span className="metric-label">{m.label}</span></summary>
                <p className="small muted">{m.how}</p>
              </details>
            ))}
          </div>
        </section>
      ))}
      <p className="small muted"><Link href={`/results?p=${period}${sim ? "" : "&sim=1"}`}>{sim ? "Show real results only" : "Include simulated test calls"}</Link></p>
    </>
  );
}
