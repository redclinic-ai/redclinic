// RedClinic pilot application: validation shared by the Netlify Function and the tests.
// Pure functions, no dependencies. Never throws on user input.

export const ROLES = {
  doctor: 'Doctor',
  owner: 'Clinic owner',
};

export const OUTCOMES = {
  booking: 'Appointment booking',
  reminders: 'Appointment reminders',
  followups: 'Patient follow-ups',
  noshow: 'No-show recovery',
  treatment: 'Treatment follow-ups',
  enquiries: 'Patient enquiry handling',
  leads: 'Lead management',
  tasks: 'Daily task coordination',
  records: 'Patient record organization',
  assistant: 'AI clinic assistant',
};

const ATTR_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'referrer', 'click_id'];

const clean = (v, max) =>
  String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function normalisePhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

/** Returns { application } or { errors, spam }. */
export function validateApplication(input) {
  const b = input && typeof input === 'object' ? input : {};
  const errors = {};

  const role = String(b.role ?? '');
  const name = clean(b.name, 80);
  const phone = normalisePhone(b.phone);
  const clinic = clean(b.clinic, 120);
  let outcomes = b.outcomes;
  if (typeof outcomes === 'string') outcomes = outcomes.split(',');
  outcomes = Array.isArray(outcomes) ? [...new Set(outcomes.map((o) => String(o).trim()))] : [];

  if (!Object.hasOwn(ROLES, role)) errors.role = 'Choose doctor or clinic owner.';
  if (name.length < 2 || !/\p{L}/u.test(name)) errors.name = 'Enter your name.';
  if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Enter a 10-digit mobile number.';
  if (clinic.length < 2) errors.clinic = "Enter your clinic's name.";
  if (!outcomes.length || outcomes.some((o) => !Object.hasOwn(OUTCOMES, o))) errors.outcomes = 'Choose at least one.';

  // Spam: hidden field filled, or sent faster than a person can answer three steps.
  const elapsed = Number(b.elapsed_ms);
  const spam = clean(b.rc_hp, 200) !== '' || (Number.isFinite(elapsed) && elapsed < 2500);
  if (spam) errors.form = 'Request rejected.';

  if (Object.keys(errors).length) return { errors, spam };

  const application = {
    role,
    role_label: ROLES[role],
    name,
    phone: '+91' + phone,
    clinic,
    outcomes: Object.keys(OUTCOMES).filter((k) => outcomes.includes(k)),
  };
  application.outcome_labels = application.outcomes.map((k) => OUTCOMES[k]);
  for (const f of ATTR_FIELDS) application[f] = clean(b[f], f === 'referrer' ? 300 : 120) || null;
  return { application };
}

export function newReference(random = Math.random) {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(random() * alphabet.length)];
  return 'RC-' + s;
}

const csvCell = (v, trusted = false) => {
  const s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  // Neutralise spreadsheet formulas (except validated fields), then quote.
  const safe = !trusted && /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
};

// +919876543210 → +91 98765 43210 (validated digits only, so safe in a spreadsheet)
const prettyPhone = (p) => {
  const d = String(p ?? '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : '';
};

export function toCSV(rows) {
  const cols = ['reference', 'created_at', 'updated_at', 'role_label', 'name', 'phone', 'clinic', 'outcome_labels', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'referrer'];
  const head = ['Reference', 'Applied', 'Updated', 'Role', 'Name', 'Phone', 'Clinic', 'Wants RedClinic to do', 'UTM source', 'UTM medium', 'UTM campaign', 'UTM content', 'Referrer'];
  return [head.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => (c === 'phone' ? csvCell(prettyPhone(r.phone), true) : csvCell(r[c]))).join(','))].join('\r\n') + '\r\n';
}
