import { requirePageCap } from "@/lib/nav";
import { requireUser } from "@/lib/auth/session-cookie";
import { PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { importAction } from "../actions";

export const metadata = { title: "Import patients · RedClinic" };

export default async function ImportPage() {
  await requirePageCap(await requireUser(), "import_patients");
  return (
    <>
      <PageHeader title="Import patients" subtitle="Bring your existing patient list from Excel or another system." back={{ href: "/patients", label: "Patients" }} />
      <div className="card">
        <ol className="steps">
          <li>In Excel, save your list as <strong>CSV</strong>.</li>
          <li>The first row must have column names. Use <strong>name</strong> (required), and any of <strong>phone</strong>, <strong>email</strong>, <strong>date of birth</strong>, <strong>age</strong>, <strong>gender</strong>, <strong>address</strong>.</li>
          <li>Dates can be 25/12/1985 or 1985-12-25.</li>
        </ol>
        <p className="muted small">Rows that look like patients you already have are skipped and listed, never merged automatically. Up to 2,000 rows at a time.</p>
        <ActionForm action={importAction}>
          <div className="field">
            <label htmlFor="file">CSV file</label>
            <input id="file" name="file" type="file" accept=".csv,text/csv" />
          </div>
          <Submit pending="Importing…">Import</Submit>
        </ActionForm>
      </div>
    </>
  );
}
