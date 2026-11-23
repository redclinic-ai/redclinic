// RedClinic marketing site build. No dependencies: Node 20+ only.
//
//   node build.mjs            -> dist/          (production, clean URLs like /nepa/)
//   node build.mjs --preview  -> dist-preview/  (relative links, form shows a preview notice)
//
// Pages live in src/pages/*.html and start with a JSON front-matter comment:
//   <!--{"title":"...","description":"...","path":"/nepa/","nav":"nepa"}-->
// Templates: {{> partial}} includes src/partials/partial.html, {{site.key}} reads site.config.json,
// {{page.key}} reads the page front matter.

import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const preview = process.argv.includes('--preview');
const out = join(root, preview ? 'dist-preview' : 'dist');
const site = JSON.parse(await readFile(join(root, 'site.config.json'), 'utf8'));

const partials = {};
for (const f of await readdir(join(root, 'src/partials'))) {
  partials[f.replace(/\.html$/, '')] = await readFile(join(root, 'src/partials', f), 'utf8');
}

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function render(tpl, ctx, depth = 0) {
  if (depth > 8) throw new Error('Partial nesting too deep');
  tpl = tpl.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => {
    if (!(name in partials)) throw new Error(`Unknown partial: ${name}`);
    return render(partials[name], ctx, depth + 1);
  });
  return tpl.replace(/\{\{\s*((?:site|page)\.[\w.]+)\s*\}\}/g, (_, key) => {
    const v = get(ctx, key);
    if (v === undefined) throw new Error(`Missing value: ${key}`);
    return String(v);
  });
}

// 1. Clean output and copy static assets.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'src/assets'), join(out, 'assets'), { recursive: true });
await cp(join(root, 'src/static'), out, { recursive: true });

// 2. Fingerprint CSS and JS so they can be cached for a year.
const hashed = {};
for (const rel of ['assets/css/site.css', 'assets/js/site.js']) {
  const src = await readFile(join(out, rel), 'utf8');
  const min = rel.endsWith('.css')
    ? src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, '\n').replace(/\n+/g, '\n')
    : src;
  const h = createHash('sha256').update(min).digest('hex').slice(0, 10);
  const name = rel.replace(/(\.\w+)$/, `.${h}$1`);
  await writeFile(join(out, name), min);
  await rm(join(out, rel));
  hashed['/' + rel] = '/' + name;
}

// 3. Render pages.
const layout = await readFile(join(root, 'src/layout.html'), 'utf8');
const pages = [];
for (const f of (await readdir(join(root, 'src/pages'))).filter((f) => f.endsWith('.html'))) {
  const raw = await readFile(join(root, 'src/pages', f), 'utf8');
  const m = raw.match(/^<!--(\{[\s\S]*?\})-->\s*/);
  if (!m) throw new Error(`${f}: missing front matter`);
  const page = { nav: '', robots: 'index,follow', ogType: 'website', jsonld: '', ...JSON.parse(m[1]) };
  page.canonical = site.origin + page.path;
  page.preview = preview ? 'true' : 'false';
  const ctx = { site, page };
  page.body = render(raw.slice(m[0].length), ctx);
  let html = render(layout, ctx);
  // Mark the current nav item.
  if (page.nav) html = html.replace(new RegExp(`data-nav="${page.nav}"`, 'g'), `data-nav="${page.nav}" aria-current="page"`);
  for (const [from, to] of Object.entries(hashed)) html = html.split(from).join(to);
  const file = page.file || (page.path === '/' ? 'index.html' : page.path.replace(/^\//, '') + 'index.html');
  pages.push({ ...page, file, html });
}

// 4. Preview builds use relative links so they work from any folder or host.
function relativize(html, file) {
  const fromDir = posix.dirname(file);
  return html.replace(/(href|src|action)="\/(?!\/)([^"]*)"/g, (all, attr, target) => {
    if (attr === 'href' && target.startsWith('api/')) return all;
    let path = target.split('#')[0];
    const hash = target.includes('#') ? '#' + target.split('#')[1] : '';
    if (path === '' || path.endsWith('/')) path += 'index.html';
    let r = posix.relative(fromDir, path) || 'index.html';
    return `${attr}="${r}${hash}"`;
  }).replace(/url\(\/assets\//g, `url(${posix.relative(fromDir, 'assets') || '.'}/`);
}

for (const p of pages) {
  const html = preview ? relativize(p.html, p.file) : p.html;
  await mkdir(dirname(join(out, p.file)), { recursive: true });
  await writeFile(join(out, p.file), html);
}

// CSS references fonts with absolute paths; the preview needs them relative to the CSS file.
if (preview) {
  const cssPath = join(out, hashed['/assets/css/site.css']);
  const css = await readFile(cssPath, 'utf8');
  await writeFile(cssPath, css.replace(/url\(\/assets\//g, 'url(../'));
}

// 5. Sitemap and robots.
const urls = pages.filter((p) => p.sitemap !== false && p.robots.startsWith('index'));
const today = new Date().toISOString().slice(0, 10);
await writeFile(join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((p) => `  <url><loc>${p.canonical}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
  `\n</urlset>\n`);
await writeFile(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${site.origin}/sitemap.xml\n`);

console.log(`Built ${pages.length} pages into ${relative(root, out)}/`);
