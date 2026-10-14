import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// AES-256-GCM for private values kept in PostgreSQL, such as queued email and
// Apple refresh tokens. Each purpose derives its own key from
// BETTER_AUTH_SECRET, so a new secret makes earlier values unreadable.
function key(purpose: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Set BETTER_AUTH_SECRET to at least 32 random characters.");
  return createHash("sha256").update(`${purpose}:${secret}`).digest();
}

// Base64 of the 12-byte IV, the 16-byte tag, and the ciphertext.
export function seal(purpose: string, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function unseal(purpose: string, sealed: string) {
  const bytes = Buffer.from(sealed, "base64");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key(purpose),
    bytes.subarray(0, 12),
  );
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString();
}
