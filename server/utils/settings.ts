import { neon } from "@neondatabase/serverless";
import { decryptSetting } from "../lib/settings-secrets.mjs";

/** Configuration OneStock d'un site, lue dans la table `settings` partagée avec l'application Extensions. */
export interface OnestockSettings {
  token: string;
  apiRoot: string;
}

const KEYS = ["onestock_token", "onestock_api_root"] as const;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: OnestockSettings }>();

let sqlClient: ReturnType<typeof neon> | undefined;
function sql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  sqlClient ??= neon(process.env.DATABASE_URL);
  return sqlClient;
}

/**
 * Racine d'API sans slash final ni suffixe de version : les chemins ajoutent eux-mêmes `/v1`, `/v2`, `/v3`…
 * (chaque route OneStock a sa propre version).
 */
export function normalizeApiRoot(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v\d+$/i, "");
}

/**
 * Lit `onestock_token` (chiffré) et `onestock_api_root` pour un site.
 * Une valeur propre au site est prioritaire sur la valeur générique (`*` ou vide).
 * `ONESTOCK_ENVIRONMENT`, si défini, filtre la colonne `environment`.
 */
export async function getOnestockSettings(siteId: string): Promise<OnestockSettings> {
  // Développement local sans base : valeurs prises dans l'environnement.
  if (!process.env.DATABASE_URL && process.env.ONESTOCK_API_ROOT && process.env.ONESTOCK_TOKEN) {
    return { token: decryptSetting(process.env.ONESTOCK_TOKEN), apiRoot: normalizeApiRoot(process.env.ONESTOCK_API_ROOT) };
  }
  const environment = process.env.ONESTOCK_ENVIRONMENT?.trim() || null;
  const cacheKey = `${environment ?? ""}|${siteId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const rows = (await sql()`
    SELECT key, value FROM settings
    WHERE key = ANY(${KEYS as unknown as string[]})
      AND (${environment}::text IS NULL OR environment = ${environment})
      AND (site_id = ${siteId} OR site_id IN ('*', ''))
    ORDER BY (site_id = ${siteId}) DESC`) as { key: string; value: string }[];

  const pick = (key: string) => rows.find((r) => r.key === key)?.value;
  const token = pick("onestock_token");
  const apiRoot = pick("onestock_api_root");
  if (!token || !apiRoot) {
    const missing = [!token && "onestock_token", !apiRoot && "onestock_api_root"].filter(Boolean).join(", ");
    throw createError({ statusCode: 500, statusMessage: `Missing settings for site ${siteId}: ${missing}` });
  }

  const value = { token: decryptSetting(token), apiRoot: normalizeApiRoot(apiRoot) };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
