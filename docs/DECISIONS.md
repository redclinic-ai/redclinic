# DECISIONS

Status labels: Locked, Approved, Proposed, Recommended, Unresolved. Recommendations are not decisions.

| ID | Decision | Status |
|---|---|---|
| D1 | Product scope: docs/MASTER_PROMPT.md is the source of truth. Where the earlier build prompt differs (provider names, billing), the final master prompt wins. | Locked (founder) |
| D2 | Providers: only Cartesia is selected. Speech-to-text, telephony, LLM, payments, email are not selected. Build adapters and simulations only. | Locked (founder) |
| D3 | Application stack: TypeScript, Next.js, Supabase-compatible PostgreSQL, modular monolith. | Approved (engineering). Scaffolded on Next.js 16 (Next 15 carries open PostCSS advisories) and TypeScript 5 (Next does not support TypeScript 7 yet). |
| D4 | Database access: plain SQL migrations, row-level security, per-transaction context settings. | Approved (engineering) |
| D5 | No clinic revenue, visit value or treatment price fields anywhere. | Locked (founder) |
| D6 | Super admin has full V1 data access through an audited access layer. No restricted mode in V1. | Locked (founder) |
| D7 | V1 collects all data (recordings, transcripts, summaries, assistant logs). No training pipelines in V1. Signup terms and patient consent wording keep the training option open. | Locked (founder) |
| D8 | Billing: internal subscription records and simulated events only. No gateway until approved. | Locked (founder) |
| D10 | Authentication is built in-house: scrypt password hashing (Node standard library), random session tokens stored only as SHA-256 hashes, httpOnly SameSite=Lax cookie, 7-day sessions, 60-minute reset links, 7-day invitation links. Auth tables are reachable only through SECURITY DEFINER functions; the app role cannot read them. No paid auth provider. | Approved (engineering) |
| D11 | Clinics sign up themselves (clinic + clinic admin + terms acceptance in one step). Staff are only created by the clinic admin through invitations. Super admins are created only by an operator script, never through the web. | Approved (engineering) |
| D12 | Documents: file type is decided from file content, not name; limit 15 MB; originals immutable with SHA-256; access only via 5-minute signed links created after a permission check and an audit entry. Storage keys are `clinic/patient/document.ext`. | Approved (engineering) |
| D13 | Deployment is container-based (Dockerfile) so any host works; CI on GitHub Actions; backups with pg_dump before every migration plus the host's own point-in-time recovery; restores go into a new empty database. | Approved (engineering) |
| D14 | Only users with the doctor role can be booked for appointments (existing database rule). Clinic admins who also treat patients need a separate doctor account for now. | Approved (engineering); founder may want admin-doctors later |
| D15 | Duplicate patients are never merged automatically. Registration warns; merge needs the merge_patients permission and an explicit confirmation; the merged record is kept and its code still finds the patient. | Approved (engineering) |
| D16 | Rescheduling cancels the old appointment ("Rescheduled") and books a new one linked to it, so history shows both. | Approved (engineering) |
| D17 | NEPA has no user account. On calls the app sets only the clinic context; NEPA acts through narrow SECURITY DEFINER functions (book, confirm/cancel, find caller, busy times, register caller). Whether NEPA may act is decided by the permission engine in the application before calling them. | Approved (engineering) |
| D18 | Until an LLM is selected, NEPA runs on a deterministic rule-based model, labelled simulated. Safety checks (emergency, medical advice, AI objection) run in code before any model, and must stay first when an LLM adapter is added. | Approved (engineering) |
| D19 | Rescheduling by NEPA always goes to staff (NEPA collects the wish; a person picks the new slot), even if automatic is allowed. | Approved (engineering) |
| D9 | Simulated calls are flagged and excluded from real dashboards by default. | Approved (engineering) |

## Conflicts found

- C1: The older build prompt names Exotel, Sarvam, OpenAI and Razorpay as the proposed stack. The final master prompt says they are not selected. Resolution: follow the final master prompt (D2).
- C2: The uploaded copy of the final master prompt (section 17-19) says training data is excluded and collection is limited. The founder later decided to collect all data. The updated copy (`docs/MASTER_PROMPT.md`) follows the founder's later decision (D7).
- C3: The uploaded RedClinic V1 product specification and Dental Pack specification were not supplied to this session. Dental Pack workflow content cannot be built until they are provided. See KNOWN_ISSUES K2.
- C4: Master prompt section 10 asks to reserve appointment fields for "payment status, fees and secure meeting references", while section 15 forbids any visit value, treatment price or clinic revenue fields. Resolution: only `online_meeting_ref` is reserved. No fee or payment column exists on appointments. The V2 online-consultation design must be reviewed against the no-revenue rule before any fee field is added. Founder to confirm.
- C5: Row-level security trusts the per-transaction context values (`app.user_id`, `app.clinic_id`). Any code that can run SQL as `rc_app` can set them. The application must set them only after authentication and never from request input; NEPA tools must never receive a raw database connection. When hosted on Supabase, replace this with JWT claims.

- C6: The V1 Product Specification (PDF, now docs/PRODUCT_SPEC.md) section 1 says no training flags, pipelines, dashboards or "training-specific consent". The founder later decided (D7) to collect all data in V1 and keep the training option open in the signup terms and patient consent wording. Resolution: no training pipelines, flags, exports or dashboards are built (matches the spec). The consent-wording question is open: D7 is the later decision, so wording keeps the option open, but the founder should confirm this overrides the spec line. Lawyer review needed either way.
- C7: Spec 3.4 asks to reserve "fee, payment" fields on appointments; spec 1 forbids visit value and treatment price. Same as C4. Still only `online_meeting_ref` exists. Founder to confirm that no fee column is wanted until V2.
- C8 (resolved in migration 011): Spec 3.9 lists Results metrics beyond migration 006 (missed calls called back, appointments booked from missed calls, confirmation rate, recall/follow-up calls, visits booked from follow-ups, voice minutes versus plan, no-shows rebooked). Needs call-to-appointment links and follow-up tracking in the schema. Planned, not built.
- C9: Spec 3.2 asks for duplicate detection and controlled merge, CSV import/export, and 3.3 for document access audit logs. Schema has `merged_into` only. Planned, not built.
