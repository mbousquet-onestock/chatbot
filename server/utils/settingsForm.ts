import { createHash, timingSafeEqual } from "node:crypto";
import OpenAI from "openai";
import { onestockRequest } from "./onestock";
import { databaseUrl, getOnestockSettings, normalizeApiRoot, pingDatabase, DEFAULT_STOCK_REQUEST_NAME } from "./settings";

/** Valeurs saisies dans l'onglet Paramètres (champ vide = valeur actuelle conservée). */
export interface SettingsFormValues {
  onestock_api_root?: string;
  onestock_token?: string;
  onestock_stock_request_name?: string;
  default_lang?: string;
}

export interface ConnectionTest {
  name: "database" | "onestock" | "stock_view" | "default_lang" | "openai";
  ok: boolean;
  detail: string;
}

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Configuration à tester ou enregistrer : valeurs saisies, complétées par la configuration actuelle.
 * Le token enregistré n'est jamais envoyé à une nouvelle URL d'API : il faut alors saisir le token.
 */
export async function resolveCandidate(siteId: string, values: SettingsFormValues) {
  const current = await getOnestockSettings(siteId).catch(() => undefined);
  const apiRoot = clean(values.onestock_api_root) ? normalizeApiRoot(clean(values.onestock_api_root)) : current?.apiRoot;
  const apiRootChanged = !!current?.apiRoot && !!apiRoot && apiRoot !== current.apiRoot;
  const typedToken = clean(values.onestock_token);
  if (!typedToken && apiRootChanged) throw createError({ statusCode: 400, statusMessage: "token_required_for_new_api_root" });
  const token = typedToken || current?.token;
  return {
    apiRoot,
    token,
    stockRequestName: clean(values.onestock_stock_request_name) || current?.stockRequestName || DEFAULT_STOCK_REQUEST_NAME,
    defaultLang: clean(values.default_lang) || current?.defaultLang || "fr",
    apiRootChanged,
  };
}

async function timed(fn: () => Promise<{ ok: boolean; detail: string }>): Promise<{ ok: boolean; detail: string }> {
  const start = Date.now();
  try {
    const r = await fn();
    return { ok: r.ok, detail: [r.detail, `${Date.now() - start} ms`].filter(Boolean).join(" · ") };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const httpDetail = (status: number, data: unknown) => {
  const msg = typeof data === "object" && data ? (data as { message?: unknown }).message : undefined;
  return `HTTP ${status}${typeof msg === "string" ? ` · ${msg}` : ""}`;
};

/** Teste les connexions nécessaires au chatbot avec la configuration candidate. */
export async function testConnections(siteId: string, values: SettingsFormValues): Promise<ConnectionTest[]> {
  const c = await resolveCandidate(siteId, values);
  const tests: ConnectionTest[] = [];

  tests.push({
    name: "database",
    ...(databaseUrl()
      ? await timed(async () => ({ ok: true, detail: `settings : ${await pingDatabase()} ligne(s)` }))
      : { ok: false, detail: "missing-database" }),
  });

  if (!c.apiRoot || !c.token) {
    tests.push({ name: "onestock", ok: false, detail: !c.apiRoot ? "missing-api-root" : "missing-token" });
  } else {
    const config = { apiRoot: c.apiRoot, token: c.token };
    // API OneStock : URL et token, par une recherche d'une seule commande.
    tests.push({
      name: "onestock",
      ...(await timed(async () => {
        const r = await onestockRequest(siteId, "GET", "/v2/search_orders", { fields: ["id"], pagination: { limit: 1 } }, config);
        return { ok: r.ok, detail: httpDetail(r.status, r.data) };
      })),
    });
    // Vue de stock : requête de stock sur un article fictif (réponse vide attendue si la vue existe).
    tests.push({
      name: "stock_view",
      ...(await timed(async () => {
        const r = await onestockRequest(siteId, "GET", "/v1/stock_export", {
          request_name: c.stockRequestName,
          aggregates: { "*": { item_filter: { ids: ["__chatbot_connection_test__"] } } },
        }, config);
        return { ok: r.ok, detail: `${c.stockRequestName} · ${httpDetail(r.status, r.data)}` };
      })),
    });
    // Langue par défaut : lecture d'un article du catalogue dans cette langue.
    tests.push({
      name: "default_lang",
      ...(await timed(async () => {
        const r = await onestockRequest(siteId, "GET", "/v3/items", {
          lang: c.defaultLang,
          features: ["name"],
          pagination: { limit: 1, start: 0 },
          get_total: false,
        }, config);
        return { ok: r.ok, detail: `${c.defaultLang} · ${httpDetail(r.status, r.data)}` };
      })),
    });
  }

  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o";
  tests.push({
    name: "openai",
    ...(process.env.OPENAI_API_KEY?.trim()
      ? await timed(async () => ({ ok: true, detail: (await new OpenAI().models.retrieve(model)).id }))
      : { ok: false, detail: "missing-key" }),
  });
  return tests;
}

/** Vérifie le mot de passe administrateur (SETTINGS_ADMIN_PASSWORD) ; enregistrement désactivé sans lui. */
export function checkAdminPassword(password: unknown) {
  const expected = process.env.SETTINGS_ADMIN_PASSWORD?.trim();
  if (!expected) throw createError({ statusCode: 403, statusMessage: "admin_password_not_configured" });
  const digest = (v: string) => createHash("sha256").update(v).digest();
  if (typeof password !== "string" || !timingSafeEqual(digest(password), digest(expected))) {
    throw createError({ statusCode: 403, statusMessage: "invalid_admin_password" });
  }
}
