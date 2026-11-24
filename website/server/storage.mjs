// Storage adapters for demo requests. Pick one with LEAD_STORAGE.
//
//   LEAD_STORAGE=file       Appends JSON lines to LEADS_FILE (default ./data/demo-requests.jsonl).
//                           Fine for a single server with a persistent disk. Not for serverless hosts.
//   LEAD_STORAGE=postgrest  Inserts into a Postgres table through PostgREST (Supabase's REST API).
//                           Needs LEADS_REST_URL (e.g. https://xyz.supabase.co/rest/v1) and LEADS_REST_KEY
//                           (a service role key, kept on the server only). Table: db/demo_requests.sql.
//
// Every adapter's save() must reject if the record was not stored.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function fileStorage(path) {
  const file = resolve(path);
  return {
    name: 'file',
    async save(record) {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    }
  };
}

export function postgrestStorage({ url, key, table = 'demo_requests', fetchImpl = fetch }) {
  if (!url || !key) throw new Error('LEADS_REST_URL and LEADS_REST_KEY are required for postgrest storage');
  const endpoint = url.replace(/\/$/, '') + '/' + table;
  return {
    name: 'postgrest',
    async save(record) {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error(`PostgREST insert failed with ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  };
}

export function storageFromEnv(env = process.env) {
  const kind = env.LEAD_STORAGE || 'file';
  if (kind === 'file') return fileStorage(env.LEADS_FILE || './data/demo-requests.jsonl');
  if (kind === 'postgrest') return postgrestStorage({ url: env.LEADS_REST_URL, key: env.LEADS_REST_KEY, table: env.LEADS_TABLE });
  throw new Error(`Unknown LEAD_STORAGE: ${kind}`);
}

/** Optional: post a short notice to a chat webhook (Slack, Google Chat, etc.) after a lead is stored. */
export function webhookNotifier(url) {
  if (!url) return null;
  return async (r) => {
    const sizes = { '1': '1 doctor', '2-3': '2-3 doctors', '4+': '4+ doctors', multi: 'multiple locations' };
    const text = `New demo request ${r.reference}: ${r.name}, ${r.clinic} (${r.city}), ${r.speciality || 'speciality not given'}${r.clinic_size ? ', ' + sizes[r.clinic_size] : ''}${r.plan ? ', wants ' + r.plan + ' pack' : ''}. Call ${r.phone}${r.call_time ? ' in the ' + r.call_time : ''}. Source: ${r.utm_source || r.referrer || 'direct'}.`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('webhook returned ' + res.status);
  };
}
