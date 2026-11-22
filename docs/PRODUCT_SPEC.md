                                              REDCLINIC
                              V1 Product Specification
 AI for Modern Clinics. | Dental clinic management and AI receptionist platform




 Product: RedClinic AI assistant: NEPA
 Market: Dental clinics in India
 Release: V1 commercial product baseline


 Purpose
 This document defines the V1 product scope, user workflows, AI boundaries, data requirements, architecture, integrations,
 testing and release acceptance criteria.




RedClinic | V1 Product Specification                                                                                         Page 1
 1. Product definition
 RedClinic is a multi-tenant clinic operations platform for Indian dental clinics. It combines patient CRM, appointments, medical
 document management, NEPA AI voice receptionist, an in-app AI assistant, operational workflows, dashboards and subscription
 infrastructure.

   • V1 must be commercially usable, not a demo. Design for 100 clinics and at least 1,000 staff accounts.

   • Clinic-owned, clinic-scoped medical records. No patient-controlled cross-clinic record model by default.

   • Clinic staff-only document uploads by authorized users.

   • AI is limited to source-linked summaries and historical information retrieval. No diagnosis, prescribing or clinical decision support.

   • NEPA permissions are backend-enforced. Human approval is the default; clinic admins may explicitly enable specific automations.

   • Full transcripts are mandatory wherever technically possible. Transcription failures must be status-tracked and retryable. Never
      fabricate transcripts.

   • Super Admin initially has access to all clinic and patient data, plus audit logs. More restrictive access controls are a V2 possibility.

   • V1 stores operational data required for approved functionality. No global/per-clinic collection switches. Applicable privacy, consent
      and legal requirements still apply.

   • AI training-data functionality is excluded. Do not build training flags, dataset export, pipelines, dashboards, training-specific
      consent or third-party training integrations. Do not train on patient/clinic data.

   • Never calculate, estimate, store or display clinic revenue, money recovered, visit value, treatment price or clinic income. RedClinic
     subscription billing is the only money functionality.

   • Meta Lead Ads capture and WhatsApp integrations are V2. Online consultations are represented in the data model, but full
     functionality is V2.


 2. Users, roles and tenancy
   • Five roles: Super Admin, Clinic Admin, Doctor, Receptionist and Clinic Manager.

   • Backend-enforced RBAC and granular permissions. Hiding UI controls is not authorization.

   • Strict tenant isolation across patients, documents, calls, appointments, staff and clinic configuration.

   • Clinic admins may configure staff permissions within platform-enforced limits.


 3. V1 functional modules
 3.1 Clinic workspace
   • Clinic registration/profile: name, address, contacts, operating hours, timezone and dental configuration.

   • Doctor/staff management, invitations, role assignment and deactivation.

   • Clinic settings for services, FAQs, languages, scripts, workflows and permissions.

   • Dental Pack activates automatically for dental clinics.

 3.2 Patient CRM
   • Permanent internal patient ID; phone number is not identity and can change.

   • Profile: name, phone, email, DOB/age, gender/address if supplied, basic medical history, allergies, notes, registration date and
      assigned doctor.

   • Create/edit/search/filter; patient history; appointments, calls, documents and communication history.

   • Duplicate detection and controlled merge; walk-ins; permission-controlled CSV import/export.

 3.3 Medical documents
   • Authorized staff upload prescriptions, reports, PDF, JPG/PNG and manual notes/descriptions.

   • Link to clinic and patient; store type, uploader, timestamp and metadata; preserve originals.

   • Private object storage, short-lived signed URLs, backend authorization and access audit logs.

   • Full OCR/structured extraction is not V1; keep architecture extensible.




