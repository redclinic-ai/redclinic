# DECISIONS

Status labels: Locked, Approved, Proposed, Recommended, Unresolved. Recommendations are not decisions.

| ID | Decision | Status |
|---|---|---|
| D1 | Product scope: docs/MASTER_PROMPT.md is the source of truth. Where the earlier build prompt differs (provider names, billing), the final master prompt wins. | Locked (founder) |
| D2 | Providers: only Cartesia is selected. Speech-to-text, telephony, LLM, payments, email are not selected. Build adapters and simulations only. | Locked (founder) |
| D3 | Application stack: TypeScript, Next.js, Supabase-compatible PostgreSQL, modular monolith. | Recommended. Not scaffolded: installs are blocked (K1). |
| D4 | Database access: plain SQL migrations, row-level security, per-transaction context settings. | Approved (engineering) |
| D5 | No clinic revenue, visit value or treatment price fields anywhere. | Locked (founder) |
| D6 | Super admin has full V1 data access through an audited access layer. No restricted mode in V1. | Locked (founder) |
| D7 | V1 collects all data (recordings, transcripts, summaries, assistant logs). No training pipelines in V1. Signup terms and patient consent wording keep the training option open. | Locked (founder) |
| D8 | Billing: internal subscription records and simulated events only. No gateway until approved. | Locked (founder) |
| D9 | Simulated calls are flagged and excluded from real dashboards by default. | Approved (engineering) |

## Conflicts found

- C1: The older build prompt names Exotel, Sarvam, OpenAI and Razorpay as the proposed stack. The final master prompt says they are not selected. Resolution: follow the final master prompt (D2).
- C2: The uploaded copy of the final master prompt (section 17-19) says training data is excluded and collection is limited. The founder later decided to collect all data. The updated copy (`docs/MASTER_PROMPT.md`) follows the founder's later decision (D7).
- C3: The uploaded RedClinic V1 product specification and Dental Pack specification were not supplied to this session. Dental Pack workflow content cannot be built until they are provided. See KNOWN_ISSUES K2.
