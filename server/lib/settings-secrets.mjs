/**
 * Lecture des settings sensibles (onestock_token…) chiffrés par l'application Extensions.
 * Module autonome à copier dans toute application qui lit la même base : aucune dépendance,
 * Node.js 18+ uniquement. Nécessite la variable d'environnement SETTINGS_ENCRYPTION_KEY
 * (la même valeur que dans l'application Extensions).
 *
 * Format : `enc:v1:` + base64(iv 12 octets | tag 16 octets | texte chiffré), AES-256-GCM.
 * Une valeur sans préfixe `enc:v1:` (ancienne valeur en clair) est renvoyée telle quelle.
 */
import { createDecipheriv, createHash } from "node:crypto";

const PREFIX = "enc:v1:";

/** Même dérivation que l'application : 64 caractères hex, 32 octets en base64, ou phrase secrète (SHA-256). */
function encryptionKey(raw = process.env.SETTINGS_ENCRYPTION_KEY) {
  const value = raw?.trim();
  if (!value) throw new Error("SETTINGS_ENCRYPTION_KEY is not set");
  if (/^[\da-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const b64 = Buffer.from(value, "base64");
  if (b64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return b64;
  return createHash("sha256").update(value).digest();
}

export function decryptSetting(value, key = process.env.SETTINGS_ENCRYPTION_KEY) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
  const buf = Buffer.from(value.slice(PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(key), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

/*
 * Exemple : récupérer onestock_token pour un site (valeur propre au site prioritaire sur `*`).
 *
 *   import { neon } from "@neondatabase/serverless";
 *   import { decryptSetting } from "./settings-secrets.mjs";
 *
 *   const sql = neon(process.env.DATABASE_URL);
 *   const [row] = await sql`
 *     SELECT value FROM settings
 *     WHERE key = 'onestock_token' AND environment = ${environment}
 *       AND (site_id = ${siteId} OR site_id IN ('*', ''))
 *     ORDER BY (site_id = ${siteId}) DESC LIMIT 1`;
 *   const token = row ? decryptSetting(row.value) : null;
 */
