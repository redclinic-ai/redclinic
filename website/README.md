# RedClinic marketing website

The public website for redclinic.ai. Static pages plus one small Node server that stores demo requests.
Independent of the clinic application: it shares no code, database tables or credentials with it.

No runtime dependencies. Node 20 or newer is the only requirement.

```
npm run build        # builds dist/
npm start            # serves dist/ and the demo-request API on http://localhost:8080
npm run dev          # both
npm test             # lead validation and storage tests (node:test)
npm run build:preview  # dist-preview/: relative links, form shows a preview notice (for static previews)
```

## Layout

```
site.config.json      Phone, email, domain, callback promise. Change contact details here only.
build.mjs             Build script: partials, fingerprinted CSS/JS, sitemap.xml, robots.txt
src/layout.html       <head>, metadata, header and footer wrapper for every page
src/pages/*.html      One file per page. JSON front matter sets title, description, URL, nav state
src/partials/*.html   Shared blocks: header, footer, demo form, sample calls, product mockups, CTA band
src/assets/           site.css, site.js, Instrument Sans (variable woff2), logo, icons, og.png
src/static/           Copied to the site root as-is (site.webmanifest)
server/server.mjs     Static file server with security headers + POST /api/demo-requests + GET /api/health
server/leads.mjs      Validation, spam checks, rate limiting, request handler
server/storage.mjs    Storage adapters (file, PostgREST/Supabase) and optional chat-webhook notice
db/demo_requests.sql  Table, locked-down permissions and a funnel view for the leads database
tests/                Unit tests
```

Pages: `/`, `/nepa/`, `/platform/`, `/security/`, `/demo/`, `/privacy/`, plus `404.html`.

## Editing content

- Text lives in `src/pages` and `src/partials`. Plain HTML, no framework.
- `{{site.phoneDisplay}}` etc. come from `site.config.json`.
- Product screens are HTML mockups in `src/partials/*-mock.html`, `rct-flow.html` and `conversations.html`.
  When real app screens exist, keep the "Illustrative" labels until each feature is live.

## Environment variables (server)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `LEAD_STORAGE` | `file` | `file` or `postgrest` |
| `LEADS_FILE` | `./data/demo-requests.jsonl` | File storage path. Needs a persistent disk |
| `LEADS_REST_URL` | | PostgREST base URL, e.g. `https://<project>.supabase.co/rest/v1` |
| `LEADS_REST_KEY` | | Service role key. Server only, never in the browser or Git |
| `LEADS_TABLE` | `demo_requests` | Table name |
| `LEAD_WEBHOOK_URL` | | Optional Slack/Google Chat webhook for new-lead notices. Sends name, clinic, city and phone to that service: enable only with approval |
| `LEAD_RATE_LIMIT` | `5` | Requests per IP per 10 minutes |
| `TRUST_PROXY` | | Set `1` behind a load balancer/CDN so the real client IP is used |
| `HSTS` | | Set `1` once HTTPS is confirmed on the domain |

## Deploying

Any host that runs a Node process works (a small VM, Render, Railway, Fly.io, a container).
1. Create the leads table: run `db/demo_requests.sql` in the leads database (e.g. a Supabase project).
2. Set `LEAD_STORAGE=postgrest`, `LEADS_REST_URL`, `LEADS_REST_KEY`, `TRUST_PROXY=1`.
3. `npm run build && npm start`. Point redclinic.ai at it, enable HTTPS, then set `HSTS=1`.
4. Check `GET /api/health`, submit one test request from a phone and confirm the row exists.

Static-only hosts (Netlify, Cloudflare Pages, Vercel static) can serve `dist/`, but the form then needs
`server/leads.mjs` wrapped as that host's function at `/api/demo-requests`. The handler is host-neutral.

## Analytics

`site.js` pushes these events to `window.dataLayer`: `page_view`, `cta_click`, `call_click`, `email_click`,
`sample_call_view`, `form_start`, `form_submit`, `form_error`, `form_abandon`, `lead_submitted`.
Each carries page, device type, source and landing page. No names, numbers or clinic names are ever included.
Nothing is sent anywhere until either a tag manager is added (needs approval and a consent banner) or
`analytics.endpoint` is set in `site.config.json` and visitors have consented.

Lead source, landing page, UTM values and device are stored with each demo request, so conversion by
landing page and source can be read from the `demo_funnel` view without any third-party analytics.
Update `status` on each row (`contacted`, `demo_booked`, `demo_done`, `trial`, `won`...) to see the full funnel.
