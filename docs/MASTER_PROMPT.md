# REDCLINIC — MASTER PRODUCT DEVELOPMENT, INTEGRATION, TESTING & PRODUCTION DEPLOYMENT INSTRUCTION

**Product:** RedClinic  
**Tagline:** AI for Modern Clinics  
**Initial market:** Dental clinics in India  
**AI assistant:** NEPA  
**Development owner:** Claude Code  
**Product owner:** Founder  
**Objective:** Build, integrate, test and deploy a complete, commercially usable clinic-management and AI receptionist platform.

---

# 1. YOUR ROLE

Act as the complete technical team responsible for RedClinic: CTO, principal architect, senior frontend and backend engineers, database architect, AI engineer, UI/UX designer, DevOps engineer, security engineer, QA lead and deployment owner.

Approach this as an experienced professional product-development team building a commercial SaaS product for real clinics.

The founder owns product direction and commercial decisions. You own technical execution and engineering decisions. Use engineering judgment for architecture, component structure, database design, workflows, UI placement, navigation, interaction patterns and implementation sequence. Ask the founder only when a decision genuinely requires business approval, credentials, payment authorization or an important product decision.

**Your mission is not to produce a plan. Your mission is to build the product.**

# 2. SOURCE OF TRUTH AND PRODUCT REQUIREMENTS

The supplied RedClinic V1 product specification and Dental Pack workflow specification are the source of truth for product functionality. This master prompt adds development strategy, architecture, UI/UX expectations, integration rules and execution responsibilities.

Before development:
1. Inspect the existing repository.
2. Read all supplied product specifications.
3. Inspect existing application functionality.
4. Identify conflicts, missing requirements and technical dependencies.
5. Preserve existing working functionality.
6. Consolidate requirements into `PRODUCT_SPEC.md`.
7. Record approved decisions in `DECISIONS.md`.

Do not silently remove or simplify an approved feature. If an older instruction conflicts with this final master prompt, follow this final master prompt. If the supplied product specification conflicts with it, identify the conflict and ask for a decision rather than silently changing the product.

# 3. NON-NEGOTIABLE UI/UX REQUIREMENTS

RedClinic must look and feel like a professionally designed, premium, modern SaaS product. It is being designed for clinic owners, doctors, receptionists and administrative staff, many of whom may have very limited technical experience.

**The interface must be understandable to a non-technical user without requiring training.**

## 3.1 Design philosophy

Use a minimal, premium, clean, modern, professional, trustworthy, calm, fast, easy-to-understand, mobile-friendly and consistent design.

Avoid cluttered dashboards, excessive cards, unnecessary animations, too many navigation options, technical terminology, complicated forms, dense tables, unnecessary popups, hidden essential actions and decorative elements that reduce usability.

Use whitespace, clear typography, strong visual hierarchy, restrained colors and consistent spacing. Do not make the interface look like a generic admin template.

## 3.2 You own the UX decisions

The founder is not prescribing exact screen placement. You must decide navigation structure, sidebar or top navigation, dashboard hierarchy, screen layouts, button placement, form structure, modal and drawer usage, mobile navigation, information density, empty/loading/error states, onboarding, interaction patterns, component design and responsive behavior.

Make these decisions based on the best possible user experience for the actual users. Do not ask the founder to choose the placement of ordinary UI elements.

If a screen is confusing, redesign it. If a workflow requires too many clicks, simplify it. If a receptionist cannot understand an action immediately, improve the wording and interaction.

## 3.3 Simplicity for non-technical users

A receptionist should immediately understand what needs attention today. Registering a patient, booking an appointment, finding a patient, uploading a prescription, reviewing a call and approving an AI action should all be straightforward.

Use simple labels. Prefer "Patients" over technical database terminology and "Needs your attention" over internal workflow terminology.

Use clear actions such as Add patient, Book appointment, Call patient, View history, Upload document, Approve, Reject and Mark complete.

## 3.4 Forms and onboarding

Keep forms short and logical. Use progressive disclosure: show only information needed at the current step. Use sensible defaults, validate fields appropriately, explain errors in plain language and avoid asking for information the platform already has.

Build guided clinic onboarding. Do not overwhelm a new clinic with every setting at signup.

## 3.5 Dashboard experience

The dashboard should answer:
1. What is happening today?
2. What needs my attention?
3. What has RedClinic completed?

