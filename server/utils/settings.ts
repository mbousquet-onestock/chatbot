import { neon } from "@neondatabase/serverless";
import { decryptSetting } from "../lib/settings-secrets.mjs";
import { currentApiContext } from "./apiContext";

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
  /** Clé sensible dont l'API Settings n'a pas renvoyé la valeur (value null malgré decrypt=1). */
  hidden?: boolean;
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
    // Clé sensible sans valeur : la liste ne l'a pas déchiffrée (relue ensuite ligne par ligne).
    ...(value == null && !r.decrypt_error && (r.secret === true || /token/.test(str(r.key))) ? { hidden: true } : {}),
  };
}

/** Toutes les lignes des clés utiles au chatbot, depuis la source configurée. */
async function fetchAllRows(source: SettingsSource): Promise<StoredSetting[]> {
  const environment = env("ONESTOCK_ENVIRONMENT");
  if (source === "api") {
    const lists = await Promise.all(
      KEYS.map((key) => {
        // Pas de filtre d'environment ici : selectRows l'applique, et le diagnostic montre les lignes écartées.
        const qs = new URLSearchParams({ key, decrypt: "1", limit: "5000" });
        return settingsApiFetch(`?${qs}`);
      }),
    );
    const rows = lists.flatMap((d) => (Array.isArray(d.settings) ? d.settings : []).map((r) => toStored(r as Record<string, unknown>)));
    // Token sans valeur dans la liste : lecture de la ligne exacte par GET /item?decrypt=1.
    await Promise.all(rows.filter((r) => r.hidden).map(async (r) => {
      try {
        const qs = new URLSearchParams({ key: r.key, site_id: r.site_id, extension_id: r.extension_id, environment: r.environment, decrypt: "1" });
        const item = (await settingsApiFetch(`/item?${qs}`)).setting as Record<string, unknown> | undefined;
        if (item) {
          delete r.hidden;
          Object.assign(r, toStored(item));
        }
      } catch (err) {
        console.warn("[settings] item read failed", r.key, err);
      }
    }));
    return rows;
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
  const sameEnv = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const hasValue = (x: StoredSetting) => !!(x.value || x.decrypt_error || x.hidden);
  // Sans ONESTOCK_ENVIRONMENT : environment de la meilleure onestock_api_root qui a aussi un token dans le même
  // environment (sinon celui de la meilleure onestock_api_root).
  const roots = applicable.filter((r) => r.key === "onestock_api_root" && r.value).sort((a, b) => score(b) - score(a));
  const withToken = roots.find((root) => applicable.some((t) => t.key === "onestock_token" && hasValue(t) && sameEnv(t.environment, root.environment)));
  const configured = env("ONESTOCK_ENVIRONMENT");
  const environment = configured ?? (withToken ?? roots[0])?.environment;
  const environmentSource: "variable" | "api_root" | undefined = configured ? "variable" : environment !== undefined ? "api_root" : undefined;
  const inEnv = applicable.filter((r) => environment === undefined || sameEnv(r.environment, environment));

  const used = new Map<string, StoredSetting>();
  for (const key of KEYS) {
    const r = best(inEnv.filter((x) => x.key === key && hasValue(x)));
    if (r) used.set(key, r);
  }
  const status = (r: StoredSetting): RowStatus =>
    !siteOk(r) ? "other_site"
      : !extOk(r) ? "other_extension"
        : environment !== undefined && !sameEnv(r.environment, environment) ? "other_environment"
          : used.get(r.key) === r ? "used" : "shadowed";
  return { used, environment, environmentSource, status };
}

export interface LoadedSettings {
  source: SettingsSource;
  /** Toutes les lignes des clés du chatbot (tous sites, extensions et environments). */
  all: StoredSetting[];
  used: Map<string, StoredSetting>;
  /** Environment retenu (ONESTOCK_ENVIRONMENT ou celui de l'URL d'API retenue). */
  environment?: string;
  environmentSource?: "variable" | "api_root";
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
  if (r.hidden) throw new Error("the Settings API returned onestock_token without its value (value null even with decrypt=1): check SETTINGS_ENCRYPTION_KEY of the Extensions application");
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
      empty: !r.value && !r.decrypt_error && !r.hidden,
      status: loaded.status(r),
    }));
  const token = loaded.used.get("onestock_token");
  let decrypt = "no_token";
  if (!token) {
    // Pourquoi aucune ligne onestock_token n'est retenue : raison de chaque ligne écartée.
    const tokens = loaded.all.filter((r) => r.key === "onestock_token");
    decrypt = tokens.length
      ? `no_token: ${tokens.map((r) => `[site ${r.site_id || "global"} · extension ${r.extension_id || "*"} · environment ${r.environment || "-"} → ${
        !r.value && !r.decrypt_error && !r.hidden ? "empty value" : loaded.status(r).replace(/_/g, " ")
      }]`).join(" ")}${loaded.environment ? ` · selected environment: ${loaded.environment} (${loaded.environmentSource === "variable" ? "ONESTOCK_ENVIRONMENT" : "from onestock_api_root"})` : ""}`
      : "no_token_rows";
  } else {
    try {
      decrypt = plainToken(token) ? "ok" : "empty";
    } catch (err) {
      decrypt = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { rows, decrypt };
}

/** Configuration OneStock en clair d'un site, gardée 5 min en cache mémoire. */
/** Token OneStock et URL d'API d'un parent_url (GET /api/settings/token), sans repli sur un autre token. */
export async function readParentUrlCredentials(parentUrl: string, siteId: string, apiUrl?: string): Promise<{ token: string; apiRoot?: string }> {
  const qs = new URLSearchParams({ parent_url: parentUrl, decrypt: "1", site_id: siteId });
  if (apiUrl) qs.set("api_url", apiUrl);
  let data: Record<string, unknown>;
  try {
    data = await settingsApiFetch(`/token?${qs}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP 404/.test(message)) {
      throw new Error(`no OneStock token for ${parentUrl}: enter it in the Extensions application (Settings → OneStock token, opened from this OneStock environment)`);
    }
    throw err;
  }
  const token = typeof data.token === "string" ? data.token : "";
  if (!token) throw new Error(`the Settings API returned no token value for ${parentUrl} (decrypt=1)`);
  const apiRoot = typeof data.api_root === "string" && data.api_root ? data.api_root : apiUrl;
  return { token, apiRoot };
}

export async function getOnestockSettings(siteId: string): Promise<OnestockSettings> {
  const ctx = currentApiContext();
  if (ctx.rejected) {
    throw createError({ statusCode: 400, statusMessage: "invalid_parent_url: parent_url must be an https URL of a OneStock host" });
  }
  // Un token par environnement OneStock : le parent_url fait partie de la clé de cache.
  const byParent = !!ctx.parentUrl && !!settingsApi();
  const cacheKey = byParent ? `parent|${ctx.parentUrl}|${ctx.apiUrl ?? ""}|${siteId}` : `${env("ONESTOCK_ENVIRONMENT") ?? ""}|${siteId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  if (byParent) {
    let creds: { token: string; apiRoot?: string };
    try {
      creds = await readParentUrlCredentials(ctx.parentUrl!, siteId, ctx.apiUrl);
    } catch (err) {
      console.error("[settings] token by parent_url failed", { parentUrl: ctx.parentUrl, err });
      throw createError({ statusCode: 500, statusMessage: `Cannot read the OneStock token: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (!creds.apiRoot) {
      throw createError({ statusCode: 500, statusMessage: `No OneStock API URL for ${ctx.parentUrl} (api_root not returned by the Settings API)` });
    }
    // Autres réglages (vue de stock, langue) : lignes de la table, facultatives.
    const loaded = await loadSettings(siteId).catch(() => undefined);
    const value = {
      token: creds.token,
      apiRoot: normalizeApiRoot(creds.apiRoot),
      stockRequestName: loaded?.used.get("onestock_stock_request_name")?.value?.trim() || DEFAULT_STOCK_REQUEST_NAME,
      defaultLang: loaded?.used.get("default_lang")?.value?.trim() || undefined,
    };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

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
        ? `Cannot read onestock_token: ${err instanceof Error ? err.message : String(err)}`
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
