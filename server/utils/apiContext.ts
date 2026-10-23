import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Environnement OneStock de la requête en cours : `parent_url` (page du back-office qui affiche l'extension) et
 * `api_url` (envoyée par OneStock dans onestock_data). L'API Settings en déduit le token et l'URL d'API à appeler
 * (GET /api/settings/token) ; le parent_url n'est jamais appelé directement.
 */
export interface ApiContext {
  /** parent_url du contexte, s'il est valide (https, hôte OneStock). */
  parentUrl?: string;
  apiUrl?: string;
  /** parent_url reçu mais écarté (motif). */
  rejected?: string;
  /** extension_id OneStock de l'extension (contexte) : ses settings propres sont retenus. */
  extensionId?: string;
}

const store = new AsyncLocalStorage<ApiContext>();

/** Hôtes OneStock acceptés pour parent_url et api_url (mêmes règles que l'API Settings). */
function isOnestockHttps(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)onestock-retail\.(com|dev)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Contexte d'API à partir des valeurs transmises par le front (en-têtes ou paramètres des liens). */
export function apiContextFrom(parentUrl: string | undefined, apiUrl: string | undefined): ApiContext {
  const parent = parentUrl?.trim() || undefined;
  const api = apiUrl?.trim() && isOnestockHttps(apiUrl.trim()) ? apiUrl.trim() : undefined;
  if (!parent) return api ? { apiUrl: api } : {};
  if (!isOnestockHttps(parent)) return { rejected: "invalid_parent_url", ...(api ? { apiUrl: api } : {}) };
  return { parentUrl: parent, ...(api ? { apiUrl: api } : {}) };
}

/** Associe le contexte d'API à la suite de la requête (appelé au début de chaque route, via requireSession). */
export function enterApiContext(ctx: ApiContext) {
  store.enterWith(ctx);
}

export const currentApiContext = (): ApiContext => store.getStore() ?? {};

/** Paramètres à ajouter aux liens ouverts dans un onglet (documents, factures) pour garder l'environnement. */
export function contextQuery(): string {
  const { parentUrl, apiUrl } = currentApiContext();
  return [
    parentUrl ? `&parent_url=${encodeURIComponent(parentUrl)}` : "",
    apiUrl ? `&api_url=${encodeURIComponent(apiUrl)}` : "",
  ].join("");
}