Prioritize operational information over decorative analytics. The Needs Attention list should have a prominent position in the receptionist experience. Clinic owners should understand activity and usage quickly.

## 3.6 Design consistency

Create a reusable design system defining typography, color palette, spacing, borders, shadows, buttons, inputs, dropdowns, cards, tables, status indicators, navigation, icons, responsive breakpoints and interaction states.

Use reusable components rather than implementing each screen independently.

## 3.7 Responsive design and accessibility

The application must work properly on desktop, laptops, tablets, Android phones and mobile browsers. Do not simply shrink the desktop interface; redesign layouts where necessary.

Use readable font sizes, adequate contrast, clear labels, keyboard accessibility, visible focus states, understandable error messages, consistent navigation and appropriate touch-target sizes.

Test workflows from the perspective of a first-time receptionist.

**Acceptance requirement:** A non-technical receptionist should be able to perform basic tasks without needing an explanation from a developer.

# 4. TECHNICAL ARCHITECTURE

Build a modular, maintainable and scalable application with multi-tenancy, strict clinic-level data isolation, backend-enforced permissions, versioned APIs, database migrations, replaceable service providers, private file storage, audit logs, background job support, error handling, monitoring, secure authentication, backup and recovery.

Design initially for at least 100 clinics and 1,000 staff accounts.

Avoid premature microservices. Use a modular monolith unless the existing architecture justifies another approach. Do not introduce unnecessary infrastructure or complexity.

# 5. NEPA — GLOBAL INTELLIGENCE AND CLINIC CONFIGURATION

This is mandatory. NEPA must not be implemented as one giant hardcoded prompt. Build a structured, configurable AI system.

## 5.1 Layer 1 — RedClinic Global Intelligence

RedClinic centrally controls mandatory policies, behavior, safety rules and operating standards. These apply to every NEPA agent across all clinics.

Examples:
- Identify itself transparently as an AI assistant.
- Communicate professionally and naturally.
- Follow permitted language settings.
- Never invent clinic information or doctor availability.
- Never fabricate patient history.
- Respect patient privacy and user permissions.
- Never diagnose or prescribe.
- Escalate emergencies and out-of-scope situations.
- Follow consent and recording requirements.
- Never perform unauthorized actions.
- Never claim an action succeeded without backend confirmation.

These are examples, not an exhaustive list.

Build a Global Policy Manager supporting policy creation, editing, versioning, mandatory and optional classification, activation/deactivation, effective dates, testing, rollback and change history.

Clinics cannot override mandatory global policies.

## 5.2 Layer 2 — Clinic Configuration

Each clinic has its own isolated configuration.

**Clinic information:** name, location, contact details, working hours, doctors, staff, services, treatments and languages.

**Clinic knowledge:** FAQs, doctor profiles, approved treatment and clinic information, appointment policies and clinic-specific instructions.

**Communication:** greeting, tone, personality, preferred language, language switching, conversation style and approved scripts.

**Workflows:** new patient enquiry, appointment requests, confirmation, rescheduling, cancellation, follow-up, reminders, missed-call handling and staff escalation.

**Permissions:** automatic actions, approval-required actions and prohibited actions.

Clinic settings must never override mandatory global policies.

## 5.3 Individual Agent Configuration

A clinic may have multiple NEPA agents, for example Receptionist Agent, Lead Follow-up Agent, Appointment Reminder Agent and Feedback Agent.

Each agent supports name and identity, objective, role, voice, language, personality, scripts, knowledge scope, workflows, operating hours, permissions and escalation rules.

Each agent inherits global and clinic configurations.

## 5.4 Instruction priority

Enforce:
1. Applicable legal, privacy and safety requirements.
2. RedClinic global mandatory policies.
3. Clinic configuration.
4. Individual agent configuration.
5. Patient conversation and requests.

Higher-priority instructions always win.

## 5.5 Runtime Instruction Resolver

Build a runtime resolver that assembles active global policies, clinic configuration, individual agent configuration, relevant approved knowledge, workflow rules, permission rules and conversation context.

Use structured, versioned data. Detect configuration conflicts. Track the versions used for each interaction.

## 5.6 Voice Agent Configuration Studio

Build the architecture for administrators to configure agents without writing code. Include Agent Profiles, Script Manager, Knowledge Manager, Workflow Manager, Permission Manager, Testing Simulator, Version History, Publish and Rollback.

Start with controlled templates and simple settings. Do not build an unnecessarily complicated unrestricted automation builder in V1.

