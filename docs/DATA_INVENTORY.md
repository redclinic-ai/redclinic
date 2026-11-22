# DATA_INVENTORY

V1 collects the data below so later decisions on use can be made from complete records. No model training in V1. No clinic revenue data of any kind.

| Data | Why | Where | Who can access |
|---|---|---|---|
| Clinic profile, settings, terms acceptance | Run the clinic workspace, prove consent | `clinics`, `terms_acceptances` | Clinic admin, super admin |
| Staff accounts, capabilities | Access control | `users`, `staff_capabilities` | Clinic admin, super admin |
| Patient profile, consent status | Patient CRM | `patients`, `patient_consents` | Staff with capability, super admin |
| Documents (files and metadata) | Patient records | `documents` + private storage | Staff with `view_documents`, super admin |
| Appointments | Scheduling | `appointments` | Clinic staff, super admin |
| Call records, recordings, transcripts, summaries | NEPA voice, review | `calls`, `call_transcripts` | Clinic staff with capability, super admin |
| Approvals, attention items | Human oversight | `approvals`, `attention_items` | Clinic staff, super admin |
| Usage events | Plan limits, results | `usage_events` | Clinic admin, super admin |
| Audit log | Accountability | `audit_log` | Clinic admin (own clinic), super admin |
| Subscriptions | Billing | `subscriptions` | Clinic admin, super admin |
