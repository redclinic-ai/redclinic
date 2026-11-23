// Creates a demo dental clinic with staff, services, FAQs, patients, appointments and test calls.
// For local development, staging and demos only. Refuses to run when APP_ENV=production.
//   DATABASE_URL=<app role> STORAGE_DIR=... STORAGE_SIGNING_SECRET=... npx tsx scripts/seed-demo.mts [patients]
import { signupClinic, login, resolveSession, inviteStaff, setPasswordWithToken } from "../src/lib/auth/service.ts";
import { SimulatedEmailAdapter, setEmailAdapter } from "../src/lib/email/index.ts";
import { updateClinicProfile, saveService, saveFaq } from "../src/lib/clinic/service.ts";
import { registerPatient, recordConsent } from "../src/lib/patients/service.ts";
import { bookAppointment } from "../src/lib/appointments/service.ts";
import { startCall, callerSays, endCall } from "../src/lib/calls/service.ts";
import { closePool } from "../src/lib/db.ts";

if (process.env.APP_ENV === "production") { console.error("Not in production."); process.exit(1); }
const N = Number(process.argv[2] ?? 40);
const PASSWORD = "demo password 2026";
const stamp = Date.now().toString(36);
const outbox = new SimulatedEmailAdapter(); setEmailAdapter(outbox);
const must = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };

const adminEmail = `demo-admin-${stamp}@example.test`;
must(await signupClinic({ clinicName: "Demo Smile Dental", clinicType: "dental", city: "Bengaluru", phone: "080 4000 0000", adminName: "Dr Meera Shah", adminEmail, password: PASSWORD, acceptTerms: true }, null));
const signIn = async (email: string) => { const s = must(await login(email, PASSWORD, { ip: null, userAgent: "seed" })); return (await resolveSession(s.token))!; };
const admin = await signIn(adminEmail);
const hours = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, { open: "09:00", close: "19:00" }]));
must(await updateClinicProfile(admin, { name: "Demo Smile Dental", address: "12 MG Road", city: "Bengaluru", phone: "080 4000 0000", languages: ["en", "hi", "kn"], workingHours: { ...hours, sun: null }, defaultAppointmentMinutes: 30 }));
const svc: Record<string, string> = {};
for (const [name, min] of [["Check-up", 20], ["Cleaning", 30], ["Filling", 45], ["Root canal treatment", 60], ["Extraction", 45], ["Braces adjustment", 30]] as const) svc[name] = must(await saveService(admin, { name, durationMinutes: min }));
for (const [q, a] of [["Do you have parking?", "Yes, free parking behind the building."], ["What are your timings?", "Monday to Saturday, 9 am to 7 pm. Closed on Sunday."], ["Do you treat children?", "Yes, Dr Arun sees children on weekday evenings."]]) must(await saveFaq(admin, { question: q, answer: a }));
async function staff(name: string, role: "doctor" | "receptionist") {
  const email = `demo-${role}-${stamp}-${name.split(" ").pop()!.toLowerCase()}@example.test`;
  must(await inviteStaff(admin, { displayName: name, email, role }));
  const token = outbox.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  must(await setPasswordWithToken(token, PASSWORD));
  return { email, user: await signIn(email) };
}
const d1 = await staff("Dr Arun Kumar", "doctor"), d2 = await staff("Dr Sana Iqbal", "doctor"), rec = await staff("Priya Nair", "receptionist");
const first = ["Rahul", "Anita", "Suresh", "Kavya", "Imran", "Lakshmi", "Vikram", "Fatima", "Arjun", "Meena", "Rohan", "Divya", "Kiran", "Asha", "Naveen"];
const last = ["Verma", "Desai", "Reddy", "Rao", "Khan", "Menon", "Iyer", "Sheikh", "Das", "Pillai", "Shetty", "Nair", "Gowda", "Joshi"];
const ids: string[] = [];
for (let i = 0; i < N; i++) {
  const r = must(await registerPatient(rec.user, { name: `${first[i % first.length]} ${last[(i * 7) % last.length]}`, phone: `98${String(45000000 + i * 137).padStart(8, "0")}`, ageYears: 18 + ((i * 13) % 60) }, { confirmNew: true }));
  if ("patientId" in r) { ids.push(r.patientId); if (i % 3 !== 2) must(await recordConsent(rec.user, r.patientId, { status: "given", method: "in_person" })); }
}
const today = new Date(Date.now() + 5.5 * 3600_000);
const day = (n: number) => new Date(today.getTime() + n * 86_400_000).toISOString().slice(0, 10);
let booked = 0;
for (let i = 0; i < Math.min(ids.length, 30); i++) {
  const r = await bookAppointment(rec.user, { patientId: ids[i], doctorId: (i % 2 ? d1 : d2).user.userId, serviceId: Object.values(svc)[i % 6], date: day(1 + (i % 5)), time: `${String(9 + (i % 9)).padStart(2, "0")}:${i % 2 ? "30" : "00"}` });
  if (r.ok) booked++;
}
for (const lines of [["Do you have parking?", "thanks bye"], ["I want to book an appointment", "yes"], ["My tooth is paining, which tablet should I take?", "no", "bye"]]) {
  const s = await startCall(admin.clinicId!, { direction: "inbound", callerNumber: "9845000137", simulated: true, testCall: true });
  let r = s; for (const l of lines) { if (r.ended) break; r = await callerSays(admin.clinicId!, s.callId, l); }
  if (!r.ended) await endCall(admin.clinicId!, s.callId, "completed");
}
console.log(JSON.stringify({ clinic: "Demo Smile Dental", password: PASSWORD, admin: adminEmail, doctor: d1.email, receptionist: rec.email, patients: ids.length, appointments: booked }, null, 2));
await closePool();