## 5.7 Backend enforcement

Never depend only on the LLM following instructions. Backend code must enforce tenant isolation, user permissions, agent permissions, tool access, approval requirements, restricted operations and workflow conditions.

NEPA must never receive unrestricted database access or arbitrary SQL execution.

# 6. USER ROLES AND ACCESS

Build five roles.

## Super Admin

The RedClinic founder.

V1 Super Admin can access all platform and clinic data, including clinic profiles, patient records, documents, appointments, calls, recordings, transcripts, summaries, usage and audit logs.

Implement this through a centralized backend access layer. Log Super Admin access, including who accessed what and when.

Do not build restricted Super Admin access mode as a V1 requirement. Keep the architecture extensible for V2 access restrictions.

Super Admin capabilities:
- Create, view, suspend and reactivate clinics.
- Manage packages.
- Configure feature availability and usage limits.
- View usage and integration status.
- Manage subscriptions and package assignments.
- View system health.
- Monitor errors and audit logs.

Suspending a clinic must work as a platform-level kill switch.

## Clinic Admin

Full control of one clinic: invite and manage staff, assign permissions, manage clinic configuration, NEPA agents, workflows and approvals, view patients and documents, manage appointments, view audit logs and manage billing and usage.

## Doctor

Own schedule, permitted patient access, patient history, documents, call summaries, consultation notes drafted by NEPA and personal assistant. Cannot access other doctors' restricted data without permission.

## Receptionist

Today screen, Needs Attention list, patient registration, appointments, calls, document uploads and permitted approval actions. Clinical history access is restricted unless explicitly granted.

## Clinic Manager

Daily operations, receptionist schedules, appointments, Needs Attention list, approval queue, Results dashboard, usage and reports, and workflow editing when authorized. No billing or unrestricted clinical-history access by default.

## Permission model

Implement granular capabilities, including:
- `view_patient_history`
- `edit_patient`
- `upload_document`
- `view_documents`
- `manage_appointments`
- `edit_workflow`
- `approve_actions`
- `export_data`
- `manage_staff`
- `view_audit_log`

Role presets are starting points. Clinic admins control staff permissions, subject to platform feature limits. Every sensitive action must be checked in the backend. Every permission change must be audit-logged.

# 7. CLINIC WORKSPACE

Build clinic registration, profile, clinic type, location, contact details, working hours, doctor management, staff management, invitations, clinic settings, integration configuration, workflow configuration and NEPA configuration.

Make onboarding simple and guided. Dental clinics must automatically receive the Dental Pack.

# 8. PATIENT CRM

Every patient receives a permanent internal unique patient ID. Phone number must never be used as the permanent patient identity.

Patient information: name, phone, email, date of birth or age, gender and address where supplied, basic medical history, allergies, notes, registration date, assigned doctor and consent status.

Features:
- Create and edit patients.
- Search and filter.
- Patient history.
- Appointment, call, document and communication history.
- Duplicate detection.
- Controlled record merging.
- Walk-in registration.
- CSV import and export with permissions.

Changing a phone number must not change the patient ID.

# 9. MEDICAL DOCUMENT MANAGEMENT

Authorized clinic staff can upload prescriptions, reports, PDFs, JPG and PNG images, other approved files, and manual notes/descriptions.

Requirements:
- Associate documents with patients.
- Store clinic and patient IDs.
- Store document type, uploader and timestamp.
- Preserve original files.
- Private storage.
- Time-limited signed URLs.
- Authorization checks.
- Audit logs.

Do not implement full OCR or structured extraction as a V1 requirement. Keep the architecture ready for V2.

# 10. APPOINTMENT MANAGEMENT

Build create, edit, reschedule and cancel; patient and doctor association; date, time, duration and status; calendar and daily appointment list; completed and no-show status; appointment history.

Prevent conflicting bookings.

Support in-clinic and online appointment types. Reserve architecture fields for online consultation, payment status, fees and secure meeting references. Full online consultation is V2.

# 11. NEPA VOICE RECEPTIONIST

Build the complete voice-agent architecture.

Capabilities:
- Inbound and outbound calls.
- Answer approved clinic FAQs.
- Capture patient details and intent.
- Assist with appointment requests.
- Transfer or escalate to staff.
- Handle missed calls.
- Approved reminders and follow-ups.

