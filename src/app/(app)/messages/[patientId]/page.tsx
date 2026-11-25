import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { conversation } from "@/lib/whatsapp/service";
import { TEMPLATES } from "@/lib/whatsapp/templates";
import { Flash, fmtDateTime, PageHeader, Simulated } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { TextArea } from "@/components/form";
import { handledAction, replyAction } from "../actions";

export const metadata = { title: "Conversation · RedClinic" };
const STATUS: Record<string, string> = {
  awaiting_approval: "Waiting for approval", queued: "Will send soon", sent: "Sent", delivered: "Delivered", read: "Read",
  failed: "Not sent", skipped: "Not sent", cancelled: "Cancelled", received: "",
};

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ patientId: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "view_patients");
  const { patientId } = await params;
  const { ok } = await searchParams;
  const r = await conversation(user, patientId);
  if (!r.ok) notFound();
  const { patient: p, messages, windowOpen } = r.value;
  const unhandled = messages.some((m) => m.direction === "in" && !m.handledAt);
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={p.name} back={{ href: "/messages", label: "Messages" }}
        subtitle={<><Link href={`/patients/${p.id}`}>{p.code}</Link> · {p.phone ?? "no number"} · WhatsApp: {p.whatsapp === "opted_in" ? "agreed" : p.whatsapp === "opted_out" ? "does not want messages" : "not asked yet"}</>} />
      <ol className="chat" aria-label="Messages">
        {messages.length === 0 && <li className="muted">No messages yet.</li>}
        {messages.map((m) => (
          <li key={m.id} className={`bubble ${m.direction === "in" ? "caller" : "nepa"}`}>
            <span className="sr-only">{m.direction === "in" ? p.name : "Clinic"}: </span>
            {m.body || <em className="muted">{m.error}</em>}
            <span className="muted small bubble-meta">
              {fmtDateTime(m.sentAt ?? m.at)}{m.direction === "out" ? ` · ${m.sender ?? (m.template ? `NEPA: ${TEMPLATES[m.template]?.label.toLowerCase() ?? m.template}` : "NEPA")}` : ""}
              {STATUS[m.status] ? ` · ${STATUS[m.status]}` : ""}{m.error && m.body ? ` · ${m.error}` : ""} {m.simulated && <Simulated />}
            </span>
          </li>
        ))}
      </ol>
      {caps.has("manage_attention") && (
        <section className="card">
          {windowOpen && p.whatsapp !== "opted_out" ? (
            <ActionForm action={replyAction}>
              <input type="hidden" name="patientId" value={p.id} />
              <TextArea label="Reply" name="text" rows={3} maxLength={1000} hint="Free replies are allowed for 24 hours after the patient's last message. Never give medical advice here; ask the patient to come in or call." />
              <Submit>Send reply</Submit>
            </ActionForm>
          ) : <p className="muted">{p.whatsapp === "opted_out" ? "This patient asked not to get WhatsApp messages." : "WhatsApp only allows a free reply within 24 hours of the patient's last message. Call the patient instead."}</p>}
          {unhandled && (
            <ActionForm action={handledAction}><input type="hidden" name="patientId" value={p.id} /><Submit variant="ghost">Mark as handled</Submit></ActionForm>
          )}
        </section>
      )}
    </>
  );
}
