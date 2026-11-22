import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { closePool, withContext } from "@/lib/db";
import { contextOf } from "@/lib/auth/service";
import { DOWNLOAD_LINK_SECONDS, detectFileKind, listDocuments, MAX_UPLOAD_BYTES, openDocument, uploadDocument } from "@/lib/documents/service";
import { getStorage, isValidKey, LocalStorageAdapter, signLocal, verifyLocal } from "@/lib/storage";
import { addStaff, freshOutbox, newClinic, newPatient } from "./helpers";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("test prescription body")]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

let outbox = freshOutbox();
beforeEach(() => { outbox = freshOutbox(); });
afterAll(async () => { await closePool(); await rm("/tmp/rc-vitest-storage", { recursive: true, force: true }); });

function parse(url: string) {
  const u = new URL(url);
  const g = (k: string) => u.searchParams.get(k) ?? "";
  return { key: g("key"), exp: Number(g("exp")), name: g("name"), type: g("type"), sig: g("sig"), path: u.pathname };
}

describe("file type detection", () => {
  it("recognises PDF, JPG and PNG by content, and nothing else", () => {
    expect(detectFileKind(PDF)?.ext).toBe("pdf");
    expect(detectFileKind(JPG)?.ext).toBe("jpg");
    expect(detectFileKind(PNG)?.ext).toBe("png");
    expect(detectFileKind(Buffer.from("MZ\x90\x00 this is an exe"))).toBeNull();
    expect(detectFileKind(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
  });
});

describe("upload", () => {
  it("stores the original privately with its fingerprint and an audit entry", async () => {
    const { admin } = await newClinic();
    const patientId = await newPatient(admin);
    const r = await uploadDocument(admin, { patientId, docType: "prescription", file: { name: "rx scan.pdf", bytes: PDF } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await withContext(contextOf(admin), async (c) => (await c.query("SELECT * FROM documents WHERE id = $1", [r.value.documentId])).rows[0]);
    expect(row.mime_type).toBe("application/pdf");
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.storage_driver).toBe("local");
    expect(row.storage_path.startsWith(`${admin.clinicId}/${patientId}/`)).toBe(true);
    expect((await getStorage().get(row.storage_path)).equals(PDF)).toBe(true);
    const audit = await withContext(contextOf(admin), async (c) => (await c.query("SELECT 1 FROM audit_log WHERE action='document_uploaded' AND entity_id=$1", [r.value.documentId])).rowCount);
    expect(audit).toBe(1);
  });

  it("rejects disguised, oversized and missing files, and empty notes", async () => {
    const { admin } = await newClinic();
    const patientId = await newPatient(admin);
    const exe = await uploadDocument(admin, { patientId, docType: "report", file: { name: "report.pdf", bytes: Buffer.from("MZ not a pdf") } });
    expect(exe.ok).toBe(false);
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expect((await uploadDocument(admin, { patientId, docType: "report", file: { name: "big.pdf", bytes: big } })).ok).toBe(false);
    expect((await uploadDocument(admin, { patientId, docType: "report" })).ok).toBe(false);
    expect((await uploadDocument(admin, { patientId, docType: "note", description: "  " })).ok).toBe(false);
    expect((await uploadDocument(admin, { patientId, docType: "note", description: "Allergic to penicillin (told by patient)" })).ok).toBe(true);
  });

  it("refuses a patient from another clinic", async () => {
    const a = await newClinic();
    const b = await newClinic();
    const bPatient = await newPatient(b.admin);
    const r = await uploadDocument(a.admin, { patientId: bPatient, docType: "prescription", file: { name: "x.pdf", bytes: PDF } });
    expect(r.ok).toBe(false);
  });

  it("a failed file write leaves no document record", async () => {
    const { admin } = await newClinic();
    const patientId = await newPatient(admin);
    const real = getStorage();
    const { setStorage } = await import("@/lib/storage");
    setStorage({ driver: "broken", put: async () => { throw new Error("disk full"); }, get: real.get.bind(real), signedUrl: real.signedUrl.bind(real) });
    await expect(uploadDocument(admin, { patientId, docType: "image", file: { name: "x.png", bytes: PNG } })).rejects.toThrow(/disk full/);
    setStorage(real);
    expect(await listDocuments(admin, patientId)).toHaveLength(0);
  });
});

describe("permissions and opening", () => {
  it("receptionist can upload but not see documents; doctor can open, and the access is logged", async () => {
    const { admin } = await newClinic();
    const patientId = await newPatient(admin);
    const recep = await addStaff(admin, "receptionist", outbox);
    const doctor = await addStaff(admin, "doctor", outbox);

    const up = await uploadDocument(recep, { patientId, docType: "report", file: { name: "blood test.jpg", bytes: JPG } });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(await listDocuments(recep, patientId)).toHaveLength(0);
    expect((await openDocument(recep, up.value.documentId)).ok).toBe(false);

    const docs = await listDocuments(doctor, patientId);
    expect(docs).toHaveLength(1);
    expect(docs[0].uploadedBy).toBe("Test receptionist");
    const open = await openDocument(doctor, up.value.documentId);
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    const l = parse(open.value.url);
    expect(l.path).toBe("/api/files");
    expect(l.name).toBe("blood test.jpg");
    expect(verifyLocal(l.key, l.exp, l.name, l.type, l.sig)).toBe(true);
    expect(l.exp - Date.now() / 1000).toBeLessThanOrEqual(DOWNLOAD_LINK_SECONDS + 1);

    const n = await withContext(contextOf(admin), async (c) =>
      (await c.query("SELECT count(*)::int AS n FROM audit_log WHERE action='document_opened' AND actor_user_id=$1", [doctor.userId])).rows[0].n);
    expect(n).toBe(1);
  });

  it("staff without upload permission cannot upload", async () => {
    const { admin } = await newClinic();
    const patientId = await newPatient(admin);
    const manager = await addStaff(admin, "clinic_manager", outbox);
    expect((await uploadDocument(manager, { patientId, docType: "report", file: { name: "a.pdf", bytes: PDF } })).ok).toBe(false);
  });

  it("another clinic cannot list or open the document", async () => {
    const a = await newClinic();
    const b = await newClinic();
    const patientId = await newPatient(a.admin);
    const up = await uploadDocument(a.admin, { patientId, docType: "prescription", file: { name: "rx.pdf", bytes: PDF } });
    if (!up.ok) throw new Error(up.error);
    expect(await listDocuments(b.admin, patientId)).toHaveLength(0);
    expect((await openDocument(b.admin, up.value.documentId)).ok).toBe(false);
    expect((await openDocument(b.admin, "not-a-uuid")).ok).toBe(false);
  });
});

describe("signed links", () => {
  const key = "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333.pdf";
  const future = Math.floor(Date.now() / 1000) + 60;

  it("reject tampering, expiry and path tricks", () => {
    const sig = signLocal(key, future, "a.pdf", "application/pdf");
    expect(verifyLocal(key, future, "a.pdf", "application/pdf", sig)).toBe(true);
    expect(verifyLocal(key, future + 1, "a.pdf", "application/pdf", sig)).toBe(false);
    expect(verifyLocal(key, future, "a.pdf", "text/html", sig)).toBe(false);
    expect(verifyLocal(key.replace("33333333", "44444444"), future, "a.pdf", "application/pdf", sig)).toBe(false);
    const past = Math.floor(Date.now() / 1000) - 1;
    expect(verifyLocal(key, past, "a.pdf", "application/pdf", signLocal(key, past, "a.pdf", "application/pdf"))).toBe(false);
    expect(isValidKey("../../etc/passwd")).toBe(false);
    expect(isValidKey(`${key}/../x`)).toBe(false);
  });

  it("local storage never overwrites an existing file", async () => {
    const s = new LocalStorageAdapter("/tmp/rc-vitest-storage");
    await s.put(key, PDF);
    await expect(s.put(key, Buffer.from("%PDF-evil"))).rejects.toThrow();
    expect((await s.get(key)).equals(PDF)).toBe(true);
  });
});