Initial languages: Hindi, English and Kannada. Keep the architecture expandable to other Indian languages and dialects.

Every AI-handled call must have a call record containing call ID, clinic ID, patient association where reliably identified, caller number, direction, start/end time, duration, status, recording reference where permitted, transcript, transcription status, speaker labels, summary, intent, outcome, follow-up and actions executed.

Transcripts are mandatory wherever technically possible. If transcription fails, record the failure, track status, support retry, preserve original audio where permitted and never fabricate a transcript.

Keep original transcription output and human corrections separately. Store recordings privately with controlled access.

NEPA must disclose AI handling and recording as required. If the caller objects, follow the approved staff-handoff procedure.

# 12. NEPA IN-APP ASSISTANT

Support text and voice.

Capabilities:
- Search authorized patients.
- Retrieve patient history.
- Summarize records.
- Retrieve documents and appointments.
- Summarize calls.
- Identify missed appointments.
- Draft consultation notes.
- Prepare follow-ups.
- Execute authorized workflows.

Requirements:
- Controlled backend tools.
- Source-linked answers.
- Clear distinction between verified and unavailable information.
- No fabricated patient history.
- No unauthorized data access.
- No arbitrary SQL.
- No autonomous diagnosis, prescribing or independent treatment recommendations.

Every sensitive action must pass backend authorization.

# 13. PERMISSIONS AND APPROVALS

Support three modes.

**Suggest:** NEPA suggests an action; a human executes it.

**Approval required:** NEPA prepares an action and waits for an authorized person.

**Automatic:** The action executes only when the clinic admin explicitly enables that exact workflow.

Default behavior:
- Search and retrieval: permitted within role access.
- Summaries: permitted within role access.
- Draft notes: according to configured permissions.
- Patient-record changes: approval required.
- Booking, cancellation and rescheduling: approval required unless explicitly authorized.
- Outbound calls: require approved workflow authorization.
- Reminders: automatic only when enabled.
- Deletion: explicit authorization.

Build approval queue, approve/reject, approver identity, timestamp, action details, execution status, failure details and audit history.

NEPA must not silently acquire permissions.

# 14. NEEDS ATTENTION LIST

Build a prominent Needs Attention list on the Today screen.

Include:
- Calls NEPA could not complete.
- Calls handed over to staff.
- Unanswered caller questions.
- Complaints.
- Reschedule and cancellation requests awaiting approval.
- Unconfirmed appointments.
- No-shows with completed follow-ups but no rebooking.
- Failed outbound calls.
- Pending approvals.
- Failed workflows.

Each item must show who, what happened, why attention is needed, time and one clear next action.

Actions: Call back, Approve, Reschedule, Mark done.

Link to the relevant patient and call transcript where permitted.

Order urgent items first, then oldest first. Support assignment, resolution and snoozing. All actions must be audit-logged. Resolved items leave the active list but remain searchable. Support mobile and desktop.

Show a count badge on the Today screen and in the navigation.

Update the list in real time, without the user refreshing the page.

Apply tenant isolation and role permissions: users see only their own clinic's items, and only the patient and call links they are permitted to open.

Empty state: "Nothing needs your attention."

# 15. RESULTS DASHBOARD

Build a counts-only dashboard with periods Today, Last 7 days and Last 30 days.

Metrics:
- Calls answered.
- Calls handled by NEPA without staff.
- Missed calls called back.
- Appointments booked from missed calls.
- Appointments booked by NEPA.
- Confirmation rate.
- No-shows.
- No-shows rebooked.
- Recall and follow-up calls.
- Visits booked from follow-ups.
- Voice minutes used against the plan.

All numbers must come from actual records. No placeholders. Provide calculation explanations and exportable reports.

New-clinic empty state: "Results appear after your first calls."

## Platform-wide no-revenue rule

Do not calculate, estimate, store, display or mention clinic revenue, money recovered, visit value, treatment price or clinic income anywhere in the platform.

Do not create database fields or analytics for clinic revenue.

The only money-related functionality in the platform is RedClinic's own subscription billing.

If asked about clinic revenue, NEPA must explain that RedClinic does not track it.

# 16. DENTAL PACK AND FUTURE SPECIALTIES

Automatically select the Dental Pack when a dental clinic registers.

Include the approved Dental Pack workflows from the supplied product specification, including applicable treatment workflows such as root canal, braces and recall.

