# INTEGRATION_REQUIREMENTS

Credentials are requested only when the matching phase is ready. Nothing is requested yet.

## Cartesia (selected: voice generation)
- Purpose: receptionist voice (text-to-speech).
- Account: the Startups Grant organization (12 months of the Scale plan: 8M Sonic and Ink credits a month plus $299 a month in Managed Agents credits).
- Credentials needed later: one API key for the development environment. A separate key for staging and production.
- Facts checked in Cartesia's documentation on 2026-11-22: Sonic 3.6 supports 44 languages including Hindi and Kannada. Ink 2 (stable speech-to-text) supports English, French, Hindi, Japanese and Spanish. Kannada is only in the ink-preview model. Zero Data Retention and the India region are Enterprise features. Cartesia's privacy policy says content may be used to train its models unless the organization files the data-controls opt-out. Callers must be told they are speaking to AI and that the conversation is recorded and may be shared with Cartesia and its language-model providers.
- Open questions are in the draft email to Cartesia (founder to send).
- Test procedure (when credentials exist): generate a Hindi, English and Kannada greeting, check latency, confirm opt-out is filed before any real patient audio is sent.

## WhatsApp Business (V2, needs founder action)
- One Meta app for RedClinic (Business verification of Vancore Partners), WhatsApp Business Platform (Cloud API). Each clinic's WhatsApp number is added to RedClinic's WhatsApp Business account (or the clinic's own, shared with RedClinic).
- Submit the templates in `src/lib/whatsapp/templates.ts` with the same names, in English, Hindi and Kannada. `review_request` is Marketing; the rest are Utility.
- Webhook: `https://app.redclinic.in/api/whatsapp/meta` (verify token = `WHATSAPP_VERIFY_TOKEN`), fields `messages`.
- Cost: Meta charges per conversation/template message; check current India rates before setting plan limits (`whatsapp_messages` in plan limits).

## Meta lead ads (V2)
- Same Meta app, permissions `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`; page subscribed to the `leadgen` field.
- Webhook: `https://app.redclinic.in/api/leads/meta` (verify token = `META_VERIFY_TOKEN`).
- Each clinic links its form (page id + form id) in Settings → Lead ads. Recommended form questions: full name, phone number, what they need help with, and a yes/no `whatsapp_opt_in`.

## Jitsi (V2 online consultations)
- Works now with meet.jit.si. For production: a small Jitsi Meet server (Docker) in India on its own subdomain, e.g. `meet.redclinic.in`, then set it in Settings → Online consultations.

## Document reading (V2)
- No outside service. `pdfjs-dist`, `tesseract.js` and the English, Hindi and Kannada language data are npm packages bundled into the build.

## Not selected (adapter interface and simulator only)
Speech-to-text, telephony, LLM, payment gateway, transactional email, error monitoring, object storage. For each, the document will be completed after the founder selects the provider.
