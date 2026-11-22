# BUILD_STATUS

Last updated: 2026-11-22. Source of truth for what is actually built and tested.

## Phase status

| Phase | Status |
|---|---|
| 0 Audit | Done (nothing existed; see ARCHITECTURE.md "Audit") |
| 1 Foundation: database, tenancy, permissions | Schema and tests done (migrations 001-006, 98 SQL tests passing on PostgreSQL 16). No application code yet |
| 1 Foundation: auth, storage, deploy, monitoring | Not started, blocked on app scaffold (KNOWN_ISSUES K1) |
| 2 Clinic application | Not started |
| 3 Product experience (Today, Needs Attention, Results) | Results counts function done and tested (migration 006). No UI yet |
| 4 NEPA architecture | Not started |
| 5 Voice and AI foundation (simulated calls) | Not started |
| 6 Dental Pack | Draft only: 7 workflows written by engineering (migration 005), marked `draft`, auto-copied to new dental clinics, automatic mode off. Founder spec still needed (K2) |
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

Database suite (`scripts/test-db.sh`, PostgreSQL 16.15, fresh database each run): 98 passed, 0 failed.
Covers: tenant isolation for both clinics and the super admin, clinic kill switch, per-role capabilities and grant/revoke, deactivated users, permanent patient IDs and phone changes, consent status, double-booking prevention, cross-clinic reference rejection, documents, call transcripts (original text immutable, corrections separate), approvals, append-only audit log, workflow copies not changing master templates, idempotent payment events, no revenue-style columns, RLS enabled on every clinic table.
Added: Dental Pack auto-install, copies not changing master, every patient-contacting step needs approval, results counts (simulated excluded, clinic isolation, permission).
Not tested: anything outside the database. No application, API, UI, auth, storage or integration exists yet. The simulated-call dashboards, Needs Attention generation and Results calculations have schema only.