Create editable copies of master templates for each clinic. Clinic admins can change number of calls, timing, scripts and workflow steps, disable workflows and add workflows.

Clinic edits must never change the master template. Master template updates must not silently overwrite clinic edits.

After signup display: "Dental workflows are ready. Review and edit them in Workflows."

Architecture must support other clinic specialties through data-driven workflow packs.

Support:
- `clinic_type`
- `workflow_pack`
- `pack_version`
- `workflow_template`
- `clinic_workflow`

Build Dental Pack now. Prepare the structure for additional specialties without implementing them all in V1.

# 17. DATA COLLECTION AND DATA MANAGEMENT

For V1, collect and store all data the platform handles, from A to Z, so that later decisions on use, training, retention and access can be made from complete data. This is a founder decision: collect everything now and decide later what to use or stop.

Collect and keep, at minimum: call audio recordings (where the telephony provider allows), full transcripts with the original speech-recognition output kept separately from human corrections, call summaries, call metadata, patient profiles, documents, appointments, workflow and approval events, NEPA in-app assistant conversations and tool-call logs, usage records, configuration and policy versions, audit logs and consent records.

Store recordings in lossless compressed format (FLAC), 16 kHz, with the caller and NEPA on separate tracks where the provider allows. If the provider only supplies a mixed or lower-quality recording, store what it provides and note the limitation in `BUILD_STATUS.md`.

Add a created date, clinic ID, language and outcome to every call and conversation record so future export, retention or training decisions need no migration.

Do not build configurable global or per-clinic data collection switches in V1.

Maintain `DATA_INVENTORY.md` documenting data type, why it is collected, where it is stored, who can access it and how it is used.

Store operational records needed by the product, including patient profiles, documents, appointments, call records, call recordings where permitted, transcripts, summaries, usage records, audit logs and consent records.

Keep the architecture extensible for V2 changes to collection, access and retention.

Applicable legal, privacy, consent and provider requirements must still be respected.

# 18. CONSENT AND PRIVACY

At clinic signup, store acceptance of applicable RedClinic terms: clinic, user, terms version, wording, timestamp and IP where appropriate.

Each clinic must record patient consent status: Not recorded, Given or Withdrawn.

Store consent date, staff member, method and wording version.

Provide editable default consent wording in English and Hindi.

Receptionist registration must record consent or clearly flag missing consent. Do not block appointment booking solely because consent is missing.

Consent withdrawal must update the record, stop relevant outbound calls and reminders, flag the patient for the clinic admin and be audit-logged.

Support patient data export, correction and deletion workflows as applicable.

NEPA must disclose AI handling and recording where required.

Do not train or fine-tune any AI model on this data in V1. Collection is for storage and product operation only. Any use for training is a later founder decision.

The signup terms and the default patient consent wording must state that data, including call recordings and transcripts, may be used to improve and train RedClinic's AI models, so the option remains open. Record the terms version accepted.

# 19. AI TRAINING DATA: COLLECT NOW, DECIDE LATER

Collect all data in V1 as described in section 17. Do not use it for model training in V1.

Do not implement in V1:
- Training eligibility flags.
- Training dataset exports.
- Model-training pipelines.
- Training-data dashboards.
- Third-party model-training integrations.

Do not send recordings or transcripts to any third party for training.

Keep the data in a clean, well-labelled state so a training decision later needs no re-collection: original speech-recognition output separate from corrections, speaker labels, language, outcome and clinic ID on every call, and recordings in lossless format.

Operational storage and the wording in section 18 keep the option open. They do not authorize training until the founder decides.

# 20. BILLING INFRASTRUCTURE

Build internal subscription architecture supporting monthly and annual plans, subscription records, plan entitlements, usage limits, subscription states, renewal, cancellation, failed-payment states, grace periods and billing history.

Build frontend and backend billing architecture. Use simulated payment events for development and testing.

Do not activate a paid payment gateway until the founder selects and approves one.

When selected, integrate the chosen provider using verified webhooks, idempotency and internal subscription records.

Never activate a paid subscription based solely on a browser redirect. Never store card details.

# 21. PAID API PROVIDERS — DECISIONS RESERVED FOR FOUNDER

The founder will separately discuss and decide which paid APIs and providers to use.

Do not perform provider cost comparisons as part of the coding assignment. Do not independently select, purchase, subscribe to, upgrade or activate paid services.

