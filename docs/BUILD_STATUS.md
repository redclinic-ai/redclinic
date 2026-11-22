# BUILD_STATUS

Last updated: 2026-11-22. Source of truth for what is actually built and tested.

## Phase status

| Phase | Status |
|---|---|
| 0 Audit | Done (nothing existed; see ARCHITECTURE.md "Audit") |
| 1 Foundation: database, tenancy, permissions | Schema and tests done (migrations 001-007, 99 SQL tests passing on PostgreSQL 16). No application code yet |
| 1 Foundation: app scaffold | Done. Next.js 16 + TypeScript, `pg`, zod, vitest. Builds cleanly; 0 npm audit findings |
| 1 Foundation: authentication | Done and tested (migration 008, `src/lib/auth`). Clinic signup with terms acceptance, login, 7-day sessions, sign out, forgot/reset password, staff invitation links, deactivation, super admin creation script. Emails are simulated (no provider selected) |
| 1 Foundation: private storage | Done and tested (migration 009, `src/lib/storage`, `src/lib/documents`). Upload PDF/JPG/PNG (checked by content, 15 MB limit) and notes; originals kept with SHA-256 fingerprint, never overwritten; 5-minute signed links; permission checks and audit entries on upload and open. Local disk adapter only; cloud adapter waits for the hosting choice (K8). No upload screen yet (Phase 2 patient pages) |
| 1 Foundation: deployment groundwork | Done: GitHub Actions CI (type check, SQL tests, app tests, build), production Dockerfile with health check, backup and restore scripts (restore refuses a non-empty database). Not deployed: no hosting chosen (K8) |
| 1 Foundation: monitoring | Done: `/api/health` (database + storage), JSON logs with secret redaction, all server errors reported through one hook. Log-only until an error-monitoring provider is chosen |
| 2 Clinic application | Done and tested (migration 010). Clinic profile, opening hours, languages, services (no prices), FAQs, consent wording (English/Hindi defaults, versioned); staff invite, permissions (capped by RedClinic per-clinic switches), switch-off; patients with permanent ID, duplicate warning (phone or similar name), search by name/ID/phone, medical history (doctor only by default, views audited), consent record/withdraw (withdrawal flags admin), documents, history timeline, controlled merge, CSV import/export (formula-safe); appointments in clinic timezone, walk-ins, confirm/done/no-show/cancel, reschedule keeping history, double booking refused. Screens for all of it, phone and laptop |
| 3 Product experience (Today, Needs Attention, Results) | Results counts function done and tested (migration 006). No UI yet |
| 4 NEPA architecture | Not started |
| 5 Voice and AI foundation (simulated calls) | Not started |
| 6 Dental Pack | Draft only: 9 workflows (incl. RCT, braces, recall) written by engineering (migration 005), marked `draft`, auto-copied to new dental clinics, automatic mode off. Founder spec still needed (K2) |
| 7 Admin and billing | Not started |
| 8-10 QA, integrations, production | Not started |

## Integration status (scale from master prompt section 23)

| Integration | Status |
|---|---|
| Cartesia (voice generation) | Selected by founder. Nothing built yet. No credentials. |
| Speech-to-text | Provider not selected |
| Telephony | Provider not selected |
| LLM | Not finalized |
| Payment gateway | Not finalized. Simulated events only until approved |
| Email, error monitoring | Not selected |

No integration is configured, verified or live.

## Test results

Database suite (`scripts/test-db.sh`, PostgreSQL 16.15, fresh database each run): 99 passed, 0 failed.
Application suite (`npm test`, vitest against a fresh PostgreSQL database, connecting as a non-superuser member of rc_app): 56 passed, 0 failed (22 auth, 10 documents, 4 monitoring, 20 clinic application).
Covers: app role is not superuser and cannot read auth tables; no clinic data without a session; password hashing; signup creates clinic, admin, terms record, Dental Pack and audit entry; duplicate email in any case; validation; case-insensitive login; same error for wrong password and unknown email; lockout after 5 failures in 15 minutes; tampered, logged-out and expired sessions; suspended clinic cannot log in and sees no data; reset link is one-time, newest-only, expires, ends old sessions; unknown email sends nothing; invitation sets role preset permissions; staff without manage_staff cannot invite; no cross-clinic invite or deactivation; deactivation ends sessions and blocks login and reset; admin cannot deactivate self.
Browser check (Chrome, phone-sized screen, production build): signup with weak-password error, landing on home with the Dental Pack message, httpOnly session cookie, sign out, protected page redirects, wrong password message, forgot password, reset link, new password login, reused link refused, super admin login. All passed.
Covers: tenant isolation for both clinics and the super admin, clinic kill switch, per-role capabilities and grant/revoke, deactivated users, permanent patient IDs and phone changes, consent status, double-booking prevention, cross-clinic reference rejection, documents, call transcripts (original text immutable, corrections separate), approvals, append-only audit log, workflow copies not changing master templates, idempotent payment events, no revenue-style columns, RLS enabled on every clinic table.
Added: Dental Pack auto-install, copies not changing master, every patient-contacting step needs approval, results counts (simulated excluded, clinic isolation, permission).
Documents tests: type detection by content; disguised, oversized and missing files rejected; fingerprint and audit on upload; failed file write leaves no record; other clinic's patient refused; receptionist uploads but cannot see; doctor opens and access is logged; clinic manager cannot upload; another clinic cannot list or open; signed links reject tampering, expiry and path tricks; files never overwritten.
Live check (production build): health endpoint ok; document open without session 401; with session redirects to a signed link serving the PDF with no-store caching; tampered link 403; audit shows upload and open. Backup and restore round trip verified.
CI passes on GitHub Actions (type check, SQL tests, app tests, build). Not tested yet: the Docker image has not been built here (no Docker in this environment); integrations (none built). Staff invitation and deactivation have no screens yet (Phase 2 user management); they are tested at the service level. The simulated-call dashboards, Needs Attention generation and Results calculations have schema only.
