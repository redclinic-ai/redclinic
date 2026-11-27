// POST /api/apply — saves one pilot application to Netlify Blobs.
// One record per mobile number: applying again updates the answers but keeps the
// original reference and date, so a doctor who resubmits never creates a duplicate.

import { getStore } from '@netlify/blobs';
import { validateApplication, newReference } from '../../lib/application.mjs';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function handleApply(req, store, now = () => new Date().toISOString()) {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed.' });

  let body;
  try {
    const text = await req.text();
    if (text.length > 10_000) return json(413, { ok: false, error: 'Too large.' });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'Invalid request.' });
  }

  const { application, errors, spam } = validateApplication(body);
  // Pretend success to bots so they don't retry; nothing is stored.
  if (spam) return json(200, { ok: true, reference: 'RC-000000' });
  if (errors) return json(422, { ok: false, errors });

  const key = application.phone.replace(/\D/g, '');
  const existing = await store.get(key, { type: 'json' });
  const at = now();
  const record = {
    ...application,
    reference: existing?.reference || newReference(),
    created_at: existing?.created_at || at,
    updated_at: at,
    submissions: (existing?.submissions || 0) + 1,
    user_agent: (req.headers.get('user-agent') || '').slice(0, 200),
  };
  await store.setJSON(key, record);
  return json(200, { ok: true, reference: record.reference });
}

export default async (req) => {
  try {
    const store = getStore({ name: 'pilot-applications', consistency: 'strong' });
    return await handleApply(req, store);
  } catch (err) {
    console.error('apply failed', err);
    return json(500, { ok: false, error: 'Could not save right now.' });
  }
};

export const config = { path: '/api/apply' };