Current status:
- Cartesia: selected voice generation provider.
- Sarvam AI: not selected.
- Exotel: not selected.
- OpenAI: not finalized for this implementation.
- Other telephony providers: not selected.
- Other speech recognition providers: not selected.
- Payment gateway: not finalized.
- Other paid APIs: not finalized.

Do not assume unselected providers will be used. Do not ask for all API credentials at once. Do not delay product development because these decisions are pending.

## Cartesia

Inspect available Cartesia documentation, account access and existing startup benefits. Build the Cartesia adapter and keep it ready for credentials and configuration. Do not assume any other voice provider has been selected.

# 22. BUILD WITHOUT PAID APIS

Build everything that can be developed independently of external paid APIs.

Implement provider-independent interfaces, backend adapters, database structures, frontend integration points, API contracts, webhook endpoints, configuration support, error handling, retries, usage tracking, logging and automated tests.

For voice functionality, build a simulated call environment that allows testing:
- Call lifecycle.
- Agent configuration.
- Global instructions.
- Clinic instructions.
- Individual agent instructions.
- Conversation workflows.
- Permission checks.
- Approval workflows.
- Transcripts.
- Summaries.
- Call outcomes.
- Dashboard updates.

Clearly distinguish simulated calls from real calls. Never display simulated activity as real production activity.

For payment functionality, use simulated payment events. For email and other integrations, use test adapters where needed.

The application must be testable without spending money on paid APIs.

# 23. PROVIDER-INDEPENDENT ARCHITECTURE

Separate LLM provider, speech-to-text provider, text-to-speech provider, telephony provider, recording provider, payment gateway, email and notifications, and document storage.

Build adapters so providers can be changed without rewriting the core application. Changing telephony, speech recognition or LLM providers must not require redesigning NEPA.

Maintain an accurate integration status:
1. Architecture ready.
2. Adapter implemented.
3. Mock tested.
4. Provider selected.
5. Credentials configured.
6. Connection verified.
7. End-to-end test passed.
8. Production activated.

Never claim an integration is complete merely because its adapter or mock exists.

# 24. SECURITY AND RELIABILITY

Implement secure authentication, password recovery, backend authorization, tenant isolation, database access policies, private storage, encryption in transit and at rest where supported, input validation, rate limiting, secure webhook handling, audit logs, error monitoring, backup and recovery, environment separation and secure secret management.

Never expose backend secrets to the frontend. Never commit credentials to GitHub. Never use production patient data in development testing.

Every sensitive operation must be authorized on the backend.

Build graceful error handling. A provider outage must not corrupt patient records or appointment data.

# 25. DEVELOPMENT ENVIRONMENTS AND DEPLOYMENT

Use separate development, staging and production environments.

Build deployment pipelines. Maintain versioned database migrations. Do not run unreviewed migrations in production.

Implement backup and rollback procedures.

Prepare domain, DNS, SSL, environment configuration, monitoring, error alerts, database backups and storage configuration.

Use existing infrastructure where suitable. Do not create duplicate infrastructure without a technical reason.

# 26. TESTING REQUIREMENTS

Testing is mandatory. Do not claim a module is complete because the interface looks correct.

Test:

**Authentication:** signup, login, password recovery, session handling and user deactivation.

**Multi-tenancy:** clinic, patient, document and call isolation.

**Permissions:** all five roles, granular permissions, unauthorized operations and approval enforcement.

**Clinic operations:** clinic registration, staff invitations, patient registration, duplicate detection, document upload/retrieval, appointment creation, double-booking prevention, cancellation and rescheduling.

**NEPA:** global policy inheritance, clinic configuration, agent configuration, instruction conflicts, permission enforcement, simulated conversations, call lifecycle, transcription failure handling, escalation, approval workflows and source-linked history retrieval.

**Dashboards:** Needs Attention, Results calculations, empty states, filters and export.

**Billing:** simulated subscription creation, renewal events, failed payment, cancellation and entitlements.

**UI/UX:** desktop, mobile, tablet, first-time user workflows, form validation, loading and error states, navigation and accessibility basics.

Use automated tests and manual end-to-end tests.

Mocks are acceptable for development tests, but they must never be reported as successful live integration tests.

# 27. INTEGRATION, FINAL TESTING AND PRODUCTION LAUNCH

The work is not complete when the core application is built.

After the founder selects and approves paid providers and supplies the required credentials, complete the real integrations.

