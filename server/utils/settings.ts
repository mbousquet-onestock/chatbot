import { neon } from "@neondatabase/serverless";
import { decryptSetting } from "../lib/settings-secrets.mjs";
import { encryptSetting } from "./encrypt";

/**
 * Configuration OneStock d'un site, lue dans la table `settings` de l'application Extensions : par l'API Settings
 * (`SETTINGS_API_URL` + `SETTINGS_API_KEY`, recommandé) ou directement en base (`DATABASE_URL`).
 */
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

const env = (name: string) => process.env[name]?.trim() || undefined;

/** URL de la base : `DATABASE_URL` (Neon) ou `POSTGRES_URL` (intégration Vercel Postgres). */
export function databaseUrl(): string | undefined {
  return env("DATABASE_URL") || env("POSTGRES_URL");
}

/** API Settings de l'application Extensions (URL de base `…/api/settings` et clé d'API). */
export function settingsApi(): { url: string; key: string } | undefined {
  const url = env("SETTINGS_API_URL")?.replace(/\/+$/, "");
  const key = env("SETTINGS_API_KEY");
  return url && key ? { url, key } : undefined;
}

export type SettingsSource = "api" | "database" | "env";

/** Source de la configuration : API Settings, sinon base, sinon variables ONESTOCK_* (développement local). */
export function settingsSource(): SettingsSource | undefined {
  if (settingsApi()) return "api";
  if (databaseUrl()) return "database";
  if (env("ONESTOCK_API_ROOT") && env("ONESTOCK_TOKEN")) return "env";
  return undefined;
}

/** `extension_id` propre au chatbot dans la table settings (facultatif ; `*` = settings généraux). */
const settingsExtensionId = () => env("SETTINGS_EXTENSION_ID");

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

/** Une ligne de la table settings. Par l'API, la valeur d'une clé sensible est déjà déchiffrée. */
export interface StoredSetting {
  key: string;
  value: string | null;
  site_id: string;
  extension_id: string;
  environment: string;
  /** Valeur stockée chiffrée en base (enc:v1:). */
  encrypted: boolean;
  /** L'API Settings n'a pas pu déchiffrer la valeur (mauvaise SETTINGS_ENCRYPTION_KEY côté Extensions). */
  decrypt_error?: boolean;
}

/** Ligne retenue pour une clé (compatibilité : valeur non nulle). */
export interface SettingRow {
  key: string;
  value: string;
  site_id: string;
  extension_id: string;
  environment: string;
  encrypted: boolean;
}

/** Appel à l'API Settings ; les erreurs portent le code renvoyé (`{ "error": "<code>: <détail>" }`). */
async function settingsApiFetch(path: string, init: RequestInit = {}) {
  const api = settingsApi();
  if (!api) throw new Error("SETTINGS_API_URL / SETTINGS_API_KEY are not set");
  const res = await fetch(`${api.url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${api.key}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Settings API HTTP ${res.status}: ${typeof data.error === "string" ? data.error : res.statusText}`);
  return data;
}

const str = (v: unknown) => (v == null ? "" : String(v));

function toStored(r: Record<string, unknown>): StoredSetting {
  const value = r.value == null ? null : String(r.value);
  return {
    key: str(r.key),
    value,
    site_id: str(r.site_id),
    extension_id: str(r.extension_id),
    environment: str(r.environment),
    encrypted: typeof r.encrypted === "boolean" ? r.encrypted : !!value?.startsWith("enc:v1:"),
    ...(r.decrypt_error ? { decrypt_error: true } : {}),
  };
}

