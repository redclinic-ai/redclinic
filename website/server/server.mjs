// RedClinic marketing site server. Node 20+, no dependencies.
// Serves the built site from ../dist and accepts demo requests at POST /api/demo-requests.
//
//   node build.mjs && node server/server.mjs
//
// Environment: PORT (default 8080), TRUST_PROXY=1 behind a proxy/CDN, plus the LEAD_* settings in storage.mjs.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { handleDemoRequest, createRateLimiter } from './leads.mjs';
import { storageFromEnv, webhookNotifier } from './storage.mjs';
import { adminFromEnv } from './admin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = JSON.parse(await readFile(join(here, '..', 'site.config.json'), 'utf8'));
const DIST = process.env.SITE_DIR || join(here, '..', 'dist');
const PORT = Number(process.env.PORT || 8080);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const storage = storageFromEnv();
const notify = webhookNotifier(process.env.LEAD_WEBHOOK_URL);
const admin = adminFromEnv();
const limiter = createRateLimiter({ limit: Number(process.env.LEAD_RATE_LIMIT || 5), windowMs: 10 * 60 * 1000 });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.xml', '.txt', '.json']);

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin'
};
if (process.env.HSTS === '1') SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';

const gzCache = new Map();

// Old URLs that moved. Permanent redirects keep links and search rankings.
// Pages removed in the minimal redesign point home.
const REDIRECTS = Object.fromEntries(['/platform', '/app', '/nepa', '/pricing', '/clinics', '/clinics/dental', '/clinics/dermatology', '/security'].flatMap((p) => [[p, '/'], [p + '/', '/']]));

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Fallback page for browsers without JavaScript: a plain message in the site's styles.
async function plainPage(res, status, title, message) {
  let css = '';
  try { css = (await readFile(join(DIST, 'index.html'), 'utf8')).match(/<link rel="stylesheet" href="([^"]+)">/)?.[1] || ''; } catch {}
  const html = `<!DOCTYPE html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} | RedClinic</title>${css ? `<link rel="stylesheet" href="${css}">` : ''}</head><body><main class="notfound"><div class="wrap"><h1>${escapeHtml(title)}</h1><p class="lede">${message}</p><p class="more"><a class="btn btn-ghost" href="/">Back to the homepage</a></p></div></main></body></html>`;
  send(res, status, html, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
}

async function handleApi(req, res) {
  const ip = clientIp(req);
  const ctype = String(req.headers['content-type'] || '');
  const wantsJson = ctype.includes('application/json');
  let input;
  try {
    const raw = await readBody(req);
    input = wantsJson ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
  } catch (err) {
    return send(res, err.code === 413 ? 413 : 400, JSON.stringify({ error: 'bad_request' }), { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  }
  // A plain HTML form post (no JavaScript) has no timing value; don't treat it as spam for that.
  if (!wantsJson) delete input.elapsed_ms;

  const result = await handleDemoRequest(input, { storage, notify, limiter, ip });

  if (wantsJson) {
    return send(res, result.status, JSON.stringify(result.body), { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  }
  if (result.status === 201) {
    return plainPage(res, 201, 'Request received', `Your reference is <strong>${escapeHtml(result.body.reference)}</strong>. We'll call you ${escapeHtml(SITE.callbackPromise)} to fix a time for your demo.`);
  }
  const msg = result.status === 400
    ? `Some details were missing or not valid: ${Object.values(result.body.errors).map(escapeHtml).join(' ')} Go back and check the form.`
    : 'Your request was not saved. Please try again in a few minutes, or call us on ' + escapeHtml(SITE.phoneDisplay) + '.';
  return plainPage(res, result.status, "We couldn't save your request", msg);
}

async function serveStatic(req, res) {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'Bad request'); }
  path = normalize(path).replace(/^(\.\.[\/\\])+/, '');
  if (path.includes('\0')) return send(res, 400, 'Bad request');
  let file = join(DIST, path);
  if (!file.startsWith(DIST)) return send(res, 403, 'Forbidden');

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    if (!path.endsWith('/')) return send(res, 301, '', { Location: path + '/' });
    file = join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info) {
    const body = await readFile(join(DIST, '404.html')).catch(() => 'Not found');
    return send(res, 404, body, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
  }

  const ext = extname(file);
  const immutable = /\.[0-9a-f]{10}\.(css|js)$/.test(file) || ext === '.woff2';
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    Vary: 'Accept-Encoding'
  };
  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    const key = file + ':' + info.mtimeMs;
    let gz = gzCache.get(key);
    if (!gz) { gz = gzipSync(await readFile(file), { level: 9 }); gzCache.set(key, gz); }
    return send(res, 200, req.method === 'HEAD' ? '' : gz, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
  }
  res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    if (url === '/api/demo-requests' || url.startsWith('/api/demo-requests?')) {
      if (req.method !== 'POST') return send(res, 405, '', { Allow: 'POST' });
      return await handleApi(req, res);
    }
    if (url === '/api/health') return send(res, 200, JSON.stringify({ ok: true, storage: storage.name }), { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
    if (url.startsWith('/admin/')) {
      if (admin && await admin(req, res, send)) return;
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    }
    if (url.startsWith('/api/')) return send(res, 404, JSON.stringify({ error: 'not_found' }), { 'Content-Type': TYPES['.json'] });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { Allow: 'GET, HEAD' });
    const bare = url.split('?')[0];
    if (REDIRECTS[bare]) return send(res, 301, '', { Location: REDIRECTS[bare] });
    return await serveStatic(req, res);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) send(res, 500, 'Server error');
    else res.end();
  }
});

server.listen(PORT, () => console.log(`RedClinic site on http://localhost:${PORT} (lead storage: ${storage.name})`));
