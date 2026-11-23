# CHANGELOG

## 2026-11-23: Phase 8
- Migrations 016 (rate limits) and 017 (RLS once per query, indexes). JIT off for app connections.
- Security fixes: open redirect, test-call guard, sign-up/reset rate limits, no reset links in production logs, CSP and HSTS.
- Accessibility scan (0 violations on 54 screens), performance work (all screens under 150 ms at clinic scale), load test.
- Added demo seed script, browser smoke test (`npm run smoke`), favicon, QA_REPORT.md.

## 2026-11-23: Phase 7
- Migration 015: plan prices and limits, subscription lifecycle fields, invoices, usage alerts, entitlements, trials, kill switch details, admin overview, feature switches; attention de-duplication covers items without a patient.
- Billing service, payment webhook, admin service; screens: admin clinics, clinic detail, plans, audit log, system; clinic Plan & usage.
- Plan limits enforced in calls, outgoing queue, staff invitations, agents and the assistant.

## 2026-11-23: Phase 6
- Migration 014: workflow format 2, Core pack v1, Dental Pack v2, clinic workflow versions, master-update offers, workflow runs, engine helper functions; after-treatment check-in conversation.
- Workflow engine (runs with the dialler), workflow service, Workflows screens (list, editor, history, runs, new).

## 2026-11-22 (night): Phase 5
- Migration 013: call fields (agent, provider ids, recording, transcription attempts, test calls), telephony events, outbound queue, NEPA patient brief, approvals sync, active clinics; split calls write policy (security fix).
- Calls service, provider adapters (incl. Cartesia), telephony webhook, cron dialler, assistant, phone setup. Screens: calls, call record, test call, assistant, phone number.
- Found by tests/browser: NEPA could not read patients or approvals during dialling; switched-off agents left calls open; assistant questions were in the URL.

## 2026-11-22 (night): Phase 4
- Migration 012: global policies with versions/tests, NEPA agents, versioned configuration, approvals extensions, assistant interactions, NEPA database functions.
- NEPA modules: permissions, config, policies, resolver, tools, approvals, engine, simulator. Screens: AI receptionist studio, agents, test, approvals, admin policies.
- Found by tests: "Is this swelling an infection?" was not treated as a medical question; fixed.

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
