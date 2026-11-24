// Password-protected list of demo requests for the RedClinic team: /admin/leads (and /admin/leads.csv).
// Enabled only when ADMIN_USER and ADMIN_PASSWORD are set. Reads the file storage (LEAD_STORAGE=file).

import { readFile } from 'node:fs/promises';
import { timingSafeEqual, createHash } from 'node:crypto';

const SIZES = { '1': '1 doctor', '2-3': '2–3 doctors', '4+': '4+ doctors', multi: 'Several locations' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const same = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function adminFromEnv(env = process.env) {
  const user = env.ADMIN_USER, pass = env.ADMIN_PASSWORD;
  if (!user || !pass || pass.length < 12) return null;
  const file = env.LEADS_FILE || './data/demo-requests.jsonl';

  function authorised(req) {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Basic ')) return false;
    const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    return same(u, user) & same(rest.join(':'), pass);
  }

  async function leads() {
    let raw = '';
    try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  }

  return async function handle(req, res, send) {
    const path = req.url.split('?')[0];
    if (path !== '/admin/leads' && path !== '/admin/leads.csv') return false;
    const base = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'" };
    if (!authorised(req)) {
      send(res, 401, 'Sign in required', { ...base, 'WWW-Authenticate': 'Basic realm="RedClinic leads", charset="UTF-8"', 'Content-Type': 'text/plain' });
      return true;
    }
    const rows = await leads();
    if (path.endsWith('.csv')) {
      const cols = ['reference', 'created_at', 'name', 'phone', 'clinic', 'city', 'speciality', 'clinic_size', 'plan', 'call_time', 'landing_page', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer', 'device'];
      const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
      send(res, 200, csv, { ...base, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="redclinic-demo-requests.csv"' });
      return true;
    }
    const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const items = rows.map((r) => `<li><div class="top"><strong>${esc(r.name)}</strong><span>${esc(fmt(r.created_at))}</span></div>
      <div>${esc(r.clinic)}, ${esc(r.city)}</div>
      <div class="meta">${esc(r.speciality || '')} · ${esc(SIZES[r.clinic_size] || r.clinic_size)}${r.plan ? ' · wants <b>' + esc(r.plan) + '</b>' : ''}${r.call_time ? ' · call ' + esc(r.call_time) : ''}</div>
      <div class="meta">From ${esc(r.utm_source || (r.referrer ? 'referral' : 'direct'))} on ${esc(r.landing_page || '?')} · ${esc(r.device || '')} · ${esc(r.reference)}</div>
      <div class="acts"><a href="tel:${esc(r.phone)}">Call ${esc(r.phone)}</a><a href="https://wa.me/${esc(String(r.phone).replace('+', ''))}">WhatsApp</a></div></li>`).join('');
    const html = `<!DOCTYPE html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Demo requests | RedClinic</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#15181d;background:#f5f6f7}main{max-width:760px;margin:0 auto;padding:20px 16px}h1{font-size:1.5rem;margin:0 0 4px}p{color:#4b525c;margin:0 0 16px}ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}li{background:#fff;border:1px solid #e2e4e7;border-radius:12px;padding:14px 16px}.top{display:flex;justify-content:space-between;gap:12px}.top span,.meta{color:#5c636c;font-size:.88rem}.acts{display:flex;gap:10px;margin-top:10px}.acts a{flex:1;text-align:center;padding:10px;border-radius:999px;background:#de0a12;color:#fff;text-decoration:none;font-weight:600}.acts a+a{background:#1d6f54}.dl{color:#15181d}</style></head>
<body><main><h1>Demo requests</h1><p>${rows.length} in total, newest first. <a class="dl" href="/admin/leads.csv">Download CSV</a></p><ul>${items || '<li>No requests yet.</li>'}</ul></main></body></html>`;
    send(res, 200, html, { ...base, 'Content-Type': 'text/html; charset=utf-8' });
    return true;
  };
}