RedClinic | V1 Product Specification                                                                                                     Page 2
 3.4 Appointments
   • Create/edit/reschedule/cancel; patient, doctor, date/time, duration and status; calendar and daily list.

   • Completed/no-show states and appointment history.

   • Server-side double-booking prevention.

   • Support in-clinic and online appointment types. Reserve online consultation, fee, payment and secure meeting-reference fields; full
      online consultation is V2.

 3.5 NEPA voice receptionist
   • Inbound/outbound calls; approved FAQs; patient and intent capture; appointment assistance; staff transfer/escalation; missed-call
      handling; approved reminders/follow-ups.

   • Initial languages: Hindi, English and Kannada; extensible to more Indian languages/dialects.

   • Call record: ID, clinic, reliable patient association, caller number, direction, timestamps, duration, status, recording reference where
     permitted, transcript, transcription status, speaker labels, summary, intent, outcome, follow-up and actions.

   • Track transcription failure/retry. Keep original transcription separate from human corrections. Never fabricate content.

   • Provide required AI/recording disclosures. If caller objects, follow staff-handoff procedure.

 3.6 NEPA in-app assistant
   • Text and voice for authorized staff; search permitted patients; summarize history; retrieve documents, appointments and call
      summaries.

   • Identify missed appointments, draft notes, prepare follow-ups and execute authorized workflows.

   • Controlled backend tools; source-linked answers; distinguish verified from unavailable information.

   • No arbitrary SQL, diagnosis, prescribing or independent treatment recommendations.

 3.7 Approval and permission model
   • Modes: Suggest (human executes), Approval required (prepare and wait), Automatic (only when clinic admin explicitly enables that
     exact workflow).

   • Default approval for record changes and booking/cancel/reschedule unless specifically authorized.

   • Outbound calls follow approved workflows; reminders run automatically only when enabled; deletion requires explicit authorization.

   • Approval queue records approve/reject, approver, timestamp, action, execution/failure status and audit history.

   • NEPA must never silently gain permissions.

 3.8 Needs Attention
   • Show calls NEPA could not complete/handed to staff; unanswered questions/complaints; pending reschedule/cancellation
      requests; unconfirmed appointments.

   • No-shows with follow-up but no rebooking; failed outbound calls; pending approvals and failed workflows.

   • Each item shows who, what, why, time and next action. Actions: callback, approve, reschedule, mark done.

   • Urgent first, then oldest. Assign, resolve, snooze and audit. Resolved items leave active list but remain searchable.

 3.9 Results dashboard
   • Periods: Today, last 7 days, last 30 days. All counts derived from actual records; explain calculations and support exports.

   • Calls answered; calls handled by NEPA without staff; missed calls called back; appointments booked from missed calls;
     appointments booked by NEPA; confirmation rate.

   • No-shows; no-shows rebooked; recall/follow-up calls; visits booked from follow-ups; voice minutes versus plan.

   • No placeholder metrics. Empty state: “Results appear after your first calls.” No clinic revenue or treatment-price data anywhere.

 3.10 Dental Pack
   • Automatically activate Dental Pack. Include approved dental workflows such as RCT, braces and recall.

   • Each clinic receives editable copies of master templates. Clinic edits never change master; master updates never silently overwrite
      clinic edits.

   • Clinic may edit call count, timing, scripts and steps; disable/add workflows.



