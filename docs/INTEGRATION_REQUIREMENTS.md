# INTEGRATION_REQUIREMENTS

Credentials are requested only when the matching phase is ready. Nothing is requested yet.

## Cartesia (selected: voice generation)
- Purpose: receptionist voice (text-to-speech).
- Account: the Startups Grant organization (12 months of the Scale plan: 8M Sonic and Ink credits a month plus $299 a month in Managed Agents credits).
- Credentials needed later: one API key for the development environment. A separate key for staging and production.
- Facts checked in Cartesia's documentation on 2026-11-22: Sonic 3.6 supports 44 languages including Hindi and Kannada. Ink 2 (stable speech-to-text) supports English, French, Hindi, Japanese and Spanish. Kannada is only in the ink-preview model. Zero Data Retention and the India region are Enterprise features. Cartesia's privacy policy says content may be used to train its models unless the organization files the data-controls opt-out. Callers must be told they are speaking to AI and that the conversation is recorded and may be shared with Cartesia and its language-model providers.
- Open questions are in the draft email to Cartesia (founder to send).
- Test procedure (when credentials exist): generate a Hindi, English and Kannada greeting, check latency, confirm opt-out is filed before any real patient audio is sent.

## Not selected (adapter interface and simulator only)
Speech-to-text, telephony, LLM, payment gateway, transactional email, error monitoring, object storage. For each, the document will be completed after the founder selects the provider.
