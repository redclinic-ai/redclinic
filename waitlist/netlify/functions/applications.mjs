// GET /api/applications?key=ADMIN_KEY            → CSV download (opens in Excel / Google Sheets)
// GET /api/applications?key=ADMIN_KEY&format=json → JSON
// Set ADMIN_KEY in Netlify: Site configuration → Environment variables. Without it, this is switched off.

import { getStore } from '@netlify/blobs';
import { timingSafeEqual } from 'node:crypto';
import { toCSV } from '../../lib/application.mjs';

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function handleList(req, store, adminKey) {
  const url = new URL(req.url);
  const given = url.searchParams.get('key') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!adminKey) return new Response('Admin export is off. Set ADMIN_KEY in Netlify environment variables.', { status: 503 });
  if (!given || !same(given, adminKey)) return new Response('Not allowed.', { status: 401 });

  const { blobs } = await store.list();
  const rows = (await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })))).filter(Boolean);
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({ count: rows.length, applications: rows }, null, 2), {
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const day = new Date().toISOString().slice(0, 10);
  return new Response('﻿' + toCSV(rows), {
    headers: {
      ...headers,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="redclinic-pilot-applications-${day}.csv"`,
    },
  });
}

export default async (req) => {
  const store = getStore({ name: 'pilot-applications', consistency: 'strong' });
  return handleList(req, store, process.env.ADMIN_KEY);
};

export const config = { path: '/api/applications' };
