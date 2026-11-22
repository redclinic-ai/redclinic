import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { listAgents, AGENT_DEFAULTS } from "@/lib/nepa/config";
import { Badge, PageHeader } from "@/components/ui";

export const metadata = { title: "NEPA agents · RedClinic" };

export default async function AgentsPage() {
  const user = await requireUser();
  const r = await listAgents(user);
  return (
    <>
      <PageHeader title="Agents" subtitle="Each agent has one job. All of them follow RedClinic's rules and your clinic settings." />
      <ul className="list">
        {r.ok && r.value.map((a) => (
          <li key={a.id}>
            <Link href={`/nepa/agents/${a.id}`} className="list-item list-row link-row">
              <div><span className="strong">{a.label}</span><div className="muted small">{AGENT_DEFAULTS[a.kind]?.objective}</div></div>
              <Badge status={a.enabled ? "active" : "deactivated"} label={a.enabled ? "On" : "Off"} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
