import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLead, normalisePhone, handleDemoRequest, createRateLimiter, newReference } from '../server/leads.mjs';

const good = { name: 'Dr Anjali Rao', phone: '98450 12345', clinic: 'Smile Dental', city: 'Bengaluru', size: '2-3', speciality: 'dental', plan: 'pilot', call_time: 'morning', elapsed_ms: 9000, utm_source: 'google', device: 'mobile' };

test('normalises Indian mobile numbers', () => {
  assert.equal(normalisePhone('+91 98450 12345'), '9845012345');
  assert.equal(normalisePhone('098450-12345'), '9845012345');
});

test('accepts a valid request', () => {
  const { lead, errors } = validateLead(good);
  assert.equal(errors, undefined);
  assert.equal(lead.phone, '+919845012345');
  assert.equal(lead.clinic_size, '2-3');
  assert.equal(lead.utm_source, 'google');
  assert.equal(lead.speciality, 'dental');
  assert.equal(lead.plan, 'pilot');
});

test('rejects missing and bad fields with plain messages', () => {
  const { errors } = validateLead({ name: '', phone: '12345', clinic: '', city: 'x', size: 'lots', elapsed_ms: 9000 });
  assert.deepEqual(Object.keys(errors).sort(), ['city', 'clinic', 'name', 'phone', 'size', 'speciality']);
  assert.match(errors.phone, /10-digit/);
});

test('rejects landlines and numbers not starting 6-9', () => {
  assert.ok(validateLead({ ...good, phone: '0804123456' }).errors.phone);
  assert.ok(validateLead({ ...good, phone: '5845012345' }).errors.phone);
});

test('flags honeypot and too-fast submissions as spam', () => {
  assert.equal(validateLead({ ...good, rc_hp: 'http://x' }).spam, true);
  assert.equal(validateLead({ ...good, elapsed_ms: 300 }).spam, true);
});

test('strips control characters and caps lengths', () => {
  const { lead } = validateLead({ ...good, clinic: 'A\u0000B' + 'x'.repeat(500) });
  assert.ok(!lead.clinic.includes('\u0000'));
  assert.equal(lead.clinic.length, 120);
});

test('only confirms after storage succeeds', async () => {
  const saved = [];
  const ok = await handleDemoRequest(good, { storage: { save: async (r) => saved.push(r) }, log: {} });
  assert.equal(ok.status, 201);
  assert.match(ok.body.reference, /^RC-[0-9A-Z]{8}$/);
  assert.equal(saved[0].reference, ok.body.reference);

  const fail = await handleDemoRequest(good, { storage: { save: async () => { throw new Error('down'); } }, log: { error() {} } });
  assert.equal(fail.status, 503);
  assert.equal(fail.body.reference, undefined);
});

test('rate limits repeated requests from one address', async () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 60000 });
  const storage = { save: async () => {} };
  const s = [];
  for (let i = 0; i < 3; i++) s.push((await handleDemoRequest(good, { storage, limiter, ip: '1.2.3.4', log: {} })).status);
  assert.deepEqual(s, [201, 201, 429]);
});

test('references are unique enough', () => {
  const set = new Set(Array.from({ length: 5000 }, newReference));
  assert.equal(set.size, 5000);
});
