import { AsyncLocalStorage } from "node:async_hooks";

/** Un appel à l'API OneStock, affiché dans la conversation (« Détails techniques ») pour le diagnostic. */
export interface ApiLogEntry {
  method: string;
  /** URL appelée (racine d'API + chemin). */
  url: string;
  /** Corps envoyé, token masqué. */
  request: unknown;
  status: number;
  /** Corps reçu (tronqué s'il est volumineux). */
  response: unknown;
  ms: number;
  /** Erreur réseau ou d'expiration (pas de réponse). */
  error?: string;
  /** Information calculée par l'assistant (ex. canal de vente retenu), sans appel HTTP. */
  note?: string;
}

const store = new AsyncLocalStorage<ApiLogEntry[]>();
const MAX_CHARS = 20_000;

/** Journal activé sauf CHAT_API_LOGS=false. */
export const apiLogsEnabled = () => process.env.CHAT_API_LOGS?.trim().toLowerCase() !== "false";

/** Exécute `fn` en collectant les appels API qu'il fait ; renvoie son résultat et le journal. */
export async function withApiLog<T>(fn: () => Promise<T>): Promise<{ result: T; entries: ApiLogEntry[] }> {
  const entries: ApiLogEntry[] = [];
  const result = await store.run(entries, fn);
  return { result, entries };
}

/** Masque les secrets (token, mot de passe…) à toute profondeur. */
function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mask);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, /token|password|secret|api_key|apikey/i.test(k) && typeof v === "string" ? "••••••••" : mask(v)]),
  );
}

/** Valeur tronquée pour l'affichage (texte JSON partiel au-delà de MAX_CHARS). */
function truncate(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined || text.length <= MAX_CHARS) return value;
  return `${text.slice(0, MAX_CHARS)}… (${text.length - MAX_CHARS} caractères tronqués)`;
}

/** Ajoute une entrée au journal de l'outil en cours (sans effet hors d'un outil). */
export function logApiCall(entry: ApiLogEntry) {
  const entries = store.getStore();
  if (!entries) return;
  entries.push({ ...entry, request: truncate(mask(entry.request)), response: truncate(mask(entry.response)) });
}
