import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { saveWorkflowAction } from "../actions";
import { WorkflowEditor } from "../editor";

export const metadata = { title: "New workflow · RedClinic" };

export default async function NewWorkflowPage() {
  await requirePageCap(await requireUser(), "edit_workflow");
  return (
    <>
      <PageHeader title="New workflow" subtitle="It starts switched off. Switch it on from the list when you are ready." back={{ href: "/workflows", label: "Workflows" }} />
      <ActionForm action={saveWorkflowAction} className="card">
        <WorkflowEditor name="" def={{ trigger: { event: "appointment_completed" }, steps: [{ key: "step1", afterMinutes: 1440, action: "call", purpose: "checkin", onlyIf: "always" }] }} />
        <Submit>Create workflow</Submit>
      </ActionForm>
    </>
  );
}