/** Toutes les lignes des clés utiles au chatbot, depuis la source configurée. */
async function fetchAllRows(source: SettingsSource): Promise<StoredSetting[]> {
  const environment = env("ONESTOCK_ENVIRONMENT");
  if (source === "api") {
    const lists = await Promise.all(
      KEYS.map((key) => {
        const qs = new URLSearchParams({ key, decrypt: "1", limit: "5000" });
        if (environment) qs.set("environment", environment);
        return settingsApiFetch(`?${qs}`);
      }),
    );
    return lists.flatMap((d) => (Array.isArray(d.settings) ? d.settings : []).map((r) => toStored(r as Record<string, unknown>)));
  }
  if (source === "database") {
    const rows = (await sql()`SELECT * FROM settings WHERE key = ANY(${KEYS as unknown as string[]})`) as Record<string, unknown>[];
    return rows.map(toStored);
  }
  const stock = env("ONESTOCK_STOCK_REQUEST_NAME");
  const row = (key: string, value: string): StoredSetting => ({
    key, value, site_id: "", extension_id: "*", environment: environment ?? "", encrypted: value.startsWith("enc:v1:"),
  });
  return [
    row("onestock_token", env("ONESTOCK_TOKEN")!),
    row("onestock_api_root", env("ONESTOCK_API_ROOT")!),
    ...(stock ? [row("onestock_stock_request_name", stock)] : []),
  ];
}

const isGlobalSite = (s: string) => s === "" || s === "*";
const isGeneralExtension = (e: string) => e === "" || e === "*";

/** Pourquoi une ligne est (ou n'est pas) utilisée pour ce site. */
export type RowStatus = "used" | "shadowed" | "other_site" | "other_extension" | "other_environment";

/**
 * Choix des lignes applicables à un site, une par clé :
 * - site : la valeur du site est prioritaire sur la valeur globale (`site_id` vide ou `*`) ;
 * - extension : `SETTINGS_EXTENSION_ID` est prioritaire sur les settings généraux (`*`), les autres extensions
 *   sont ignorées ;
 * - environment : `ONESTOCK_ENVIRONMENT` s'il est défini ; sinon celui de l'`onestock_api_root` retenue, pour que
 *   le token et l'URL viennent toujours du même environment (un token de prod n'est jamais envoyé en qualif).
 */
export function selectRows(all: StoredSetting[], siteId: string) {
  const extensionId = settingsExtensionId();
  const siteOk = (r: StoredSetting) => r.site_id === siteId || isGlobalSite(r.site_id);
  const extOk = (r: StoredSetting) => isGeneralExtension(r.extension_id) || (!!extensionId && r.extension_id === extensionId);
  const score = (r: StoredSetting) => (r.site_id === siteId ? 2 : 0) + (isGeneralExtension(r.extension_id) ? 0 : 1);
  const best = (rows: StoredSetting[]) =>
    rows.reduce<StoredSetting | undefined>((acc, r) => (!acc || score(r) > score(acc) ? r : acc), undefined);

  const applicable = all.filter((r) => siteOk(r) && extOk(r));
  const environment =
    env("ONESTOCK_ENVIRONMENT") ?? best(applicable.filter((r) => r.key === "onestock_api_root" && r.value))?.environment;
  const inEnv = applicable.filter((r) => environment === undefined || r.environment === environment);

  const used = new Map<string, StoredSetting>();
  for (const key of KEYS) {
    const r = best(inEnv.filter((x) => x.key === key && (x.value || x.decrypt_error)));
    if (r) used.set(key, r);
  }
  const status = (r: StoredSetting): RowStatus =>
    !siteOk(r) ? "other_site"
      : !extOk(r) ? "other_extension"
        : environment !== undefined && r.environment !== environment ? "other_environment"
          : used.get(r.key) === r ? "used" : "shadowed";
  return { used, environment, status };
}

export interface LoadedSettings {
  source: SettingsSource;
  /** Toutes les lignes des clés du chatbot (tous sites, extensions et environments). */
  all: StoredSetting[];
  used: Map<string, StoredSetting>;
  /** Environment retenu (ONESTOCK_ENVIRONMENT ou celui de l'URL d'API retenue). */
  environment?: string;
  status: (r: StoredSetting) => RowStatus;
}