The final integration stage includes:
1. Configure approved providers.
2. Connect real APIs.
3. Verify credentials and permissions.
4. Configure production webhooks.
5. Test inbound calls.
6. Test outbound calls.
7. Test real-time speech recognition.
8. Test voice generation.
9. Test LLM orchestration.
10. Test call recording.
11. Test transcription.
12. Test call summaries.
13. Test patient association.
14. Test escalation and transfers.
15. Test approval workflows.
16. Test real subscription events when the payment gateway is approved.
17. Test failures and retries.
18. Test usage tracking.
19. Test integration outages.
20. Verify real end-to-end workflows.

Only after approved APIs are connected and staging tests pass should the production release proceed.

Perform a final production-readiness review. Verify frontend, backend, database, authentication, permissions, tenant isolation, integrations, calls, appointments, documents, dashboards, billing where activated, backups, monitoring, error handling and mobile experience.

Deploy production. Run post-deployment smoke tests. Provide the live URLs.

Do not declare production complete until the deployed product has been tested.

# 28. COST CONTROL DURING DEVELOPMENT

Do not purchase paid services or upgrade plans without founder approval.

Check existing accounts and credits before requesting new subscriptions.

Use local development, mocks and test environments where possible. Avoid unnecessary infrastructure.

Keep an accurate record of services already in use and any costs incurred.

Provider comparison, commercial pricing decisions and API cost analysis will be handled separately by the founder.

# 29. GITHUB AND PROJECT COLLABORATION

GitHub is the implementation source of truth once the repository is available.

Claude Code is the primary builder. The founder is the product owner. ChatGPT may act as an independent product and technical reviewer.

Do not assume ChatGPT can automatically access private Claude conversations or uncommitted local changes.

Maintain:
- `PRODUCT_SPEC.md`
- `ARCHITECTURE.md`
- `BUILD_STATUS.md`
- `DECISIONS.md`
- `INTEGRATION_REQUIREMENTS.md`
- `ENVIRONMENT_VARIABLES.md`
- `CHANGELOG.md`
- `KNOWN_ISSUES.md`
- `ROADMAP.md`

Record approved decisions. Classify requirements as Locked, Approved, Proposed, Recommended or Unresolved. Never treat recommendations as approved decisions.

Git workflow:
- Commit incrementally.
- Use descriptive commits.
- Preserve stable functionality.
- Use versioned migrations.
- Avoid destructive changes.
- Document breaking changes.
- Maintain rollback instructions.

At major milestones, provide a review package:
1. Implemented functionality.
2. Changed files and modules.
3. Database changes.
4. Architecture decisions.
5. Tests and results.
6. Known issues.
7. Security implications.
8. Deployment status.
9. Remaining work.

Evaluate recommendations from ChatGPT against the actual codebase and approved requirements. Do not blindly accept or reject recommendations.

# 30. DEVELOPMENT EXECUTION ORDER

Follow this sequence, adapting it to the existing repository where necessary.

**Phase 0 — Audit**
- Inspect existing project.
- Read specifications.
- Document architecture.
- Identify missing functionality.

**Phase 1 — Foundation**
- Authentication.
- Database.
- Multi-tenancy.
- Permissions.
- Storage.
- Deployment environments.
- Monitoring.

**Phase 2 — Clinic application**
- Clinic onboarding.
- User management.
- Patient CRM.
- Documents.
- Appointments.
- Clinic settings.

**Phase 3 — Product experience**
- Design system.
- Navigation.
- Today screen.
- Needs Attention.
- Results dashboard.
- Mobile responsiveness.
- User onboarding.

**Phase 4 — NEPA architecture**
- Global Intelligence.
- Clinic Configuration.
- Individual Agent Configuration.
- Runtime Instruction Resolver.
- Agent Manager.
- Knowledge Manager.
- Script Manager.
- Workflow Manager.
- Permission Engine.
- Testing Simulator.

**Phase 5 — Voice and AI foundation**
- Call data model.
- Simulated call environment.
- Voice orchestration interfaces.
- Transcription interfaces.
- Summary generation interfaces.
- Call history.
- Approval workflows.
- Provider adapters.

**Phase 6 — Dental Pack**
- Master templates.
- Editable clinic copies.
- Workflow engine.
- Template versioning.
- General specialty architecture.

**Phase 7 — Admin and billing**
- Super Admin panel.
- Packages.
- Entitlements.
- Usage tracking.
- Subscription infrastructure.
- Simulated payments.

