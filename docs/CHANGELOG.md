# CHANGELOG

## 2026-11-22
- Created repository, project documents.
- Migrations 001-004: tenancy, users, capabilities, patients, consent, appointments, documents, calls, transcripts, approvals, attention items, workflow packs, packages, subscriptions, usage, audit; cross-clinic reference guard.
- DB test suite added: 87 passing. Found and fixed a cross-tenant reference hole (migration 004).

## 2026-11-23
- Added the marketing website in `website/` (home, NEPA, platform, security, demo, privacy). Demo requests stored through a file or PostgREST adapter. See website/docs/WEBSITE_STATUS.md.