RedClinic | V1 Product Specification                                                                                                    Page 3
   • Signup message: “Dental workflows are ready. Review and edit them in Workflows.”

   • Data-driven specialty model: clinic_type, workflow_pack, pack_version, workflow_template, clinic_workflow.

 3.11 Consent and data management
   • Patient consent states: Not recorded, Given, Withdrawn; capture date, staff, method and wording version.

   • Editable default consent wording in English and Hindi. Receptionist records consent or flags missing; booking is not blocked solely
      for missing consent.

   • Withdrawal updates record, stops relevant outbound calls/reminders, flags admin and is audit-logged.

   • Support patient export/correction/deletion as applicable. Clinic signup terms acceptance records clinic/user, terms version/wording,
      timestamp and IP where appropriate.

   • Maintain DATA_INVENTORY.md: data type, reason, storage location, access and use.

 3.12 Subscription billing foundation
   • Monthly/annual plans, subscription records, entitlements, usage limits, renewal, cancellation, failed payment, grace period and
     billing history.

   • Build frontend/backend billing architecture and simulated payment events.

   • No gateway activation until founder selects and approves. Later: verified webhooks, idempotency and internal subscription source
     of truth. Never activate solely from browser redirect or store card details.


 4. NEPA configuration and runtime architecture
 Do not implement NEPA as one giant prompt. Resolve runtime instructions in layers:

   • Applicable legal/privacy/safety requirements.

   • RedClinic global mandatory policies.

   • Clinic configuration.

   • Individual agent configuration.

   • Patient conversation/request.

 Required components:

   • Global Policy Manager: versioning, mandatory/optional classification, activation, effective dates, tests, rollback and history.

   • Clinic Configuration Manager: clinic info, doctors, services, FAQs, scripts, languages, workflows, permissions and knowledge.

   • Agent Manager: multiple agents per clinic (receptionist, lead follow-up, appointment reminder, feedback, etc.).

   • Workflow Engine and Instruction Resolver: assemble active policies/configuration/knowledge/workflows/permissions; track
     versions and conflicts.

   • Permission Engine: backend enforcement independent of LLM prompt.

   • Voice Agent Configuration Studio: Agent Profiles, Script Manager, Knowledge Manager, Workflow Manager, Permission Manager,
      Testing Simulator, Version History, Publish/Rollback.

   • Use controlled templates and simple settings in V1, not an unrestricted automation builder.


 5. UX and accessibility
   • Premium, minimal, calm, modern and consistent; designed for clinic owners, doctors and receptionists with low technical literacy.

   • Today screen answers: what is happening today, what needs attention, what RedClinic completed.

   • Simple language, progressive disclosure, sensible defaults, short forms and plain-language validation.

   • Engineering owns professional decisions on navigation, hierarchy, forms, dialogs, mobile navigation, density, onboarding and
      responsive behavior.

   • Reusable design system for typography, colors, spacing, buttons, inputs, cards, tables, status, navigation and icons.

   • Responsive desktop/laptop/tablet/Android/mobile browser; not merely scaled desktop.

   • Accessibility: readable text, contrast, labels, keyboard/focus support and adequate touch targets.




RedClinic | V1 Product Specification                                                                                                   Page 4
   • Test first-time receptionist workflows. Avoid generic admin templates, clutter, excessive cards, needless animation/popups and
      jargon.


 6. Technical architecture and security
   • Modular monolith unless existing architecture warrants otherwise; avoid premature microservices.

   • Multi-tenant isolation; backend authorization; versioned APIs/migrations; replaceable adapters; private storage; audit logs;
     background jobs; monitoring and structured error handling.

   • Secure auth/password recovery/session handling, validation, rate limiting, secrets management and encryption in transit/at rest
      where supported.

   • Never expose backend secrets in frontend or commit them to GitHub. Never use production patient data in development tests.

   • Provider outage must not corrupt records. Separate development/staging/production.

   • Deployment pipeline, migration discipline, backup/recovery, rollback, domain/DNS/SSL/configuration, monitoring and alerts.


 7. Provider-independent integration strategy
   • Build everything possible without paid APIs: data models, interfaces/adapters, UI integration points, API contracts, webhooks,
      configuration, retries, usage tracking, logs and tests.

   • Separate adapters for LLM, STT, TTS, telephony, recording, payments, email/notifications and document storage.

   • Build simulated call lifecycle and payment environments; label simulations clearly. Never show simulated activity as real.

   • Cartesia is the only selected voice-generation provider at present; prepare adapter, but do not assume credentials or live
     connection.

   • STT, telephony, LLM, payment gateway and other paid providers remain undecided. No purchase, upgrade or activation without
      founder approval.

   • Provider selection and cost comparison are founder decisions. Do not block core development or request all API keys at once.

   • Integration states: Architecture ready → Adapter implemented → Mock tested → Provider selected → Credentials configured →
      Connection verified → End-to-end test passed → Production activated.

   • Meta Lead Ads and WhatsApp integrations are V2, not active V1.


 8. Testing and acceptance
 A screen that looks correct is not proof of a completed feature. Use automated and manual end-to-end tests.

   • Test authentication, password recovery, sessions and user deactivation.

   • Test tenant isolation for clinics, patients, documents and calls; all five roles and granular permissions.

   • Test onboarding, invitations, patient registration, duplicate detection/merge, document upload/retrieval and appointment
      lifecycle/double-booking.

   • Test NEPA policy/configuration layers, conflicts, backend permissions, simulated calls, transcript failure/retry, escalation,
      approvals and source-linked retrieval.

   • Test Needs Attention/Results calculations, empty states, filters/exports and simulated billing state transitions.

   • Test desktop/mobile/tablet, first-time receptionist tasks, forms, loading/error states, navigation, accessibility and security
      boundaries.

   • Mocks are development tests, not live integration tests.


 9. Build sequence
   • Phase 0: repository/spec audit, architecture and gap analysis.

   • Phase 1: auth, database, tenancy, permissions, storage, environments and monitoring.

   • Phase 2: clinic onboarding, staff, CRM, documents, appointments and settings.

   • Phase 3: design system, navigation, Today, Needs Attention, Results, mobile and onboarding.

   • Phase 4: NEPA global/clinic/agent configuration, resolver, managers, permission engine and simulator.

   • Phase 5: call data, simulated voice, orchestration/STT/summary interfaces, call history, approvals and adapters.




