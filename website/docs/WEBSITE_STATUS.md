# Website status

Last updated 23 November 2026.

## Complete and tested

- Six pages and a 404 page, all copy written, mobile-first.
- Demo request form with client and server validation, spam protection and rate limiting.
- Lead storage: file adapter tested end to end; PostgREST adapter built and tested for the failure path
  (no Supabase project was available to test a real insert).
- Confirmation only after storage succeeds (tested by forcing a storage failure).
- No-JavaScript fallback for the form.
- SEO: titles, descriptions, canonical URLs, Open Graph and share image, JSON-LD, sitemap.xml, robots.txt.
- Analytics event layer with lead source, landing page and device stored on each lead. No third parties.
- QA run (Playwright, Chrome) at 360, 412, 820 and 1440 px: no horizontal overflow, no console errors, all
  internal links 200, all tap targets at least 40 px, tabs and menu keyboard-accessible.
- Lighthouse (mobile emulation): 100/100/100/100 on home, NEPA, platform, security and demo pages.
- Unit tests: `npm test`, 9 passing.

Not tested: Safari and Firefox (only Chrome was available here), real Android devices, a live Supabase insert.

## Needs setup outside the code

| Item | What to do |
|---|---|
| Hosting and domain | Choose a host that runs Node, deploy, point redclinic.ai, enable HTTPS, set `HSTS=1` |
| Leads database | Create a Supabase project (or other Postgres + PostgREST), run `db/demo_requests.sql`, set `LEADS_REST_URL` and `LEADS_REST_KEY` |
| New-lead alerts | Optional: set `LEAD_WEBHOOK_URL`. This sends lead details to that chat service, so approve it first |
| Analytics tool | Optional: approve a tool, add a consent banner, then connect it to `window.dataLayer` |
| Google Search Console | Verify the domain and submit `/sitemap.xml` after launch |

## Founder decisions and checks before launch

1. **Callback promise.** The site promises a call "within one working day". Change it in `site.config.json`
   if that can't be met every time.
2. **Privacy notice.** Retention (12 months) and response time (30 days) are proposals. Needs legal review.
3. **RedClinic's access to clinic data.** The security page says RedClinic staff can access clinic data and
   that use is governed by the clinic terms. This matches the current decision (D6, D7). If the training-data
   wording in the terms changes, update the security page to match.
4. **Certifications.** The site states that RedClinic doesn't yet hold ISO 27001 or ABDM approval. HIPAA,
   NABH, "AWS secured" and similar badges must not be added until each is real and documented.
5. **Kannada.** Listed as a launch language from the product spec. Remove it if it won't be ready.
6. **Company name.** The footer says "© 2026 RedClinic". Add the legal entity once registration completes.
7. **About page.** Worth adding once you're happy to share founder and team details. Real people help trust.

## When the product goes live

- Replace HTML mockups with real screens, feature by feature.
- Remove "in development" lines only for features that pass their end-to-end tests.
- Once telephony works, consider a "call NEPA yourself" demo number on the NEPA page. Not built now
  because live calling isn't available, and it must never be faked.
- Add real customer quotes only with written permission.
