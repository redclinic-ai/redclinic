# QA report (Phase 8)

Date: 23 November 2026. Build: branch `phase1-app-scaffold-auth`. Environment: local production build (`next build && next start`, and the standalone server used by the Docker image), PostgreSQL 16, Chrome.

## Automated tests

| Suite | Result |
|---|---|
| Database (SQL, fresh DB each run): tenancy, permissions, RLS on every clinic table, append-only audit, no revenue fields, policy performance rule | 105 / 105 pass |
| Application (vitest, real PostgreSQL, app connects as non-superuser `rc_app` member) | 123 / 123 pass |
| CI on GitHub Actions (type check, both suites, production build) | Green on every push |
| Browser smoke test `npm run smoke` (sign-up → service → patient → test call → results → plan) | 10 / 10 pass |

## Accessibility

axe-core 4 (WCAG 2.0 A/AA and 2.1 AA rules) on 54 screens: every clinic screen for clinic admin, receptionist and doctor, detail pages, public auth pages, and the RedClinic admin area, at phone (390 px) and laptop (1366 px) widths. **0 violations.** Also checked by hand: visible focus outlines, 44–48 px touch targets, labels on every field, errors announced (`role="alert"`) and focus moved to the field in error, skip link.

## Security review (manual, all routes, server actions and queries)

Fixed in this phase:
- Open redirect: two forms passed a "back" address straight to a redirect. Now only same-site paths are allowed (`safePath`).
- Test-call actions did not check the call was a test call: staff could have typed into a live call in their clinic. Now refused.
- No rate limits on sign-up and password reset (K7): now per network (5 sign-ups/hour) and per address (3 reset emails/hour, silently), stored in the database.
- Without an email provider, production logs would have contained password-reset links. Production/staging now log only a masked address.
- Added Content-Security-Policy (no outside scripts, frames or form targets) and HSTS in production.

Fixed earlier, during feature work: calls readable without `view_calls` (Phase 5), assistant questions in the URL (Phase 5).

Confirmed:
- Every page checks permissions on the server; every service checks capabilities; row-level security is the final guard on every clinic table (database suite).
- All SQL is parameterised; the two places that build SQL use fixed allow-lists of column names.
- Sessions: random tokens, only hashes stored, httpOnly/SameSite=Lax/Secure cookies, revoked on logout, password reset and deactivation.
- Uploads: type from file content, 15 MB cap, files never public, 5-minute signed links, sandboxed when opened.
- Webhooks (telephony, payments): HMAC signature, constant-time comparison, duplicate events ignored. Simulated providers are refused in production unless explicitly allowed (staging).
- `npm audit`: 0 vulnerabilities.

Not done (needs a hosting choice or an outside party): penetration test by a third party; dependency and container scanning in CI after the host is chosen.

## Performance

Demo clinic loaded to 5,060 patients, 29,990 appointments, 10,003 calls, 60,017 transcript lines. Production build, single Node process, 3 runs each:

| Screen | Before | After |
|---|---|---|
| Appointments (day) | 1.03 s | 0.05 s |
| Patient search by name | 1.30 s | 0.06 s |
| Patient search by phone | 1.31 s | 0.06 s |
| Calls | 0.51 s | 0.05 s |
| Results (30 days) | 0.48 s | 0.04 s |
| Today | 0.32 s | 0.09 s |
| Needs attention | 0.16 s | 0.12 s |

Causes fixed: row-level security functions evaluated per row (now once per query, migration 017, enforced by a database test), PostgreSQL JIT compiling short queries (~400 ms; now off for app connections), missing indexes (phone substring, patient code, appointments by clinic and time, calls, audit log), day bounds computed per row.

Load: 300 requests, 20 at a time (search, appointments, Today): all 200, median 0.60 s, 95th percentile 0.77 s, on this small single-process container. Enough for 50–100 clinics; production should run 2+ app instances behind the host's load balancer.

## Devices

Checked: phone 390×844, tablet 820×1180, laptop 1366×900. Layouts adapt (bottom bar on phone/tablet, sidebar on laptop). Interactive parts (assistant, forms, menus) work with the production security policy on.

## Staging

Not deployed: no hosting account yet (KNOWN_ISSUES K8). The production package was verified locally: the standalone server starts, `/api/health` reports database and storage OK, and the smoke test passes. The staging runbook is in DEPLOYMENT.md.
