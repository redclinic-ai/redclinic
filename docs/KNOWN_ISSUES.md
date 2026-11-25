# KNOWN_ISSUES

## K1: Package installs are blocked: RESOLVED 2026-11-22
npm and pip installs now work in the build environment. The app is scaffolded. (Browser downloads for Playwright are still blocked; the system Chrome is used for browser checks.)

### Original note
The account network setting blocks npm and pip. Next.js, a Postgres driver and test tooling cannot be installed here. Work that needs no packages (SQL migrations, SQL tests, documents) continues.
Needed from the founder: update the network settings to allow package installs, then start a new chat (the current chat may not pick up the change), or run this build in a Claude Code session on the machine with the GitHub repository.

## K2: Product specification and Dental Pack specification not supplied
The master prompt names them as the source of truth for functionality and the Dental Pack workflows. Only the master prompt itself was provided. Needed: the V1 specification file and the Dental Pack workflow specification.

## K3: Master prompt copy provided to the earlier chat was truncated at section 14
Resolved: the complete final master prompt (`docs/MASTER_PROMPT.md`) was used.

- K4: The Dental Pack in migration 005 is an engineering draft, not the founder's specification. Review with a dental professional before any real patient contact. Replace or version it (pack version 2) when the spec arrives.

- K2 update: the V1 Product Specification has now been supplied (docs/PRODUCT_SPEC.md). The separate Dental Pack specification has not; the spec only says the pack includes RCT, braces and recall workflows. K4 still applies.

- K5: Clinic signup terms wording (`src/lib/terms.ts`, version `2026-11-draft-1`) is an engineering draft written from the founder's data-access and training decisions (D6, D7). Needs the founder's legal review before real clinics sign up. The version string is stored with every acceptance, so changed wording can be tracked.
- K6: No email provider is selected (D2). Password reset and staff invitation emails are simulated: printed to the server log, not sent. A real provider is needed before launch; add it behind `EmailAdapter` in `src/lib/email`.
- K7: RESOLVED (Phase 8). Login: 5 failures per email in 15 minutes. Sign-up: 5 per network per hour. Password reset: 3 emails per address and 20 per network per hour. Add edge rate limiting at the host as well.
- K8: Hosting is not chosen. It decides the database host (with automatic backups), the file storage service for documents (S3-compatible: AWS S3 Mumbai, Cloudflare R2 or Supabase Storage) and the domain setup. Patient data should stay in India (ap-south-1 or equivalent). Until then, documents use the local-disk adapter, which suits development and a single server only.
- K9: No error-monitoring provider is chosen. Errors are logged as JSON only. A free tier (for example Sentry) can be added behind `ErrorReporter` in `src/lib/monitoring` once approved.
- K10: In-app assistant voice input waits for a speech-to-text provider (text works now). Browser speech recognition was not used because it sends audio to a third party without a contract.
- K11: The dialler and attention refresh need a scheduler calling `POST /api/cron/dialer` every minute with `CRON_SECRET` (host cron or uptime pinger). Not set up until hosting is chosen (K8).

## V2 (2026-11-25)
- K12: Hindi and Kannada wording of WhatsApp templates (`src/lib/whatsapp/templates.ts`) was written by the engineering team. Have a native speaker check it before patients see it. Template names and wording must also be submitted and approved in the WhatsApp Business account exactly as in the file.
- K13: Skin/hair, physiotherapy and general practice packs (migration 022) are engineering drafts like the Dental Pack (K4). Review with a practising professional before real patients.
- K14: Online consultations default to the public meet.jit.si service (free, run by Jitsi's company). For real patients, run RedClinic's own Jitsi server in India and set its domain in Settings → Online consultations.
- K15: WhatsApp Cloud API and Meta lead-ads adapters are written to Meta's documented formats but not verified: no Meta app or WhatsApp Business account yet. They switch on only with their keys and WHATSAPP_VERIFIED / META_LEADS_VERIFIED set after a live test.
- K16: Document suggestions use rules. They read typed prescriptions and lab reports well; handwriting is not read reliably. Doctors confirm every item. An AI extractor can be added behind the same interface once an AI provider is approved.
- K17: Document reading runs when a person asks ("Read into record"), not automatically on upload; OCR of a photo takes a few seconds on the KVM 1 server.
