// Clinic profile and settings: services, FAQs, consent wording.
import { z } from "zod";
import type { SignedInUser } from "../auth/service";
import { act, audit, firstIssue, requireCap, UserError } from "../authz";

export const LANGUAGES: Record<string, string> = { en: "English", hi: "Hindi", kn: "Kannada" };
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WorkingHours = Partial<Record<(typeof DAYS)[number], { open: string; close: string } | null>>;

export const DEFAULT_CONSENT: Record<"en" | "hi", string> = {
  en: "I agree that this clinic may keep my health records, documents and call recordings, and may call or message me about my appointments and treatment. These calls may be answered or made by the clinic's AI receptionist. I can withdraw this consent at any time by telling the clinic.",
  hi: "मैं सहमत हूँ कि यह क्लिनिक मेरे स्वास्थ्य रिकॉर्ड, दस्तावेज़ और कॉल रिकॉर्डिंग रख सकता है, और मेरी अपॉइंटमेंट और इलाज के बारे में मुझे कॉल या संदेश कर सकता है। ये कॉल क्लिनिक के AI रिसेप्शनिस्ट द्वारा की या ली जा सकती हैं। मैं क्लिनिक को बताकर किसी भी समय यह सहमति वापस ले सकता/सकती हूँ।",
};

export interface Clinic {
  id: string; name: string; clinicType: string; status: string; address: string | null; city: string | null;
  phone: string | null; email: string | null; timezone: string; languages: string[]; workingHours: WorkingHours;
  settings: { defaultAppointmentMinutes?: number };
}

export async function getClinic(actor: SignedInUser) {
  return act(actor, async (c) => {
    const r = await c.query("SELECT * FROM clinics WHERE id = $1", [actor.clinicId]);
    const x = r.rows[0];
    if (!x) throw new UserError("Clinic not found.");
    return {
      id: x.id, name: x.name, clinicType: x.clinic_type, status: x.status, address: x.address, city: x.city,
      phone: x.phone, email: x.email, timezone: x.timezone, languages: x.languages, workingHours: x.working_hours ?? {},
      settings: x.settings ?? {},
    } as Clinic;
  });
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:30.");
const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter the clinic name.").max(120),
  address: z.string().trim().max(300).default(""),
  city: z.string().trim().max(80).default(""),
  phone: z.string().trim().regex(/^[0-9+\-\s]{7,20}$/, "Enter a valid phone number."),
  email: z.union([z.literal(""), z.string().trim().email("Enter a valid email.")]).default(""),
  timezone: z.string().default("Asia/Kolkata"),
  languages: z.array(z.enum(["en", "hi", "kn"])).min(1, "Choose at least one language."),
  workingHours: z.partialRecord(z.enum(DAYS), z.object({ open: time, close: time }).nullable()),
  defaultAppointmentMinutes: z.coerce.number().int().min(5).max(240).default(30),
});

export async function updateClinicProfile(actor: SignedInUser, input: z.input<typeof profileSchema>) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings", "Only the clinic admin can change the clinic profile.");
    const p = profileSchema.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const d = p.data;
    for (const [day, h] of Object.entries(d.workingHours)) {
      if (h && h.close <= h.open) throw new UserError(`Closing time must be after opening time (${day}).`, "workingHours");
    }
    await c.query("SELECT rc_update_clinic_profile($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
      d.name, d.address || null, d.city || null, d.phone, d.email || null, d.timezone, d.languages, d.workingHours,
      { defaultAppointmentMinutes: d.defaultAppointmentMinutes },
    ]);
    return null;
  });
}

// ---------- services ----------
export interface Service { id: string; name: string; durationMinutes: number; description: string | null; enabled: boolean }

export async function listServices(actor: SignedInUser, onlyEnabled = false) {
  return act(actor, async (c) => {
    const r = await c.query(`SELECT * FROM clinic_services ${onlyEnabled ? "WHERE enabled" : ""} ORDER BY name`);
    return r.rows.map((x) => ({ id: x.id, name: x.name, durationMinutes: x.duration_minutes, description: x.description, enabled: x.enabled })) as Service[];
  });
}

const serviceSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2, "Enter a service name.").max(80),
  durationMinutes: z.coerce.number().int().min(5, "At least 5 minutes.").max(480),
  description: z.string().trim().max(500).default(""),
  enabled: z.boolean().default(true),
});

