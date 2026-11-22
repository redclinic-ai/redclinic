import { createHash, randomBytes } from "node:crypto";

/** A random token for a cookie or an emailed link. Only its hash is stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
