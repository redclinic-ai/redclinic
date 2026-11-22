import { ActionForm, Submit } from "@/components/action-form";
import { fmtDateTime } from "@/components/ui";
import type { ConfigVersion } from "@/lib/nepa/config";
import { versionAction } from "./actions";

export function VersionBar({ agentId, published, draft, history }: { agentId?: string; published: ConfigVersion<unknown> | null; draft: ConfigVersion<unknown> | null; history: ConfigVersion<unknown>[] }) {
  return (
    <div className="card version-bar">
      <div>
        <strong>{published ? `Live: version ${published.version}` : "Live: RedClinic defaults"}</strong>
        {published && <span className="muted small"> · published {fmtDateTime(published.publishedAt)}</span>}
        {draft && <div className="small"><span className="badge badge-warn">Unpublished changes</span> saved {fmtDateTime(draft.createdAt)}{draft.createdBy ? ` by ${draft.createdBy}` : ""}</div>}
      </div>
      <div className="form-actions">
        {draft && (
          <ActionForm action={versionAction} className="inline-form">
            {agentId && <input type="hidden" name="agentId" value={agentId} />}
            <Submit name="op" value="publish" pending="Publishing…">Publish changes</Submit>
            <Submit variant="ghost" name="op" value="discard" pending="…">Discard</Submit>
          </ActionForm>
        )}
        {history.length > 1 && (
          <details className="menu"><summary className="btn btn-ghost">Version history</summary>
            <div className="menu-body">
              <ActionForm action={versionAction}>
                {agentId && <input type="hidden" name="agentId" value={agentId} />}
                {history.map((h) => (
                  <div key={h.version} className="small hist-row">
                    v{h.version} · {fmtDateTime(h.publishedAt ?? h.createdAt)}{h.changeNote ? ` · ${h.changeNote}` : ""}
                    {h.status === "archived" && <Submit variant="ghost" name="op" value={`rollback:${h.version}`} pending="…">Restore</Submit>}
                    {h.status === "published" && <span className="badge badge-ok">Live</span>}
                  </div>
                ))}
              </ActionForm>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