RedClinic | V1 Product Specification                                                                                                  Page 5
   • Phase 6: Dental Pack templates, clinic copies, workflow engine, versions and specialty architecture.

   • Phase 7: Super Admin, plans, entitlements, usage, subscriptions and simulated payments.

   • Phase 8: automated/manual/security/usability/performance QA and staging deployment.

   • Phase 9: approved provider integrations, credentials and real end-to-end tests.

   • Phase 10: production deployment, smoke tests, monitoring, rollback readiness and handover.

   • Adapt sequence to repository reality. Build complete vertical workflows, not disconnected screens.


 10. V1 completion criteria
   • Clinic onboarding, staff login and permissions work.

   • Patient CRM, staff-only document upload/retrieval and appointment management work; double-booking is prevented.

   • Dental Pack activates automatically and clinic template copies are independent.

   • NEPA global/clinic/agent architecture and backend permission enforcement work.

   • Simulated voice workflows, transcript status/retry, summaries, approvals and outcomes work.

   • Needs Attention and Results use actual records, not placeholders.

   • Super Admin can manage clinics and access V1 data with auditability.

   • Billing works with simulated events; live gateway only after founder approval.

   • Non-technical clinic staff can use the responsive interface.

   • Security/tenant tests pass; staging is verified.

   • Approved real voice/payment integrations pass end-to-end tests before production claims.

   • Production is deployed and smoke-tested; documentation matches implementation.


 11. Project documentation and handover
   • Maintain PRODUCT_SPEC.md, ARCHITECTURE.md, BUILD_STATUS.md, DECISIONS.md,
     INTEGRATION_REQUIREMENTS.md, ENVIRONMENT_VARIABLES.md, CHANGELOG.md, KNOWN_ISSUES.md,
     ROADMAP.md and DATA_INVENTORY.md.

   • At milestones report implemented features, changed files/modules, DB changes, decisions, tests, known issues, security
      implications, deployment status and remaining work.

   • Final handover: complete source, frontend/backend, schema/migrations, auth/RBAC, Super Admin, clinic workspace, CRM,
      documents, appointments, dashboards, Dental Pack, NEPA architecture/simulator, approved integrations, approvals,
      consent/data management, subscription infrastructure, API/environment docs, integration guides, test/security results,
      deployment, backup/recovery, monitoring/incident response, known issues, V2 extension notes and live URLs.


 12. Explicit V2 boundary
 Not active V1 features: Meta Lead Ads capture, WhatsApp integrations, full online consultations, full OCR/structured document
 extraction, additional specialty packs and more restrictive Super Admin access controls. Keep the architecture extensible without
 activating these features in V1.


 13. Execution rules
   • Founder is product owner and should not be asked to make routine engineering or UI decisions.

   • Do not incur unapproved expenses, buy services or upgrade plans. Check existing accounts/credits first.

   • Ask for credentials only when a specific approved integration is ready.

   • When blocked, explain blocker, impact, recommended solution, alternatives and exact founder action; continue independent work.

   • Use incremental descriptive Git commits, preserve stable functionality, version migrations, document breaking changes and
     rollback.

   • Do not claim completion because a screen exists; do not present mocks as live integrations or claim production readiness without
     testing.




RedClinic | V1 Product Specification                                                                                             Page 6
 Delivery standard: Build as a professional product and engineering team would for paying clinics. Prioritize reliability, security,
 ease of use, excellent UX, maintainability, scalability and cost efficiency. Build the platform, prepare integrations, connect
 approved services, test the complete system, deploy it and verify real clinic usability.




RedClinic | V1 Product Specification                                                                                            Page 7