export async function saveService(actor: SignedInUser, input: z.input<typeof serviceSchema>) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const p = serviceSchema.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const d = p.data;
    try {
      const r = d.id
        ? await c.query("UPDATE clinic_services SET name=$2, duration_minutes=$3, description=$4, enabled=$5 WHERE id=$1 RETURNING id", [d.id, d.name, d.durationMinutes, d.description || null, d.enabled])
        : await c.query("INSERT INTO clinic_services (clinic_id, name, duration_minutes, description, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING id", [actor.clinicId, d.name, d.durationMinutes, d.description || null, d.enabled]);
      if (!r.rowCount) throw new UserError("Service not found.");
      await audit(c, actor, d.id ? "service_updated" : "service_added", "clinic_service", r.rows[0].id, { name: d.name });
      return r.rows[0].id as string;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new UserError("A service with this name already exists.", "name");
      throw e;
    }
  });
}

// ---------- FAQs ----------
export interface Faq { id: string; question: string; answer: string; language: string; enabled: boolean }

export async function listFaqs(actor: SignedInUser) {
  return act(actor, async (c) => {
    const r = await c.query("SELECT * FROM clinic_faqs ORDER BY language, question");
    return r.rows.map((x) => ({ id: x.id, question: x.question, answer: x.answer, language: x.language, enabled: x.enabled })) as Faq[];
  });
}

const faqSchema = z.object({
  id: z.string().uuid().optional(),
  question: z.string().trim().min(3, "Write the question.").max(300),
  answer: z.string().trim().min(1, "Write the answer.").max(2000),
  language: z.enum(["en", "hi", "kn"]).default("en"),
  enabled: z.boolean().default(true),
});

export async function saveFaq(actor: SignedInUser, input: z.input<typeof faqSchema>) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const p = faqSchema.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const d = p.data;
    const r = d.id
      ? await c.query("UPDATE clinic_faqs SET question=$2, answer=$3, language=$4, enabled=$5, updated_by=$6, updated_at=now() WHERE id=$1 RETURNING id", [d.id, d.question, d.answer, d.language, d.enabled, actor.userId])
      : await c.query("INSERT INTO clinic_faqs (clinic_id, question, answer, language, enabled, updated_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [actor.clinicId, d.question, d.answer, d.language, d.enabled, actor.userId]);
    if (!r.rowCount) throw new UserError("FAQ not found.");
    await audit(c, actor, d.id ? "faq_updated" : "faq_added", "clinic_faq", r.rows[0].id);
    return r.rows[0].id as string;
  });
}

export async function deleteFaq(actor: SignedInUser, id: string) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const r = await c.query("DELETE FROM clinic_faqs WHERE id = $1", [id]);
    if (!r.rowCount) throw new UserError("FAQ not found.");
    await audit(c, actor, "faq_deleted", "clinic_faq", id);
    return null;
  });
}

// ---------- consent wording ----------
export interface ConsentWording { language: "en" | "hi"; version: string; wording: string; isDefault: boolean }

/** Current wording per language: the clinic's latest saved version, or the RedClinic default (version "default-1"). */
export async function currentConsentWordings(actor: SignedInUser) {
  return act(actor, async (c) => {
    const r = await c.query(
      "SELECT DISTINCT ON (language) language, version, wording FROM consent_wordings ORDER BY language, version DESC",
    );
    const saved = new Map(r.rows.map((x) => [x.language, x]));
    return (["en", "hi"] as const).map((lang): ConsentWording => {
      const s = saved.get(lang);
      return s ? { language: lang, version: `clinic-v${s.version}`, wording: s.wording, isDefault: false }
               : { language: lang, version: "default-1", wording: DEFAULT_CONSENT[lang], isDefault: true };
    });
  });
}

export async function saveConsentWording(actor: SignedInUser, language: "en" | "hi", wording: string) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const w = wording.trim();
    if (w.length < 20) throw new UserError("The consent wording is too short.", "wording");
    if (!["en", "hi"].includes(language)) throw new UserError("Choose English or Hindi.");
    const v = (await c.query("SELECT coalesce(max(version),0)+1 AS v FROM consent_wordings WHERE language=$1", [language])).rows[0].v;
    await c.query("INSERT INTO consent_wordings (clinic_id, language, version, wording, created_by) VALUES ($1,$2,$3,$4,$5)", [actor.clinicId, language, v, w, actor.userId]);
    await audit(c, actor, "consent_wording_saved", "consent_wording", `${language}-v${v}`);
    return `clinic-v${v}`;
  });
}
