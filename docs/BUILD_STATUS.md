# BUILD_STATUS

Last updated: 2026-11-22. Source of truth for what is actually built and tested.

## Phase status

| Phase | Status |
|---|---|
| 0 Audit | Done (nothing existed; see ARCHITECTURE.md "Audit") |
| 1 Foundation: database, tenancy, permissions | In progress: schema + tests (see below) |
| 1 Foundation: auth, storage, deploy, monitoring | Not started, blocked on app scaffold (KNOWN_ISSUES K1) |
| 2 Clinic application | Not started |
| 3 Product experience (Today, Needs Attention, Results) | Not started |
| 4 NEPA architecture | Not started |
| 5 Voice and AI foundation (simulated calls) | Not started |
| 6 Dental Pack | Not started |
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

See the latest entry in CHANGELOG.md. Only tests that were actually run are listed there.