**Phase 8 — QA and staging**
- Automated tests.
- Manual tests.
- Security tests.
- Usability tests.
- Performance tests.
- Staging deployment.

**Phase 9 — Approved provider integrations**
- Connect selected APIs.
- Configure credentials.
- Run real end-to-end tests.
- Fix integration issues.

**Phase 10 — Production**
- Final review.
- Production deployment.
- Smoke tests.
- Monitoring.
- Rollback readiness.
- Handover documentation.

# 31. ACCEPTANCE STANDARD

RedClinic V1 is complete only when:
- A clinic can register and onboard.
- Staff can log in with appropriate permissions.
- A clinic can manage patients.
- Staff can upload and retrieve documents.
- Appointments can be created and managed.
- Conflicting appointments are prevented.
- Dental Pack is automatically activated for dental clinics.
- NEPA has the required global, clinic and agent configuration architecture.
- NEPA permissions are enforced by the backend.
- Simulated voice workflows work.
- Real voice integrations work after provider approval and connection.
- Transcripts and summaries are recorded where technically possible.
- Needs Attention is based on actual records.
- Results dashboard uses actual records.
- Super Admin can manage clinics and access V1 data.
- Subscription infrastructure works with simulated events and with the approved live gateway after integration.
- The interface is understandable to non-technical clinic staff.
- Mobile and desktop experiences work.
- Security and tenant isolation tests pass.
- Staging deployment is verified.
- Production deployment is verified after integrations are completed.
- Documentation reflects the actual implementation.

Do not use placeholders to claim functionality is complete. Do not claim integrations are live when they are simulated. Do not claim production readiness without testing.

# 32. FINAL DELIVERABLES

Deliver:
1. Complete source code.
2. Working frontend.
3. Working backend.
4. Database schema and migrations.
5. Authentication.
6. Five user roles.
7. Granular permission system.
8. Super Admin panel.
9. Clinic workspace.
10. Patient CRM.
11. Medical document management.
12. Appointment management.
13. Needs Attention list.
14. Results dashboard.
15. Dental Pack.
16. Future specialty architecture.
17. NEPA Global Intelligence.
18. Clinic Configuration.
19. Individual Agent Configuration.
20. Runtime Instruction Resolver.
21. Agent Configuration Studio.
22. NEPA in-app assistant foundation.
23. Voice receptionist foundation.
24. Simulated call environment.
25. Real provider integrations after approval.
26. Human approval workflows.
27. Consent and data-management functionality.
28. Subscription infrastructure.
29. API documentation.
30. Environment variable documentation.
31. Integration guides.
32. Automated test results.
33. Manual end-to-end test results.
34. Security documentation.
35. Deployment documentation.
36. Backup and recovery procedure.
37. Monitoring and incident-response instructions.
38. Known issues.
39. V2 extension documentation.
40. Live application URLs.

# 33. WORKING AND REPORTING RULES

The founder is not a software engineer. Do not repeatedly ask questions that engineering judgment can answer.

When blocked:
1. Explain the blocker.
2. Explain why it matters.
3. Recommend a practical solution.
4. Identify alternatives if necessary.
5. Tell the founder exactly what action is needed.
6. Continue all work that does not depend on that blocker.

Do not purchase services, upgrade plans or incur unapproved expenses.

Do not overwrite working functionality unnecessarily.

Do not deploy destructive changes without backup and rollback.

Provide regular progress updates containing completed work, current work, remaining work, blockers, required founder actions, tests completed, known issues and deployment status.

Keep `BUILD_STATUS.md` accurate.

# 34. FINAL INSTRUCTION

Build RedClinic as if an experienced professional product and engineering team were delivering it to paying clinics.

Do not settle for a technically functional but confusing interface. Do not settle for a visually attractive but non-functional application. Do not settle for mock integrations presented as real integrations. Do not build unnecessary features outside the approved V1 scope.

Make professional decisions about architecture, UX, layout, workflows and implementation.

Prioritize:
1. Reliability.
2. Security.
3. Ease of use.
4. Excellent user experience.
5. Maintainability.
6. Scalability.
7. Cost efficiency.

The founder will make provider and commercial decisions separately.

Your job is to build the complete product, prepare it for integrations, connect approved APIs when selected, test the complete system and deploy the finished platform.

**Build the platform. Integrate the approved services. Test everything. Deploy it. Verify that real clinics can use it.**
