# ARCHITECTURE

## Audit (Phase 0)

Inspected on 2026-11-22: the working environment for this session.

- GitHub repository: none attached to this session. A new local git repository was created.
- Frontend, backend, schema, auth, hosting, domain/DNS, integrations, secrets, UI assets, tests: none exist.
- Marketing website: `website/` (added 2026-11-23). Static pages plus a small Node server for demo requests. Independent of the application: no shared code, tables or credentials. See website/README.md.
- Tools available in the build environment: Node 22, Python 3.13 (Flask, Starlette, pydantic, pytest, PyJWT), PostgreSQL 16 client and server. Package installs (npm, pip) are blocked by the account network setting. See KNOWN_ISSUES K1.

Result: this is a new build. There is nothing to preserve.

## Principles

Modular monolith, strict tenancy, backend-enforced permissions, provider-independent adapters, no clinic revenue data anywhere, simulated calls clearly labelled.

## Layers

1. **Database (PostgreSQL, Supabase-compatible).** Source of truth. Plain versioned SQL migrations in `db/migrations`. Row-level security on every clinic-owned table.
2. **Application (modular monolith).** Modules: tenancy, auth, permissions, patients, appointments, documents, calls, nepa, workflows, approvals, attention, results, billing, admin, audit. Each module owns its tables.
3. **Provider adapters.** Interfaces for LLM, speech-to-text, text-to-speech, telephony, recording, payments, email, storage. Each has a simulated implementation. Cartesia is the first real text-to-speech adapter, not yet built.
4. **Frontend.** Mobile-first, one design system, role-aware navigation.

## Tenant isolation

- Every clinic-owned table has `clinic_id NOT NULL`.
- The application connects as a non-superuser role and sets `app.clinic_id`, `app.user_id` and `app.is_super_admin` per transaction (`rc_set_context`). Row-level security policies compare `clinic_id` with `app.clinic_id`.
- The super admin sees all clinics only through the policy that checks `app.is_super_admin`, and every such read must go through the application access layer, which writes to `audit_log`.
- Clinic suspension (kill switch): `clinics.status = 'suspended'` makes every clinic-scoped policy return nothing.

## Permissions

- Capabilities are named strings (for example `view_patient_history`). Role presets live in `role_presets` as defaults.
- A staff member's effective capabilities are stored in `staff_capabilities`, set by the clinic admin. The super admin's per-clinic feature switches (`clinic_features`) cap what a clinic admin can grant.
- The database function `rc_has_capability(cap)` is used inside policies for clinical data. The application checks the same capability before every sensitive action.

## NEPA (planned)

Three configuration layers resolved at runtime by a resolver that records the versions used per interaction: global policies, clinic configuration, agent configuration. Backend tools only. No arbitrary SQL. Approval modes: suggest, approval required, automatic (per workflow, explicitly enabled).

## Simulated calls

A `calls.is_simulated` flag is set on every simulated call. Dashboards and the Needs Attention list exclude simulated calls by default and label them when shown.

## Not decided yet

Application framework and hosting. See DECISIONS.md D3.
