// Server-safe UI pieces shared by every screen.
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./icons";

export function PageHeader({ title, subtitle, actions, back }: { title: string; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="page-head">
      <div>
        {back && <Link className="back" href={back.href}><Icon name="left" size={16} /> {back.label}</Link>}
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  );
}

const FLASH: Record<string, string> = {
  saved: "Saved.", requested: "Request sent. The clinic admin has been emailed.", denied: "Request denied.", revoked: "Access closed.", booked: "Appointment booked.", moved: "Appointment moved.", cancelled: "Appointment cancelled.",
  confirmed: "Marked as confirmed.", completed: "Marked as done.", no_show: "Marked as no-show.", scheduled: "Marked as not confirmed.",
  invited: "Invitation sent.", deactivated: "Account switched off.", merged: "Records merged.", uploaded: "Document added.",
  consent: "Consent recorded.", registered: "Patient added.", resolved: "Marked as done.", snoozed: "Snoozed.",
  approved: "Approved.", rejected: "Rejected.", published: "Published.", restored: "Previous version restored.",
};

export function Flash({ ok }: { ok?: string }) {
  if (!ok || !FLASH[ok]) return null;
  return <div className="alert alert-success" role="status">{FLASH[ok]}</div>;
}

export function ErrorBox({ message }: { message?: string }) {
  if (!message) return null;
  return <div className="alert alert-error" role="alert">{message}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

const TONE: Record<string, string> = {
  scheduled: "neutral", confirmed: "ok", completed: "done", no_show: "warn", cancelled: "muted",
  given: "ok", withdrawn: "warn", not_recorded: "neutral", active: "ok", deactivated: "muted", suspended: "warn",
  open: "warn", snoozed: "neutral", resolved: "done", pending: "warn", approved: "ok", rejected: "muted", executed: "done", failed: "bad",
  in_progress: "neutral", missed: "warn", handed_to_staff: "warn", draft: "neutral", published: "ok",
};
const LABEL: Record<string, string> = {
  scheduled: "Not confirmed", confirmed: "Confirmed", completed: "Done", no_show: "No-show", cancelled: "Cancelled",
  given: "Consent given", withdrawn: "Consent withdrawn", not_recorded: "Consent not recorded", handed_to_staff: "Handed to staff",
  in_progress: "In progress",
};

export function Badge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge badge-${TONE[status] ?? "neutral"}`}>{label ?? LABEL[status] ?? status.replace(/_/g, " ").replace(/^\w/, (m) => m.toUpperCase())}</span>;
}

export function Simulated() {
  return <span className="badge badge-sim" title="Test data, not a real call">Simulated</span>;
}

export const fmtDate = (d: Date | string | null, tz = "Asia/Kolkata") =>
  d ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: tz }).format(new Date(d)) : "—";
export const fmtDateTime = (d: Date | string | null, tz = "Asia/Kolkata") =>
  d ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(d)) : "—";
export const fmtTime = (d: Date | string, tz = "Asia/Kolkata") =>
  new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(d));
export function fmtLocalTime(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
export function fmtDay(ymd: string) {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(ymd + "T00:00:00Z"));
}
export function addDays(ymd: string, n: number) {
  const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
