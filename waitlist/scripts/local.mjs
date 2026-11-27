// Local preview that behaves like Netlify: static files from public/, the two functions on their
// paths, a real local Netlify Blobs server, and Netlify Forms captured to .local/forms.jsonl.
// Usage: ADMIN_KEY=anything node scripts/local.mjs   (then open http://localhost:8888)
// Set FAIL_FUNCTION=1 or FAIL_FORMS=1 to simulate either store being down.

import http from 'node:http';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobsServer } from '@netlify/blobs/server';

const root = fileURLToPath(new URL('..', import.meta.url));
const pub = join(root, 'public');
const dataDir = join(root, '.local');
await mkdir(dataDir, { recursive: true });

const token = 'local-token';
const blobs = new BlobsServer({ directory: join(dataDir, 'blobs'), token, port: 0 });
const { port: blobsPort } = await blobs.start();
const ctx = { edgeURL: `http://localhost:${blobsPort}`, uncachedEdgeURL: `http://localhost:${blobsPort}`, siteID: 'local-site', token, deployID: 'local' };
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify(ctx)).toString('base64');

const apply = (await import('../netlify/functions/apply.mjs')).default;
const list = (await import('../netlify/functions/applications.mjs')).default;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}
async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

const port = Number(process.env.PORT || 8888);
http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/api/apply') {
      if (process.env.FAIL_FUNCTION) return send(res, new Response('down', { status: 502 }));
      return send(res, await apply(await toRequest(req)));
    }
    if (path === '/api/applications') return send(res, await list(await toRequest(req)));
    if (req.method === 'POST') {
      // Netlify Forms stand-in
      const r = await toRequest(req);
      const form = Object.fromEntries(new URLSearchParams(await r.text()));
      if (process.env.FAIL_FORMS || form['form-name'] !== 'pilot-application') return send(res, new Response('no', { status: 404 }));
      await appendFile(join(dataDir, 'forms.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...form }) + '\n');
      return send(res, new Response('ok', { status: 200 }));
    }
    let file = normalize(path === '/' ? '/index.html' : path);
    if (file.includes('..')) throw new Error('bad path');
    try {
      const buf = await readFile(join(pub, file));
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
      return res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end(await readFile(join(pub, '404.html')));
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('error');
  }
}).listen(port, () => console.log(`Local preview on http://localhost:${port} (blobs on ${blobsPort})`));