/** Lit la configuration du site depuis la source configurée. */
export async function loadSettings(siteId: string): Promise<LoadedSettings> {
  const source = settingsSource();
  if (!source) throw new Error("No settings source: set SETTINGS_API_URL + SETTINGS_API_KEY (or DATABASE_URL)");
  const all = await fetchAllRows(source);
  return { source, all, ...selectRows(all, siteId) };
}

/** Lignes retenues pour un site (une par clé). */
export async function readSettingsRows(siteId: string): Promise<{ rows: SettingRow[]; fromEnv: boolean; source: SettingsSource; loaded: LoadedSettings }> {
  const loaded = await loadSettings(siteId);
  const rows = [...loaded.used.values()]
    .filter((r): r is StoredSetting & { value: string } => r.value != null)
    .map(({ key, value, site_id, extension_id, environment, encrypted }) => ({ key, value, site_id, extension_id, environment, encrypted }));
  return { rows, fromEnv: loaded.source === "env", source: loaded.source, loaded };
}

/** Ligne de `settings` vue par le diagnostic (sans sa valeur). */
export interface SettingDiagnosticRow {
  key: string;
  site_id: string;
  extension_id: string;
  environment: string;
  encrypted: boolean;
  empty: boolean;
  status: RowStatus;
}

/** Déchiffre un token lu en base ; par l'API Settings (decrypt=1) il est déjà en clair. */
function plainToken(r: StoredSetting): string {
  if (r.decrypt_error) throw new Error("the Settings API could not decrypt onestock_token (SETTINGS_ENCRYPTION_KEY of the Extensions application)");
  const v = r.value ?? "";
  return v.startsWith("enc:v1:") ? decryptSetting(v) : v;
}

/**
 * Toutes les lignes des clés du chatbot, sans leur valeur, avec la raison pour laquelle chacune est retenue ou
 * ignorée pour ce site, et le résultat de la lecture du token retenu.
 */
