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

export interface SettingRow {
  key: string;
  value: string;
  site_id: string;
  encrypted: boolean;
}

/**
 * Lignes `onestock_token` et `onestock_api_root` applicables à un site, une par clé : la valeur propre au site
 * est prioritaire sur la valeur générique (`*` ou vide). `ONESTOCK_ENVIRONMENT`, si défini, filtre la colonne
 * `environment`. Sans `DATABASE_URL`, `ONESTOCK_API_ROOT` / `ONESTOCK_TOKEN` les remplacent (développement local).
 */
export async function readSettingsRows(siteId: string): Promise<{ rows: SettingRow[]; fromEnv: boolean }> {
  const row = (key: string, value: string, site_id: string): SettingRow => ({
    key, value, site_id, encrypted: value.startsWith("enc:v1:"),
  });
  if (!process.env.DATABASE_URL && process.env.ONESTOCK_API_ROOT && process.env.ONESTOCK_TOKEN) {
    return {
      fromEnv: true,
      rows: [row("onestock_token", process.env.ONESTOCK_TOKEN, "*"), row("onestock_api_root", process.env.ONESTOCK_API_ROOT, "*")],
    };
  }
  const environment = process.env.ONESTOCK_ENVIRONMENT?.trim() || null;
  const rows = (await sql()`
    SELECT key, value, site_id FROM settings
    WHERE key = ANY(${KEYS as unknown as string[]})
      AND (${environment}::text IS NULL OR environment = ${environment})
      AND (site_id = ${siteId} OR site_id IN ('*', ''))
    ORDER BY (site_id = ${siteId}) DESC`) as { key: string; value: string; site_id: string | null }[];
  return {
    fromEnv: false,
    rows: KEYS.flatMap((key) => {
      const r = rows.find((x) => x.key === key);
      return r ? [row(r.key, r.value, r.site_id ?? "")] : [];
    }),
  };
}

/** Configuration OneStock déchiffrée d'un site, gardée 5 min en cache mémoire. */
export async function getOnestockSettings(siteId: string): Promise<OnestockSettings> {
  const cacheKey = `${process.env.ONESTOCK_ENVIRONMENT?.trim() ?? ""}|${siteId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const { rows } = await readSettingsRows(siteId);
  const token = rows.find((r) => r.key === "onestock_token")?.value;
  const apiRoot = rows.find((r) => r.key === "onestock_api_root")?.value;
  if (!token || !apiRoot) {
    const missing = [!token && "onestock_token", !apiRoot && "onestock_api_root"].filter(Boolean).join(", ");
    throw createError({ statusCode: 500, statusMessage: `Missing settings for site ${siteId}: ${missing}` });
  }

  const value = { token: decryptSetting(token), apiRoot: normalizeApiRoot(apiRoot) };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
