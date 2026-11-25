// Private file storage. Files are never public: they are read through short-lived signed links that the
// application hands out only after checking permissions and writing an audit entry.
// Implementations: 'local' (disk, for development and single-server use). An S3-compatible adapter
// (AWS S3, Cloudflare R2, Supabase Storage) is added when hosting is chosen (KNOWN_ISSUES K8).

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { appBaseUrl } from "../env";

export interface StorageAdapter {
  readonly driver: string;
  /** Stores bytes under a key. Never overwrites an existing key. */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Deletes a stored object (retention rules). Missing keys are ignored. */
  remove(key: string): Promise<void>;
  /** A link that works for `ttlSeconds` only. */
  signedUrl(key: string, ttlSeconds: number, downloadName: string, contentType: string): string;
}

const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png|wav)$/;

export function isValidKey(key: string): boolean {
  return KEY_RE.test(key);
}

function signingSecret(): string {
  const s = process.env.STORAGE_SIGNING_SECRET;
  if (!s || s.length < 32) throw new Error("STORAGE_SIGNING_SECRET must be set (32+ characters)");
  return s;
}

export function signLocal(key: string, exp: number, name: string, type: string): string {
  return createHmac("sha256", signingSecret()).update(`${key}\n${exp}\n${name}\n${type}`).digest("base64url");
}

export function verifyLocal(key: string, exp: number, name: string, type: string, sig: string, now = Date.now()): boolean {
  if (!isValidKey(key) || !Number.isFinite(exp) || exp * 1000 < now) return false;
  const expected = Buffer.from(signLocal(key, exp, name, type));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly driver = "local";
  constructor(private readonly root: string) {}

  private file(key: string): string {
    if (!isValidKey(key)) throw new Error("invalid storage key");
    return path.join(this.root, key);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    await writeFile(f, bytes, { flag: "wx", mode: 0o600 }); // wx: fail if it exists
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.file(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.file(key)).then(() => true, () => false);
  }

  signedUrl(key: string, ttlSeconds: number, downloadName: string, contentType: string): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const q = new URLSearchParams({ key, exp: String(exp), name: downloadName, type: contentType, sig: signLocal(key, exp, downloadName, contentType) });
    return `${appBaseUrl()}/api/files?${q}`;
  }
}

let adapter: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  if (!adapter) {
    const driver = process.env.STORAGE_DRIVER ?? "local";
    if (driver !== "local") throw new Error(`Storage driver '${driver}' is not built yet`);
    const dir = process.env.STORAGE_DIR;
    if (!dir) throw new Error("STORAGE_DIR must be set for local storage");
    adapter = new LocalStorageAdapter(path.resolve(dir));
  }
  return adapter;
}

/** Tests only. */
export function setStorage(a: StorageAdapter | undefined): void {
  adapter = a;
}
