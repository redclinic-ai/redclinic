import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { PageHeader } from "@/components/ui";
import { AssistantChat } from "./assistant-chat";

export const metadata = { title: "Assistant · RedClinic" };

export default async function AssistantPage() {
  await requirePageCap(await requireUser(), "view_patients");
  return (
    <>
      <PageHeader title="Assistant" subtitle="Ask about your patients, appointments and calls. Answers come only from your records, with links to each one. It never diagnoses or prescribes." />
      <AssistantChat />
    </>
  );
}
