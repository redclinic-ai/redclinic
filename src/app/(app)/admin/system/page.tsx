import { integrationStatus } from "@/lib/providers";
import { checkHealth } from "@/lib/monitoring/health";
import { Badge, PageHeader } from "@/components/ui";

export const metadata = { title: "System · RedClinic admin" };
const STATE: Record<string, string> = {
  architecture_ready: "Designed", adapter_implemented: "Built, not tested", mock_tested: "Simulated (tested)", provider_selected: "Provider chosen",
  credentials_configured: "Key added, not verified", connection_verified: "Connection verified", e2e_passed: "Tested end to end", production_active: "Live",
};

export default async function SystemPage() {
  const [h, list] = [await checkHealth(), integrationStatus()];
  return (
    <>
      <PageHeader title="System" subtitle={`Version ${h.version}`} actions={<Badge status={h.ok ? "active" : "failed"} label={h.ok ? "Healthy" : "Problem"} />} />
      <section className="card">
        <h2 className="h2">Health</h2>
        <ul className="mini-list">{Object.entries(h.checks).map(([k, v]) => <li key={k}>{k}: <Badge status={v === "ok" ? "active" : "failed"} label={v} /></li>)}</ul>
      </section>
      <section className="card">
        <h2 className="h2">Integrations</h2>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Area</th><th>Using</th><th>State</th><th>Note</th></tr></thead>
          <tbody>{list.map((p) => (
            <tr key={p.kind}><td>{p.kind.replace(/_/g, " ")}</td><td>{p.name}</td><td><Badge status={p.simulated ? "draft" : p.state === "production_active" ? "active" : "pending"} label={STATE[p.state] ?? p.state} /></td><td className="small">{p.note}</td></tr>
          ))}</tbody>
        </table></div>
        <p className="field-hint">Nothing simulated is ever shown to clinics as real. Simulated calls and payments are labelled everywhere.</p>
      </section>
    </>
  );
}
