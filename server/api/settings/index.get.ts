import OpenAI from "openai";
import { requireSession } from "../../utils/session";
import { DEFAULT_STOCK_REQUEST_NAME, databaseUrl, diagnoseSettings, readSettingsRows, settingsApi, settingsSource, type SettingDiagnosticRow } from "../../utils/settings";
import { onestockRequest } from "../../utils/onestock";

/** Une ligne de l'onglet Paramètres. Les secrets ne sont jamais renvoyés : seulement leur présence. */
interface ConfigEntry {
  name: string;
  source: "env" | "settings";
  required: boolean;
  secret: boolean;
  set: boolean;
  /** Valeur affichable (jamais pour un secret). */
  value?: string;
  /** Précision : nombre de clés, valeur par défaut appliquée, chiffrement… */
  note?: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const env = (name: string) => process.env[name]?.trim() || undefined;
const csv = (name: string) => (env(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function envEntry(name: string, opts: { required?: boolean; secret?: boolean; defaultValue?: string; note?: string } = {}): ConfigEntry {
  const value = env(name);
  return {
    name,
    source: "env",
    required: !!opts.required,
    secret: !!opts.secret,
    set: !!value,
    value: opts.secret ? undefined : value ?? opts.defaultValue,
    note: opts.note ?? (!value && opts.defaultValue ? "default" : undefined),
  };
}

/** Détail du test OneStock : statut, message d'erreur de l'API et environment des settings utilisés. */
function onestockDetail(r: { status: number; data: unknown }, ms: number, environment?: string) {
  const msg = typeof r.data === "object" && r.data ? (r.data as { message?: unknown }).message : undefined;
  return [`HTTP ${r.status}`, typeof msg === "string" ? msg : "", environment ? `environment ${environment}` : "", `${ms} ms`]
    .filter(Boolean)
    .join(" · ");
}

/** Portée affichée d'une ligne : site (ou « global ») et extension_id. */
const scopeOf = (r: { site_id: string; extension_id: string; environment: string }) =>
  `${r.site_id || "global"} · ${r.extension_id || "*"} · ${r.environment || "-"}`;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result?: T; error?: string }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ms: Date.now() - start, result };
  } catch (err) {
    return { ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

/** État de la configuration (variables d'environnement et table settings) et tests de connexion, en lecture seule. */
export default defineEventHandler(async (event) => {
  const session = requireSession(event);
  const model = env("OPENAI_MODEL") ?? "gpt-4o";
  const allowedSites = csv("ALLOWED_SITE_IDS");

  const source = settingsSource();
  const viaApi = source === "api";
  const environment: ConfigEntry[] = [
    envEntry("SETTINGS_API_URL", { required: !databaseUrl() }),
    envEntry("SETTINGS_API_KEY", { required: !databaseUrl(), secret: true }),
    envEntry("SETTINGS_EXTENSION_ID", { defaultValue: "*" }),
    {
      ...envEntry("DATABASE_URL", { required: !settingsApi(), secret: true }),
      set: !!databaseUrl(),
      note: viaApi && databaseUrl() ? "unused-api" : !env("DATABASE_URL") && env("POSTGRES_URL") ? "POSTGRES_URL" : undefined,
    },
    envEntry("SETTINGS_ENCRYPTION_KEY", { required: source === "database", secret: true }),
    envEntry("ONESTOCK_ENVIRONMENT", { note: env("ONESTOCK_ENVIRONMENT") ? undefined : "auto" }),
    envEntry("EXTENSION_ID"),
    {
      ...envEntry("ALLOWED_SITE_IDS"),
      value: undefined,
      // Liste des autres sites non exposée : seulement leur nombre et la présence du site courant.
      note: allowedSites.length ? `${allowedSites.length}|${allowedSites.includes(session.siteId) ? "current" : "not-current"}` : undefined,
    },
    envEntry("OPENAI_API_KEY", { required: true, secret: true }),
    envEntry("OPENAI_MODEL", { defaultValue: "gpt-4o" }),
    envEntry("FRAME_ANCESTORS", { defaultValue: "'self' https://*.onestock-retail.com https://*.onestock-retail.dev" }),
  ];
  // Variables de développement local, affichées seulement si elles sont utilisées (pas de base).
  if (source === "env") {
    environment.push(envEntry("ONESTOCK_API_ROOT"), envEntry("ONESTOCK_TOKEN", { secret: true }));
  }

  const checks: Check[] = [];

  // Table settings pour le site de la session (API Settings ou base)
  const db = await timed(() => readSettingsRows(session.siteId));
  const settings: ConfigEntry[] = [];
  const sourceCheck = viaApi ? "settings_api" : "database";
  if (db.result) {
    const { rows, fromEnv } = db.result;
    checks.push({ name: sourceCheck, ok: true, detail: fromEnv ? "env-fallback" : `${db.result.loaded.all.length} · ${db.ms} ms` });
    const token = rows.find((r) => r.key === "onestock_token");
    const apiRoot = rows.find((r) => r.key === "onestock_api_root");
    const stockView = rows.find((r) => r.key === "onestock_stock_request_name");
    const defaultLang = rows.find((r) => r.key === "default_lang");
    settings.push(
      {
        name: "onestock_token",
        source: "settings",
        required: true,
        secret: true,
        set: !!token,
        note: token ? `${token.encrypted ? "encrypted" : "plain"}|${scopeOf(token)}` : undefined,
      },
      {
        name: "onestock_api_root",
        source: "settings",
        required: true,
        secret: false,
        set: !!apiRoot,
        value: apiRoot?.value,
        note: apiRoot ? `|${scopeOf(apiRoot)}` : undefined,
      },
      {
        name: "onestock_stock_request_name",
        source: "settings",
        required: false,
        secret: false,
        set: !!stockView,
        value: stockView?.value ?? DEFAULT_STOCK_REQUEST_NAME,
        note: stockView ? `|${scopeOf(stockView)}` : "default",
      },
      {
        name: "default_lang",
        source: "settings",
        required: false,
        secret: false,
        set: !!defaultLang,
        value: defaultLang?.value ?? "fr",
        note: defaultLang ? `|${scopeOf(defaultLang)}` : "default",
      },
    );
  } else {
    checks.push({ name: sourceCheck, ok: false, detail: source ? db.error ?? "" : "no-source" });
  }

  // Toutes les lignes de la table pour ces clés (sans valeur) et test du déchiffrement du token.
  let rows: SettingDiagnosticRow[] = [];
  if (db.result && !db.result.fromEnv) {
    const diag = diagnoseSettings(db.result.loaded);
    rows = diag.rows;
    checks.push({ name: "decrypt", ok: diag.decrypt === "ok", detail: diag.decrypt });
  }

  // API OneStock : une recherche d'une seule commande valide l'URL et le token.
  if (settings.filter((s) => s.required).every((s) => s.set) && db.result) {
    const os = await timed(() =>
      onestockRequest(session.siteId, "GET", "/v2/search_orders", {
        fields: ["id"],
        pagination: { limit: 1 },
      }),
    );
    checks.push(
      os.result
        ? { name: "onestock", ok: os.result.ok, detail: onestockDetail(os.result, os.ms, db.result?.loaded.environment) }
        : { name: "onestock", ok: false, detail: os.error ?? "" },
    );
  } else {
    checks.push({ name: "onestock", ok: false, detail: "missing-settings" });
  }

  // API OpenAI : lecture du modèle configuré (aucun token consommé).
  if (env("OPENAI_API_KEY")) {
    const ai = await timed(() => new OpenAI().models.retrieve(model));
    checks.push(
      ai.result
        ? { name: "openai", ok: true, detail: `${ai.result.id} · ${ai.ms} ms` }
        : { name: "openai", ok: false, detail: ai.error ?? "" },
    );
  } else {
    checks.push({ name: "openai", ok: false, detail: "missing-key" });
  }

  return {
    source: source ?? null,
    environment_used: db.result?.loaded.environment ?? null,
    session: { site_id: session.siteId, user_id: session.userId, extension_id: session.extensionId },
    environment,
    settings,
    checks,
    rows,
  };
});
