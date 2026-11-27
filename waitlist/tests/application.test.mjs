import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateApplication, normalisePhone, toCSV, newReference } from '../lib/application.mjs';
import { handleApply } from '../netlify/functions/apply.mjs';
import { handleList } from '../netlify/functions/applications.mjs';

const good = { role: 'doctor', name: 'Dr. Ananya Rao', phone: '98765 43210', clinic: 'Smile Care Dental', outcomes: ['booking', 'noshow'], elapsed_ms: 20000 };

function memoryStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    async list() { return { blobs: [...m.keys()].map((key) => ({ key })) }; },
  };
}
const post = (body, raw) => new Request('https://x.test/api/apply', { method: 'POST', body: raw ?? JSON.stringify(body), headers: { 'user-agent': 'test' } });

test('valid application is normalised', () => {
  const { application, errors } = validateApplication(good);
  assert.equal(errors, undefined);
  assert.equal(application.phone, '+919876543210');
  assert.equal(application.role_label, 'Doctor');
  assert.deepEqual(application.outcome_labels, ['Appointment booking', 'No-show recovery']);
});

test('phone formats', () => {
  assert.equal(normalisePhone('+91 98765-43210'), '9876543210');
  assert.equal(normalisePhone('09876543210'), '9876543210');
  assert.ok(validateApplication({ ...good, phone: '12345' }).errors.phone);
  assert.ok(validateApplication({ ...good, phone: '5876543210' }).errors.phone);
});

test('role "none" and unknown roles are rejected', () => {
  assert.ok(validateApplication({ ...good, role: 'none' }).errors.role);
  assert.ok(validateApplication({ ...good, role: '' }).errors.role);
});

test('outcomes: required, known only, deduped, canonical order, comma string accepted', () => {
  assert.ok(validateApplication({ ...good, outcomes: [] }).errors.outcomes);
  assert.ok(validateApplication({ ...good, outcomes: ['booking', 'hack'] }).errors.outcomes);
  const { application } = validateApplication({ ...good, outcomes: 'assistant,booking,booking' });
  assert.deepEqual(application.outcomes, ['booking', 'assistant']);
});

test('all ten outcomes accepted', () => {
  const all = ['booking', 'reminders', 'followups', 'noshow', 'treatment', 'enquiries', 'leads', 'tasks', 'records', 'assistant'];
  assert.equal(validateApplication({ ...good, outcomes: all }).application.outcomes.length, 10);
});

test('missing name / clinic', () => {
  const r = validateApplication({ ...good, name: ' ', clinic: 'a' });
  assert.ok(r.errors.name && r.errors.clinic);
  assert.ok(validateApplication(null).errors.role);
});

test('spam: honeypot or too fast', () => {
  assert.equal(validateApplication({ ...good, rc_hp: 'x' }).spam, true);
  assert.equal(validateApplication({ ...good, elapsed_ms: 300 }).spam, true);
});

test('reference format', () => assert.match(newReference(), /^RC-[2-9A-HJ-NP-Z]{6}$/));

test('apply stores, and re-applying updates the same record', async () => {
  const store = memoryStore();
  let r = await handleApply(post(good), store, () => '2026-11-27T10:00:00Z');
  assert.equal(r.status, 200);
  const first = await r.json();
  assert.ok(first.ok);
  r = await handleApply(post({ ...good, clinic: 'Smile Care Dental Clinic', outcomes: ['records'] }), store, () => '2026-11-28T10:00:00Z');
  const second = await r.json();
  assert.equal(second.reference, first.reference);
  assert.equal(store.m.size, 1);
  const saved = await store.get('919876543210');
  assert.equal(saved.created_at, '2026-11-27T10:00:00Z');
  assert.equal(saved.updated_at, '2026-11-28T10:00:00Z');
  assert.equal(saved.submissions, 2);
  assert.equal(saved.clinic, 'Smile Care Dental Clinic');
});

test('apply: invalid → 422, bad JSON → 400, GET → 405, spam → fake ok and nothing stored', async () => {
  const store = memoryStore();
  assert.equal((await handleApply(post({ ...good, phone: '1' }), store)).status, 422);
  assert.equal((await handleApply(post(null, '{nope'), store)).status, 400);
  assert.equal((await handleApply(new Request('https://x.test/api/apply'), store)).status, 405);
  const s = await handleApply(post({ ...good, rc_hp: 'bot' }), store);
  assert.equal(s.status, 200);
  assert.equal(store.m.size, 0);
});

test('admin export: off without key, 401 with wrong key, CSV with right key', async () => {
  const store = memoryStore();
  await handleApply(post(good), store);
  await handleApply(post({ ...good, phone: '9123456789', name: '=cmd()', role: 'owner' }), store);
  assert.equal((await handleList(new Request('https://x.test/api/applications?key=a'), store, '')).status, 503);
  assert.equal((await handleList(new Request('https://x.test/api/applications?key=wrong'), store, 'secret')).status, 401);
  const csv = await handleList(new Request('https://x.test/api/applications?key=secret'), store, 'secret');
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /Smile Care Dental/);
  assert.match(text, /"'=cmd\(\)"/); // formula neutralised
  assert.equal(text.trim().split('\r\n').length, 3);
  const js = await (await handleList(new Request('https://x.test/api/applications?key=secret&format=json'), store, 'secret')).json();
  assert.equal(js.count, 2);
});

test('csv quoting', () => {
  assert.match(toCSV([{ name: 'A "B"', outcome_labels: ['x', 'y'] }]), /"A ""B"""/);
});
