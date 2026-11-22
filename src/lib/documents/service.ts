// Medical documents: upload, list and open. Permissions are enforced twice: by the capability check here
// (for a clear message) and by row-level security in the database (the real guard).

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { withContext } from "../db";
import { contextOf, type Result, type SignedInUser } from "../auth/service";
import { getStorage } from "../storage";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const DOWNLOAD_LINK_SECONDS = 300;
export const DOC_TYPES = ["prescription", "report", "image", "pdf", "note", "other"] as const;

type FileKind = { ext: "pdf" | "jpg" | "png"; mime: string };

/** Recognises the file from its first bytes, not from its name or the browser's claim. */
export function detectFileKind(b: Buffer): FileKind | null {
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return { ext: "pdf", mime: "application/pdf" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  return null;
}

const uploadSchema = z.object({
  patientId: z.string().uuid(),
  docType: z.enum(DOC_TYPES),
  description: z.string().trim().max(2000).optional().default(""),
});

export interface UploadInput {
  patientId: string;
  docType: (typeof DOC_TYPES)[number];
  description?: string;
  file?: { name: string; bytes: Buffer } | null;
}

const fail = (error: string, field?: string) => ({ ok: false as const, error, field });

async function can(c: import("pg").PoolClient, cap: string): Promise<boolean> {
  return (await c.query("SELECT rc_has_capability($1) AS ok", [cap])).rows[0].ok;
}

function safeName(name: string, ext: string): string {
  const base = name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 80) || "document";
  return `${base}.${ext}`;
}

export async function uploadDocument(actor: SignedInUser, input: UploadInput): Promise<Result<{ documentId: string }>> {
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message, String(parsed.error.issues[0].path[0] ?? ""));
  const d = parsed.data;
  const file = input.file && input.file.bytes.length > 0 ? input.file : null;

  if (d.docType === "note") {
    if (file) return fail("A note can't have a file. Choose another type.", "docType");
    if (!d.description) return fail("Write the note.", "description");
  } else if (!file) {
    return fail("Choose a file to upload.", "file");
  }

  let kind: FileKind | null = null;
  if (file) {
    if (file.bytes.length > MAX_UPLOAD_BYTES) return fail("That file is too big. The limit is 15 MB.", "file");
    kind = detectFileKind(file.bytes);
    if (!kind) return fail("Upload a PDF, JPG or PNG file.", "file");
  }

  const storage = getStorage();
  try {
    const documentId = await withContext(contextOf(actor), async (c) => {
      if (!actor.clinicId || !(await can(c, "upload_document"))) throw new Denied();
      const patient = await c.query("SELECT id FROM patients WHERE id = $1", [d.patientId]);
      if (!patient.rowCount) throw new NotFound();

      const id = randomUUID();
      const key = kind ? `${actor.clinicId}/${d.patientId}/${id}.${kind.ext}` : null;
      await c.query(
        `INSERT INTO documents (id, clinic_id, patient_id, doc_type, original_filename, mime_type, size_bytes,
                                storage_path, storage_driver, sha256, description, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id, actor.clinicId, d.patientId, d.docType,
          file ? file.name.slice(0, 200) : null, kind?.mime ?? null, file?.bytes.length ?? null,
          key, key ? storage.driver : null,
          file ? createHash("sha256").update(file.bytes).digest("hex") : null,
          d.description || null, actor.userId,
        ],
      );
      await c.query(
        "INSERT INTO audit_log (clinic_id, actor_user_id, actor_is_super, action, entity, entity_id, detail) VALUES ($1,$2,$3,'document_uploaded','document',$4,$5)",
        [actor.clinicId, actor.userId, actor.isSuperAdmin, id, { patient_id: d.patientId, doc_type: d.docType }],
      );
      // Store the file last, inside the transaction: if storing fails, the record is rolled back.
      if (key && file && kind) await storage.put(key, file.bytes, kind.mime);
      return id;
    });
    return { ok: true, value: { documentId } };
  } catch (err) {
    if (err instanceof Denied) return fail("You don't have permission to upload documents.");
    if (err instanceof NotFound) return fail("Patient not found.", "patientId");
    throw err;
  }
}

export interface DocumentSummary {
  id: string;
  docType: string;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  description: string | null;
  uploadedBy: string | null;
  uploadedAt: Date;
  hasFile: boolean;
}

/** Documents for a patient that the user may see (empty without view_documents). */
export async function listDocuments(actor: SignedInUser, patientId: string): Promise<DocumentSummary[]> {
  return withContext(contextOf(actor), async (c) => {
    const r = await c.query(
      `SELECT d.id, d.doc_type, d.original_filename, d.mime_type, d.size_bytes, d.description, u.display_name AS uploaded_by,
              d.uploaded_at, d.storage_path IS NOT NULL AS has_file
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.patient_id = $1 ORDER BY d.uploaded_at DESC`,
      [patientId],
    );
    return r.rows.map((x) => ({
      id: x.id, docType: x.doc_type, originalFilename: x.original_filename, mimeType: x.mime_type,
      sizeBytes: x.size_bytes === null ? null : Number(x.size_bytes), description: x.description,
      uploadedBy: x.uploaded_by, uploadedAt: x.uploaded_at, hasFile: x.has_file,
    }));
  });
}

/** Checks permission, records the access in the audit log and returns a link valid for 5 minutes. */
export async function openDocument(actor: SignedInUser, documentId: string): Promise<Result<{ url: string }>> {
  if (!z.string().uuid().safeParse(documentId).success) return fail("Document not found.");
  const storage = getStorage();
  const doc = await withContext(contextOf(actor), async (c) => {
    const r = await c.query("SELECT clinic_id, storage_path, mime_type, original_filename, doc_type FROM documents WHERE id = $1", [documentId]);
    const row = r.rows[0];
    if (!row || !row.storage_path) return null;
    await c.query(
      "INSERT INTO audit_log (clinic_id, actor_user_id, actor_is_super, action, entity, entity_id) VALUES ($1,$2,$3,'document_opened','document',$4)",
      [row.clinic_id, actor.userId, actor.isSuperAdmin, documentId],
    );
    return row as { storage_path: string; mime_type: string; original_filename: string | null; doc_type: string };
  });
  if (!doc) return fail("Document not found.");
  const ext = doc.storage_path.split(".").pop()!;
  const name = safeName(doc.original_filename ?? doc.doc_type, ext);
  return { ok: true, value: { url: storage.signedUrl(doc.storage_path, DOWNLOAD_LINK_SECONDS, name, doc.mime_type) } };
}

class Denied extends Error {}
class NotFound extends Error {}
