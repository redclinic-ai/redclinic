# BUILD_STATUS

Last updated: 2026-11-22. Source of truth for what is actually built and tested.

## Phase status

| Phase | Status |
|---|---|
| 0 Audit | Done (nothing existed; see ARCHITECTURE.md "Audit") |
| 1 Foundation: database, tenancy, permissions | Schema and tests done (migrations 001-007, 99 SQL tests passing on PostgreSQL 16). No application code yet |
| 1 Foundation: app scaffold | Done. Next.js 16 + TypeScript, `pg`, zod, vitest. Builds cleanly; 0 npm audit findings |
| 1 Foundation: authentication | Done and tested (migration 008, `src/lib/auth`). Clinic signup with terms acceptance, login, 7-day sessions, sign out, forgot/reset password, staff invitation links, deactivation, super admin creation script. Emails are simulated (no provider selected) |
| 1 Foundation: storage, deploy environments, monitoring | Not started (next) |
| 2 Clinic application | Not started |
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
Application suite (`npm test`, vitest against a fresh PostgreSQL database, connecting as a non-superuser member of rc_app): 22 passed, 0 failed.
Covers: app role is not superuser and cannot read auth tables; no clinic data without a session; password hashing; signup creates clinic, admin, terms record, Dental Pack and audit entry; duplicate email in any case; validation; case-insensitive login; same error for wrong password and unknown email; lockout after 5 failures in 15 minutes; tampered, logged-out and expired sessions; suspended clinic cannot log in and sees no data; reset link is one-time, newest-only, expires, ends old sessions; unknown email sends nothing; invitation sets role preset permissions; staff without manage_staff cannot invite; no cross-clinic invite or deactivation; deactivation ends sessions and blocks login and reset; admin cannot deactivate self.
Browser check (Chrome, phone-sized screen, production build): signup with weak-password error, landing on home with the Dental Pack message, httpOnly session cookie, sign out, protected page redirects, wrong password message, forgot password, reset link, new password login, reused link refused, super admin login. All passed.
Covers: tenant isolation for both clinics and the super admin, clinic kill switch, per-role capabilities and grant/revoke, deactivated users, permanent patient IDs and phone changes, consent status, double-booking prevention, cross-clinic reference rejection, documents, call transcripts (original text immutable, corrections separate), approvals, append-only audit log, workflow copies not changing master templates, idempotent payment events, no revenue-style columns, RLS enabled on every clinic table.
Added: Dental Pack auto-install, copies not changing master, every patient-contacting step needs approval, results counts (simulated excluded, clinic isolation, permission).
Not tested yet: file storage, deployment, monitoring, integrations (none built). Staff invitation and deactivation have no screens yet (Phase 2 user management); they are tested at the service level. The simulated-call dashboards, Needs Attention generation and Results calculations have schema only.
