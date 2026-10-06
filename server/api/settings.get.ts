import Anthropic from "@anthropic-ai/sdk";
import { requireSession } from "../utils/session";
import { databaseUrl, readSettingsRows } from "../utils/settings";
import { onestockRequest } from "../utils/onestock";

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

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result?: T; error?: string }> {
  const start = Date.now();
  try {
    return { ms: Date.now() - start, result: await fn() };
  } catch (err) {
    return { ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

/** État de la configuration (variables d'environnement et table settings) et tests de connexion, en lecture seule. */
export default defineEventHandler(async (event) => {
  const session = requireSession(event);
  const model = env("ANTHROPIC_MODEL") ?? "claude-opus-5-5";
  const allowedSites = csv("ALLOWED_SITE_IDS");

  const environment: ConfigEntry[] = [
    {
      ...envEntry("DATABASE_URL", { required: true, secret: true }),
      set: !!databaseUrl(),
      note: !env("DATABASE_URL") && env("POSTGRES_URL") ? "POSTGRES_URL" : undefined,
    },
    envEntry("SETTINGS_ENCRYPTION_KEY", { required: true, secret: true }),
    envEntry("ONESTOCK_ENVIRONMENT", { note: env("ONESTOCK_ENVIRONMENT") ? undefined : "all" }),
    envEntry("EXTENSION_ID"),
    {
      ...envEntry("ALLOWED_SITE_IDS"),
      value: undefined,
      // Liste des autres sites non exposée : seulement leur nombre et la présence du site courant.
      note: allowedSites.length ? `${allowedSites.length}|${allowedSites.includes(session.siteId) ? "current" : "not-current"}` : undefined,
    },
    envEntry("ANTHROPIC_API_KEY", { required: true, secret: true }),
    envEntry("ANTHROPIC_MODEL", { defaultValue: "claude-opus-5-5" }),
    envEntry("FRAME_ANCESTORS", { defaultValue: "'self' https://*.onestock-retail.com https://*.onestock-retail.dev" }),
  ];
  // Variables de développement local, affichées seulement si elles sont utilisées (pas de base).
  if (!databaseUrl() && (env("ONESTOCK_API_ROOT") || env("ONESTOCK_TOKEN"))) {
    environment.push(envEntry("ONESTOCK_API_ROOT"), envEntry("ONESTOCK_TOKEN", { secret: true }));
  }

  const checks: Check[] = [];

  // Table settings pour le site de la session
  const db = await timed(() => readSettingsRows(session.siteId));
  const settings: ConfigEntry[] = [];
  if (db.result) {
    const { rows, fromEnv } = db.result;
    checks.push({ name: "database", ok: true, detail: fromEnv ? "env-fallback" : `${db.ms} ms` });
    const token = rows.find((r) => r.key === "onestock_token");
    const apiRoot = rows.find((r) => r.key === "onestock_api_root");
    settings.push(
      {
        name: "onestock_token",
        source: "settings",
        required: true,
        secret: true,
        set: !!token,
        note: token ? `${token.encrypted ? "encrypted" : "plain"}|${token.site_id || "*"}` : undefined,
      },
      {
        name: "onestock_api_root",
        source: "settings",
        required: true,
        secret: false,
        set: !!apiRoot,
        value: apiRoot?.value,
        note: apiRoot ? `|${apiRoot.site_id || "*"}` : undefined,
      },
    );
  } else {
    checks.push({ name: "database", ok: false, detail: db.error ?? "" });
  }

  // API OneStock : une recherche d'une seule commande valide l'URL et le token.
  if (settings.every((s) => s.set) && db.result) {
    const os = await timed(() =>
      onestockRequest(session.siteId, "GET", "/v2/search_orders", {
        fields: ["id"],
        pagination: { limit: 1 },
      }),
    );
    checks.push(
      os.result
        ? { name: "onestock", ok: os.result.ok, detail: `HTTP ${os.result.status} · ${os.ms} ms` }
        : { name: "onestock", ok: false, detail: os.error ?? "" },
    );
  } else {
    checks.push({ name: "onestock", ok: false, detail: "missing-settings" });
  }

  // API Claude : lecture du modèle configuré (aucun token consommé).
  if (env("ANTHROPIC_API_KEY")) {
    const ai = await timed(() => new Anthropic().models.retrieve(model));
    checks.push(
      ai.result
        ? { name: "anthropic", ok: true, detail: `${ai.result.display_name} · ${ai.ms} ms` }
        : { name: "anthropic", ok: false, detail: ai.error ?? "" },
    );
  } else {
    checks.push({ name: "anthropic", ok: false, detail: "missing-key" });
  }

  return {
    session: { site_id: session.siteId, user_id: session.userId, extension_id: session.extensionId },
    environment,
    settings,
    checks,
  };
});
