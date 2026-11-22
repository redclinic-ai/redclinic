# CHANGELOG

## 2026-11-22 (night): Phase 3
- Migration 011: call purpose and links (callback_of, appointment, workflow), appointment source call, attention de-duplication and auto-generation, Results v2 with every spec metric, clinic phone numbers table.
- Screens: Today (with setup checklist), Needs attention, Results.

## 2026-11-22 (night): Phase 2
- Migration 010: clinic profile fields, services, FAQs, consent wordings, new capabilities (manage_settings, merge_patients, import_patients, record_consent), duplicate finder, patient merge, consent withdrawal alert, staff permission caps.
- Screens: settings (clinic, services, FAQs, consent, staff), patients (list, new, page, edit, import, export), appointments (day view, book, walk-in, appointment page).
- Fixed in browser testing: "Save and book" ignored; settings pages visible by URL to staff without permission.

## 2026-11-22 (evening)
- Private document storage (migration 009): upload, list, open with signed links, audit on upload and open.
- CI workflow, Dockerfile, backup and restore scripts.
- Monitoring: health endpoint, JSON logs with redaction, central error reporting hook.
- 36 application tests, 99 SQL tests passing.

## 2026-11-22 (later)
- Package installs confirmed working (K1 resolved).
- App scaffold: Next.js 16, TypeScript 5, pg, zod, vitest. Security headers on.
- Migration 008: authentication (credentials, sessions, reset/invitation tokens, login attempts, clinic signup function, sessions end on deactivation).
- Auth service and screens: sign up, sign in, sign out, forgot password, choose password; placeholder home.
- Super admin creation script. 22 application tests passing; 99 SQL tests still passing.

## 2026-11-22
- Created repository, project documents.
- Migrations 001-004: tenancy, users, capabilities, patients, consent, appointments, documents, calls, transcripts, approvals, attention items, workflow packs, packages, subscriptions, usage, audit; cross-clinic reference guard.
- DB test suite added: 87 passing. Found and fixed a cross-tenant reference hole (migration 004).
