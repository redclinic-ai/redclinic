# HANDOVER

For a developer picking up RedClinic. Read in this order: PRODUCT_SPEC.md → this file → ARCHITECTURE.md → DECISIONS.md → KNOWN_ISSUES.md.

## Run it locally
```bash
npm ci
cp .env.example .env.local        # fill DATABASE_URL etc.
./scripts/migrate.sh              # applies db/migrations in order
npx tsx scripts/create-super-admin.mts
npx tsx scripts/seed-demo.mts     # optional demo clinic
npm run dev
```
Tests: `npm run test:db` (SQL, needs PostgreSQL 16), `npm test` (app), `npm run smoke` (browser, needs Chrome and a running server).

## How the code is laid out
- `db/migrations/NNN_*.sql` — the whole schema, plain SQL, one file per phase. Never edit an applied migration; add a new one.
- `src/lib/<area>/service.ts` — all business logic. Each function takes a database client already set to the user's context.
- `src/app/(app)/...` — screens (server components) and `actions.ts` (server actions that call services).
- `src/app/api/...` — health, file links, exports, provider webhooks, scheduler.
- `src/lib/providers/index.ts` — every outside vendor behind an interface, with a simulated version. Add a vendor by writing one class and one line in the `get…()` chooser.

## Rules that keep it safe
1. **Every query runs under row-level security.** Use `withContext(actor, fn)`. The app role cannot bypass RLS. If something “can't see” data, fix the policy or add a narrow `SECURITY DEFINER` function, never a superuser connection.
2. **Policies call context functions inside sub-selects**: `(SELECT rc_clinic_id())`. A test fails otherwise (performance, D25).
3. **Permissions**: `requireCap(c, "capability")` in services, `requirePageCap()` in pages. Capabilities live in the database.
4. **NEPA never writes SQL.** It runs with no user and acts only through `rc_nepa_*` / `rc_wf_*` functions.
5. **Strictest permission wins** across global policy, clinic and agent settings. Outgoing calls happen only through an automatic workflow or an approval.
6. **No clinic money.** RedClinic never stores clinic fees or revenue; a test enforces it. Only RedClinic's own subscription billing has amounts (paise, GST shown separately).
7. **Audit** anything a person would ask “who did this?” about: `audit(c, action, entity, id, details)`.
8. **Simulated data** is flagged and hidden from Results unless chosen.

## Where things stand
See BUILD_STATUS.md. All ten phases are built as far as they can go without outside accounts. What remains is listed in PRODUCTION_CHECKLIST.md §1. Open issues: KNOWN_ISSUES.md.

## Founder decisions to respect
- Confirmation call 2–3 hours before; no-show: call at appointment time and ~5–6 hours later, then stop and tell staff.
- V1: incoming and outgoing calls. WhatsApp is V2.
- Cartesia for voice. Keep vendors swappable; prefer open-source and low-cost.
- Pricing figures are planning only.
