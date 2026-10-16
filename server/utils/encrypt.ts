import { createCipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

/** Même dérivation de clé que server/lib/settings-secrets.mjs (application Extensions). */
function encryptionKey(raw = process.env.SETTINGS_ENCRYPTION_KEY): Buffer {
  const value = raw?.trim();
  if (!value) throw new Error("SETTINGS_ENCRYPTION_KEY is not set");
  if (/^[\da-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const b64 = Buffer.from(value, "base64");
  if (b64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return b64;
  return createHash("sha256").update(value).digest();
}

/** Chiffre une valeur au format `enc:v1:` + base64(iv 12 | tag 16 | texte chiffré), AES-256-GCM. */
export function encryptSetting(value: string, key?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
