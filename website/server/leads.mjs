// Demo request validation and handling. Pure functions plus one handler factory, so the same logic
// can run in the bundled Node server or be wrapped as a serverless function later.

import { randomBytes } from 'node:crypto';

export const SIZES = ['1', '2-3', '4+', 'multi'];
export const SPECIALITIES = ['dental', 'skin', 'physio', 'ent', 'eye', 'gynae', 'paediatrics', 'general', 'diagnostics', 'other'];
export const PLANS = ['', 'pilot', 'clinic', 'multi'];
export const CALL_TIMES = ['', 'morning', 'afternoon', 'evening'];
const ATTR_FIELDS = ['landing_page', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'click_id'];
const DEVICES = ['mobile', 'tablet', 'desktop', ''];

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function normalisePhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

/** Returns { lead } or { errors, spam }. Never throws on user input. */
export function validateLead(input) {
  const b = input && typeof input === 'object' ? input : {};
  const errors = {};
  const name = clean(b.name, 80);
  const phone = normalisePhone(b.phone);
  const clinic = clean(b.clinic, 120);
  const city = clean(b.city, 60);
  const size = String(b.size ?? '');
  const call_time = String(b.call_time ?? '');
  const speciality = String(b.speciality ?? '');
  const plan = String(b.plan ?? '');

  if (name.length < 2 || !/\p{L}/u.test(name)) errors.name = 'Enter your name.';
  if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Enter a 10-digit Indian mobile number.';
  if (clinic.length < 2) errors.clinic = "Enter your clinic's name.";
  if (city.length < 2) errors.city = 'Enter the city your clinic is in.';
  if (size && !SIZES.includes(size)) errors.size = 'Choose how many doctors work at your clinic.';
  if (speciality && !SPECIALITIES.includes(speciality)) errors.speciality = 'Choose the type of clinic.';
  if (!CALL_TIMES.includes(call_time)) errors.call_time = 'Choose a time to call.';

  // Spam signals: the hidden field is filled, or the form was sent faster than a person can type.
  const elapsed = Number(b.elapsed_ms);
  const spam = clean(b.rc_hp, 200) !== '' || (Number.isFinite(elapsed) && elapsed < 1500);
  if (spam) errors.form = 'Request rejected.';
  if (Object.keys(errors).length) return { errors, spam };

  const lead = { name, phone: '+91' + phone, clinic, city, clinic_size: size || null, speciality: speciality || null, plan: PLANS.includes(plan) && plan ? plan : null, call_time: call_time || null };
  for (const f of ATTR_FIELDS) lead[f] = clean(b[f], f === 'referrer' ? 300 : 120) || null;
  lead.device = DEVICES.includes(b.device) ? b.device || null : null;
  return { lead };
}

export function newReference() {
  // 8 characters from an unambiguous alphabet, e.g. RC-7K2M9QXA
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const bytes = randomBytes(8);
  let s = '';
  for (const byte of bytes) s += alphabet[byte % alphabet.length];
  return 'RC-' + s;
}

/** Simple fixed-window rate limiter kept in memory. Enough for one server process. */
export function createRateLimiter({ limit = 5, windowMs = 10 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    allow(key, now = Date.now()) {
      const h = hits.get(key);
      if (!h || now - h.start > windowMs) { hits.set(key, { start: now, count: 1 }); return true; }
      h.count += 1;
      if (hits.size > 10000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      return h.count <= limit;
    }
  };
}

/**
 * Handles one demo request. Returns { status, body }.
 * The request is only reported as received after storage.save() has resolved.
 */
export async function handleDemoRequest(input, { storage, notify, limiter, ip = '', log = console }) {
  if (limiter && !limiter.allow(ip || 'unknown')) {
    return { status: 429, body: { error: 'rate_limited' } };
  }
  const { lead, errors, spam } = validateLead(input);
  if (errors) {
    if (spam) log.warn?.('[leads] rejected as spam');
    return { status: 400, body: { errors } };
  }
  const record = { reference: newReference(), created_at: new Date().toISOString(), ...lead, ip: ip || null };
  try {
    await storage.save(record);
  } catch (err) {
    log.error?.('[leads] storage failed:', err?.message || err);
    return { status: 503, body: { error: 'storage_unavailable' } };
  }
  if (notify) {
    notify(record).catch((err) => log.error?.('[leads] notification failed:', err?.message || err));
  }
  return { status: 201, body: { reference: record.reference } };
}
