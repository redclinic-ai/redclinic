import { requirePageCap } from "@/lib/nav";
import { requireUser } from "@/lib/auth/session-cookie";
import { listFaqs, LANGUAGES } from "@/lib/clinic/service";
import { Empty, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select, TextArea } from "@/components/form";
import { saveFaqAction } from "../actions";

export const metadata = { title: "Questions & answers · RedClinic" };
const LANG_OPTS = Object.entries(LANGUAGES) as [string, string][];

export default async function FaqPage() {
  const user = await requireUser();
  await requirePageCap(user, "manage_settings");
  const r = await listFaqs(user);
  const faqs = r.ok ? r.value : [];
  return (
    <>
      <PageHeader title="Questions & answers" subtitle="Your AI receptionist only answers clinic questions from this list. Anything else goes to your staff." />
      <ActionForm action={saveFaqAction} className="card" resetOnSuccess>
        <h2 className="h2">Add a question</h2>
        <Input label="Question" name="question" placeholder="Do you have parking?" />
        <TextArea label="Answer" name="answer" rows={2} />
        <Select label="Language" name="language" options={LANG_OPTS} defaultValue="en" required />
        <Submit pending="Adding…">Add question</Submit>
      </ActionForm>
      {faqs.length === 0 ? <Empty title="No questions yet">Add common questions: timings, parking, location, which doctor is in on which day.</Empty> : (
        <ul className="list">
          {faqs.map((q) => (
            <li key={q.id} className="list-item">
              <ActionForm action={saveFaqAction}>
                <input type="hidden" name="id" value={q.id} />
                <Input label="Question" name="question" defaultValue={q.question} />
                <TextArea label="Answer" name="answer" defaultValue={q.answer} rows={2} />
                <div className="form-inline">
                  <Select label="Language" name="language" options={LANG_OPTS} defaultValue={q.language} required />
                  <label className="check"><input type="checkbox" name="enabled" defaultChecked={q.enabled} /> <span>In use</span></label>
                  <Submit variant="ghost">Save</Submit>
                  <Submit variant="danger" name="delete" value="1" pending="Removing…">Remove</Submit>
                </div>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