export function diagnoseSettings(loaded: LoadedSettings): { rows: SettingDiagnosticRow[]; decrypt: string } {
  const order = (r: StoredSetting) => `${r.key}|${r.environment}|${r.extension_id}|${r.site_id}`;
  const rows = [...loaded.all]
    .sort((a, b) => order(a).localeCompare(order(b)))
    .map((r) => ({
      key: r.key,
      site_id: r.site_id,
      extension_id: r.extension_id,
      environment: r.environment,
      encrypted: r.encrypted,
      empty: !r.value && !r.decrypt_error,
      status: loaded.status(r),
    }));
  const token = loaded.used.get("onestock_token");
  let decrypt = "no_token";
  if (token) {
    try {
      decrypt = plainToken(token) ? "ok" : "empty";
    } catch (err) {
      decrypt = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { rows, decrypt };
}

/** Vérifie que la source répond (nombre de lignes `onestock_api_root` visibles). */
export async function pingSettingsSource(): Promise<{ source: SettingsSource; count: number }> {
  const source = settingsSource();
  if (source === "api") {
    const d = await settingsApiFetch(`?${new URLSearchParams({ key: "onestock_api_root", limit: "1000" })}`);
    return { source, count: typeof d.count === "number" ? d.count : Array.isArray(d.settings) ? d.settings.length : 0 };
  }
  if (source === "database") {
    const rows = (await sql()`SELECT count(*)::int AS n FROM settings`) as { n: number }[];
    return { source, count: rows[0]?.n ?? 0 };
  }
  throw new Error("No settings source: set SETTINGS_API_URL + SETTINGS_API_KEY (or DATABASE_URL)");
}

/** Clés modifiables depuis l'onglet Paramètres. */
export const EDITABLE_KEYS = ["onestock_api_root", "onestock_token", "onestock_stock_request_name", "default_lang"] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];

/** Vide le cache de configuration (après un enregistrement). */
export function clearSettingsCache() {
  cache.clear();
}

let dbColumns: Promise<Set<string>> | undefined;
const settingsColumns = () =>
  (dbColumns ??= (sql()`SELECT column_name FROM information_schema.columns WHERE table_name = 'settings'` as unknown as Promise<{ column_name: string }[]>)
    .then((rows) => new Set(rows.map((r) => r.column_name))));

/**
 * Enregistre une valeur en clair pour (key, site_id, extension_id, environment) : mise à jour, sinon création.
 * `siteId` vide = valeur globale. Par l'API Settings, le token est chiffré par l'application Extensions ; en base,
 * il est chiffré ici (enc:v1:).
 */
export async function writeSetting(
  key: EditableKey,
  value: string,
  siteId: string,
  environment: string,
): Promise<"updated" | "inserted"> {
  const extensionId = settingsExtensionId() ?? "*";
  if (settingsApi()) {
    const qs = new URLSearchParams({ key, site_id: siteId, extension_id: extensionId, environment, upsert: "1" });
    const res = await fetch(`${settingsApi()!.url}/item?${qs}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${settingsApi()!.key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(`Settings API HTTP ${res.status}: ${data.error ?? res.statusText}`);
    return res.status === 201 ? "inserted" : "updated";
  }

  const stored = key === "onestock_token" ? encryptSetting(value) : value;
  const hasExtension = (await settingsColumns()).has("extension_id");
  const ext = hasExtension ? extensionId : null;
  const updated = (await sql()`
    UPDATE settings SET value = ${stored}
    WHERE key = ${key} AND coalesce(site_id, '') = ${siteId} AND environment = ${environment}
      AND (${ext}::text IS NULL OR extension_id = ${ext})
    RETURNING key`) as unknown[];
  if (updated.length) return "updated";
  if (hasExtension) {
    await sql()`INSERT INTO settings (key, value, site_id, extension_id, environment) VALUES (${key}, ${stored}, ${siteId}, ${extensionId}, ${environment})`;
  } else {
    await sql()`INSERT INTO settings (key, value, site_id, environment) VALUES (${key}, ${stored}, ${siteId}, ${environment})`;
  }
  return "inserted";
}

/** Configuration OneStock en clair d'un site, gardée 5 min en cache mémoire. */
export async function getOnestockSettings(siteId: string): Promise<OnestockSettings> {
  const cacheKey = `${env("ONESTOCK_ENVIRONMENT") ?? ""}|${siteId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let loaded: LoadedSettings;
  try {
    loaded = await loadSettings(siteId);
  } catch (err) {
    console.error("[settings] read failed", err);
    throw createError({ statusCode: 500, statusMessage: `Cannot read settings: ${err instanceof Error ? err.message : String(err)}` });
  }
  const token = loaded.used.get("onestock_token");
  const apiRoot = loaded.used.get("onestock_api_root")?.value;
  if (!token || !apiRoot) {
    const missing = [!token && "onestock_token", !apiRoot && "onestock_api_root"].filter(Boolean).join(", ");
    console.error("[settings] missing", { siteId, environment: loaded.environment ?? null, missing });
    throw createError({
      statusCode: 500,
      statusMessage: `Missing settings for site ${siteId}${loaded.environment ? ` and environment ${loaded.environment}` : ""}: ${missing}`,
    });
  }

  let plain: string;
  try {
    plain = plainToken(token);
  } catch (err) {
    console.error("[settings] onestock_token decryption failed", err);
    throw createError({
      statusCode: 500,
      statusMessage: loaded.source === "api"
        ? "Cannot decrypt onestock_token: the Settings API returned decrypt_error (SETTINGS_ENCRYPTION_KEY of the Extensions application)"
        : "Cannot decrypt onestock_token: check SETTINGS_ENCRYPTION_KEY (same value as the Extensions application)",
    });
  }
  if (!plain) throw createError({ statusCode: 500, statusMessage: "onestock_token is empty" });
  const stockRequestName = loaded.used.get("onestock_stock_request_name")?.value?.trim() || DEFAULT_STOCK_REQUEST_NAME;
  const defaultLang = loaded.used.get("default_lang")?.value?.trim() || undefined;
  const value = { token: plain, apiRoot: normalizeApiRoot(apiRoot), stockRequestName, defaultLang };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
