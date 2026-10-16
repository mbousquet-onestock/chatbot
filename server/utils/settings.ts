import { neon } from "@neondatabase/serverless";
import { decryptSetting } from "../lib/settings-secrets.mjs";

/** Configuration OneStock d'un site, lue dans la table `settings` partagée avec l'application Extensions. */
export interface OnestockSettings {
  token: string;
  apiRoot: string;
  /** Vue (requête) de stock OneStock utilisée par GET /stock_export (défaut : DEFAULT_STOCK_REQUEST_NAME). */
  stockRequestName: string;
  /** Langue par défaut du site (clé `default_lang`), pour les caractéristiques des articles ; facultative. */
  defaultLang?: string;
}

const KEYS = ["onestock_token", "onestock_api_root", "onestock_stock_request_name", "default_lang"] as const;

/** Vue de stock utilisée quand `onestock_stock_request_name` n'est pas renseignée dans la table settings. */
export const DEFAULT_STOCK_REQUEST_NAME = "detailed";
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: OnestockSettings }>();

/** URL de la base : `DATABASE_URL` (Neon) ou `POSTGRES_URL` (intégration Vercel Postgres). */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim() || undefined;
}

let sqlClient: ReturnType<typeof neon> | undefined;
function sql() {
  const url = databaseUrl();
  if (!url) throw new Error("DATABASE_URL (or POSTGRES_URL) is not set");
  sqlClient ??= neon(url);
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
 * `environment`. Sans base, `ONESTOCK_API_ROOT` / `ONESTOCK_TOKEN` les remplacent (développement local).
 */
export async function readSettingsRows(siteId: string): Promise<{ rows: SettingRow[]; fromEnv: boolean }> {
  const row = (key: string, value: string, site_id: string): SettingRow => ({
    key, value, site_id, encrypted: value.startsWith("enc:v1:"),
  });
  if (!databaseUrl() && process.env.ONESTOCK_API_ROOT && process.env.ONESTOCK_TOKEN) {
    const stock = process.env.ONESTOCK_STOCK_REQUEST_NAME?.trim();
    return {
      fromEnv: true,
      rows: [
        row("onestock_token", process.env.ONESTOCK_TOKEN, "*"),
        row("onestock_api_root", process.env.ONESTOCK_API_ROOT, "*"),
        ...(stock ? [row("onestock_stock_request_name", stock, "*")] : []),
      ],
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

/** Ligne de `settings` vue par le diagnostic (sans sa valeur). */
export interface SettingDiagnosticRow {
  key: string;
  site_id: string;
  environment: string;
  encrypted: boolean;
  empty: boolean;
  /** Pourquoi la ligne est (ou n'est pas) utilisée pour ce site. */
  status: "used" | "other_site" | "other_environment" | "shadowed";
}

/**
 * Toutes les lignes `onestock_token` / `onestock_api_root` de la table, sans leur valeur, avec la raison pour
 * laquelle chacune est retenue ou ignorée pour ce site, et le résultat du déchiffrement du token retenu.
 */
export async function diagnoseSettings(siteId: string): Promise<{ rows: SettingDiagnosticRow[]; decrypt: string }> {
  const environment = process.env.ONESTOCK_ENVIRONMENT?.trim() || null;
  const all = (await sql()`
    SELECT key, site_id, environment, value FROM settings
    WHERE key = ANY(${KEYS as unknown as string[]})
    ORDER BY key, site_id, environment`) as { key: string; site_id: string | null; environment: string | null; value: string | null }[];
  const { rows: used } = await readSettingsRows(siteId);

  const rows = all.map((r): SettingDiagnosticRow => {
    const site = r.site_id ?? "";
    const env = r.environment ?? "";
    const chosen = used.find((u) => u.key === r.key);
    const status = site !== siteId && site !== "*" && site !== ""
      ? "other_site"
      : environment && env !== environment
        ? "other_environment"
        : chosen && chosen.site_id === site && chosen.value === r.value ? "used" : "shadowed";
    return { key: r.key, site_id: site, environment: env, encrypted: !!r.value?.startsWith("enc:v1:"), empty: !r.value, status };
  });

  const token = used.find((u) => u.key === "onestock_token")?.value;
  let decrypt = "no_token";
  if (token) {
    try {
      decrypt = decryptSetting(token) ? "ok" : "empty";
    } catch (err) {
      decrypt = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { rows, decrypt };
}

/** Vérifie que la base répond et que la table settings existe. */
export async function pingDatabase(): Promise<number> {
  const rows = (await sql()`SELECT count(*)::int AS n FROM settings`) as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** Clés modifiables depuis l'onglet Paramètres. */
export const EDITABLE_KEYS = ["onestock_api_root", "onestock_token", "onestock_stock_request_name", "default_lang"] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];

/** Vide le cache de configuration (après un enregistrement). */
export function clearSettingsCache() {
  cache.clear();
}

/**
 * Enregistre une valeur dans `settings` pour (key, site_id, environment) : mise à jour de la ligne existante,
 * sinon insertion. Renvoie "updated" ou "inserted".
 */
export async function writeSetting(
  key: EditableKey,
  value: string,
  siteId: string,
  environment: string,
): Promise<"updated" | "inserted"> {
  const updated = (await sql()`
    UPDATE settings SET value = ${value}
    WHERE key = ${key} AND site_id = ${siteId} AND environment = ${environment}
    RETURNING key`) as unknown[];
  if (updated.length) return "updated";
  await sql()`INSERT INTO settings (key, value, site_id, environment) VALUES (${key}, ${value}, ${siteId}, ${environment})`;
  return "inserted";
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
    const env = process.env.ONESTOCK_ENVIRONMENT?.trim();
    console.error("[settings] missing", { siteId, environment: env ?? null, missing });
    throw createError({
      statusCode: 500,
      statusMessage: `Missing settings for site ${siteId}${env ? ` and environment ${env}` : ""}: ${missing}`,
    });
  }

  let decrypted: string;
  try {
    decrypted = decryptSetting(token);
  } catch (err) {
    console.error("[settings] onestock_token decryption failed", err);
    throw createError({
      statusCode: 500,
      statusMessage: "Cannot decrypt onestock_token: check SETTINGS_ENCRYPTION_KEY (same value as the Extensions application)",
    });
  }
  const stockRequestName =
    rows.find((r) => r.key === "onestock_stock_request_name")?.value?.trim() || DEFAULT_STOCK_REQUEST_NAME;
  const defaultLang = rows.find((r) => r.key === "default_lang")?.value?.trim() || undefined;
  const value = { token: decrypted, apiRoot: normalizeApiRoot(apiRoot), stockRequestName, defaultLang };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
