# V3_PROPOSAL

Status: proposed 2026-11-25, waiting for the founder's approval. Not built. The founder-facing version is the
"RedClinic V3 proposal" doc (https://claude.ai/artifact/Rxg1Bp6zpG1zmktyKxnfEK); this file is the engineering copy.

Goal: from pilot clinics to thousands.

| # | Theme | Depends on | Size |
|---|---|---|---|
| 1 | AI brain: LLM conversation model behind `ConversationModel`, assistant answers with record evidence, handwriting extraction behind `TextExtractor`, better summaries. Safety layer, permissions and approvals unchanged | AI provider (India data residency, no training on patient data) | L |
| 2 | More languages: Tamil, Telugu, Marathi, Malayalam, Bengali for calls and WhatsApp | Cartesia + speech-to-text; native review | M |
| 3 | Diagnostic centres: test catalogue, collection slots incl. home collection, report-ready WhatsApp with secure link, out-of-range follow-ups | — | M |
| 4 | Chains: organisations with branches, shared patient IDs, branch routing and reports | — | M |
| 5 | ABDM (ABHA create/link, consent-based record sharing) and DPDP data-principal requests | NHA sandbox approval, legal advice | L |
| 6 | Booking without a call: clinic booking page, website widget, full WhatsApp booking/reschedule/cancel | WhatsApp live | M |
| 7 | Self-serve growth: number provisioning, real payment gateway, partner/reseller logins, sales CRM joined to admin | Phone provider, payment gateway | L |
| 8 | Smarter follow-ups: rule-based no-show risk, opt-in recall campaigns with frequency caps, anonymised benchmarks (patients, never money) | Pilot data | M |
| 9 | Security and scale: managed Postgres with PITR, India object storage, read replicas, external pen test, ISO 27001 groundwork | Hosting budget | M |

Suggested order: 1+2, then 6+3, then 7+9, then 4, 8, 5.
Not in V3: clinic payments or revenue, a patient mobile app, hospital features (wards, pharmacy stock, insurance claims).
