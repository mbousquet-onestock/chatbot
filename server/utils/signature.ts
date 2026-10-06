import { createHmac, timingSafeEqual } from "node:crypto";

/** Âge maximal d'une signature d'extension, comme dans la documentation OneStock. */
export const MAX_SIGNATURE_AGE_S = 6 * 60 * 60;

export interface SignatureInput {
  extension_signature?: string;
  extension_id?: string;
  user_id?: string;
}

export type SignatureCheck = "ok" | "no_keys" | "missing_signature" | "malformed" | "expired" | "mismatch";

/**
 * Vérifie une signature `t=timestamp,h0=…,h1=…,h2=…` envoyée par OneStock lors du handshake.
 * Chaque h<n> est un HMAC-SHA256 hex de `${timestamp}.${extension_id}##${user_id}` avec une des
 * clés secrètes de l'extension (la plus récente, puis les précédentes) : il suffit qu'une clé
 * connue corresponde à l'une d'elles. Renvoie la raison d'un échec, pour le diagnostic.
 */
export function checkExtensionSignature(
  input: SignatureInput,
  secretKeys: string[],
  now = Math.floor(Date.now() / 1000),
): SignatureCheck {
  const { extension_signature: header, extension_id, user_id } = input;
  if (secretKeys.length === 0) return "no_keys";
  if (!header || !extension_id || !user_id) return "missing_signature";

  const parts = new Map<string, string>();
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) parts.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const t = parts.get("t");
  const hashes = [...parts].filter(([k]) => /^h\d+$/.test(k)).map(([, v]) => v.toLowerCase());
  if (!t || !/^\d+$/.test(t) || hashes.length === 0) return "malformed";
  // Le timestamp est en secondes d'après la documentation ; on tolère des millisecondes.
  const seconds = t.length > 11 ? Math.floor(Number(t) / 1000) : Number(t);
  if (Math.abs(now - seconds) > MAX_SIGNATURE_AGE_S) return "expired";

  const payload = `${t}.${extension_id}##${user_id}`;
  const match = secretKeys.some((key) => {
    const expected = Buffer.from(createHmac("sha256", key).update(payload).digest("hex"));
    return hashes.some((h) => {
      const candidate = Buffer.from(h);
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
  });
  return match ? "ok" : "mismatch";
}

export function verifyExtensionSignature(input: SignatureInput, secretKeys: string[], now?: number): boolean {
  return checkExtensionSignature(input, secretKeys, now) === "ok";
}

/** Clés secrètes de l'extension (`EXTENSION_SECRET_KEYS`, séparées par des virgules, la plus récente d'abord). */
export function extensionSecretKeys(): string[] {
  return (process.env.EXTENSION_SECRET_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}
