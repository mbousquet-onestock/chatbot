/**
 * Catalogue des API OneStock (server/data/onestock-api.json, généré par scripts/build_api_catalog.py à partir de
 * la spécification OpenAPI) : recherche d'opérations, documentation d'une opération et contrôle d'un appel.
 */

export interface ApiOperation {
  m: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Chemin sans version, ex. /zones/{id}. */
  p: string;
  /** Version de la route (v1…v4). */
  v: string;
  tag: string;
  /** Résumé court. */
  s: string;
  /** Description longue (si elle dépasse le résumé). */
  d?: string;
  /** Schéma du corps (nom dans `schemas`) ou schéma en ligne. */
  schema?: string;
  inline?: Schema;
  /** Exemple de corps (objet, ou texte tronqué). */
  ex?: unknown;
  params?: { name: string; in: string; required: boolean }[];
}

type Schema = Record<string, any>;

interface Catalog {
  operations: ApiOperation[];
  schemas: Record<string, Schema>;
}

/**
 * Catégories et routes jamais exposées au chatbot : identifiants, mots de passe, tokens et droits d'accès.
 * L'assistant ne doit ni lire ni modifier les accès à OneStock.
 */
const BLOCKED_TAGS = new Set(["Authentication", "Access Control List", "gateway"]);
const BLOCKED_PATH = /login|logout|password|passwd|token|captcha|credential|api_key|secret/i;

/** Champs ajoutés par le serveur à chaque appel : jamais fournis par le modèle. */
const AUTH_FIELDS = new Set(["site_id", "token"]);

let catalog: Promise<Catalog> | undefined;

/** Catalogue chargé depuis les assets serveur (une fois par instance). */
export function loadCatalog(): Promise<Catalog> {
  catalog ??= useStorage("assets:onestock")
    .getItem("onestock-api.json")
    .then((raw) => {
      const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as Catalog | null;
      if (!value?.operations) throw new Error("OneStock API catalog not found (server/data/onestock-api.json)");
      return value;
    })
    .catch((err) => {
      catalog = undefined;
      throw err;
    });
  return catalog;
}

export const isAllowedOperation = (op: ApiOperation) => !BLOCKED_TAGS.has(op.tag) && !BLOCKED_PATH.test(op.p);
export const isReadOperation = (op: ApiOperation) => op.m === "GET";
export const operationPath = (op: ApiOperation) => `/${op.v}${op.p}`;

const STOPWORDS = new Set(["de", "du", "des", "la", "le", "les", "un", "une", "et", "en", "pour", "au", "aux", "sur", "par", "the", "of", "to", "and", "for", "an"]);
const words = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));

/** Synonymes français → termes de l'API, pour la recherche. */
const SYNONYMS: Record<string, string[]> = {
  commande: ["order", "orders"], commandes: ["order", "orders"], article: ["item", "items"], articles: ["item", "items"],
  produit: ["product", "products"], produits: ["product", "products"], fiche: ["item", "product"],
  stock: ["stock", "stocks"], magasin: ["endpoint", "endpoints"], magasins: ["endpoint", "endpoints"],
  entrepot: ["endpoint", "endpoints"], point: ["endpoint"], zone: ["zone", "zones"], zones: ["zone", "zones"],
  route: ["route", "routes", "delivery_routes"], routes: ["route", "routes", "delivery_routes"],
  livraison: ["delivery", "shipping"], transporteur: ["carrier", "carriers"], transporteurs: ["carrier", "carriers"],
  colis: ["parcel", "parcels"], client: ["customer", "customers"], clients: ["customer", "customers"],
  retour: ["return", "returns", "rma"], retours: ["return", "returns", "rma"], facture: ["invoice", "document"],
  paiement: ["payment", "payments"], remboursement: ["refund", "refunds"], geste: ["appeasement", "appeasements"],
  creer: ["post", "create"], creation: ["post", "create"], modifier: ["patch", "put", "update"], supprimer: ["delete"],
  lister: ["get", "list"], consulter: ["get"], capacite: ["capacity", "capacities"], reservation: ["reservation", "reservations"],
  promesse: ["promise", "delivery_promise"], canal: ["sales_channel", "sales_channels"], vente: ["sales_channel"],
  regle: ["rule", "ruleset", "rulesets"], regles: ["rule", "ruleset", "rulesets"], utilisateur: ["user", "users"],
  carte: ["gift_card", "gift_cards"], cadeau: ["gift_card", "gift_cards"], taxe: ["tax", "taxes"], historique: ["history"],
};

/** Recherche d'opérations par mots-clés (chemin, catégorie, résumé), méthode et catégorie facultatives. */
export async function findOperations(query: string, opts: { method?: string; tag?: string; limit?: number } = {}) {
  const { operations } = await loadCatalog();
  const terms = words(query).flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]);
  const method = opts.method?.toUpperCase();
  const tag = opts.tag?.toLowerCase();
  const scored = operations
    .filter(isAllowedOperation)
    .filter((op) => (!method || op.m === method) && (!tag || op.tag.toLowerCase().includes(tag)))
    .map((op) => {
      const path = op.p.toLowerCase();
      const hay = `${path} ${op.tag.toLowerCase()} ${op.s.toLowerCase()}`;
      let score = 0;
      for (const t of terms) {
        if (path.split(/[/{}]/).includes(t)) score += 5;
        else if (path.includes(t)) score += 3;
        if (op.tag.toLowerCase().includes(t)) score += 2;
        if (hay.includes(t)) score += 1;
        if (t === op.m.toLowerCase()) score += 2;
      }
      // Routes documentées pour les clients avant les routes internes.
      if (op.s.startsWith("[internal]")) score -= 0.5;
      return { op, score };
    })
    .filter((x) => !terms.length || x.score > 0)
    .sort((a, b) => b.score - a.score || a.op.p.length - b.op.p.length);
  return {
    total: scored.length,
    operations: scored.slice(0, opts.limit ?? 25).map(({ op }) => ({
      method: op.m,
      path: operationPath(op),
      category: op.tag,
      summary: op.s,
      write: !isReadOperation(op),
    })),
  };
}

/** Catégories d'API (pour orienter la recherche). */
export async function listCategories() {
  const { operations } = await loadCatalog();
  const counts = new Map<string, number>();
  for (const op of operations.filter(isAllowedOperation)) counts.set(op.tag, (counts.get(op.tag) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([category, operations]) => ({ category, operations }));
}

/** Découpe « /v3/orders/123 » en version (facultative) et chemin. */
function splitVersion(path: string): { version?: string; rest: string } {
  const clean = path.trim().split("?")[0]!.replace(/\/+$/, "") || "/";
  const m = clean.match(/^\/(v\d)(\/.*)?$/i);
  return m ? { version: m[1]!.toLowerCase(), rest: m[2] || "/" } : { rest: clean.startsWith("/") ? clean : `/${clean}` };
}

const templateRegex = (p: string) => new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}/]+\}/g, "[^/]+")}$`);
const paramCount = (p: string) => (p.match(/\{/g) ?? []).length;

/** Opération correspondant à une méthode et un chemin (concret ou modèle) ; la route la plus spécifique gagne. */
export async function matchOperation(method: string, path: string) {
  const { operations } = await loadCatalog();
  const m = method.toUpperCase();
  const { version, rest } = splitVersion(path);
  const candidates = operations
    .filter((op) => op.m === m && (op.p === rest || templateRegex(op.p).test(rest)))
    .sort((a, b) => Number(b.p === rest) - Number(a.p === rest) || paramCount(a.p) - paramCount(b.p));
  const op = candidates[0];
  return op ? { op, version: version ?? op.v, concretePath: rest } : undefined;
}

/**
 * Schéma résolu (références remplacées) jusqu'à une profondeur donnée, sans les champs d'authentification.
 * Au-delà de la profondeur, une référence est remplacée par son nom.
 */
function resolve(node: unknown, schemas: Record<string, Schema>, depth: number, seen: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => resolve(n, schemas, depth, seen));
  if (!node || typeof node !== "object") return node;
  const obj = node as Schema;
  if (typeof obj.$ref === "string") {
    const name = obj.$ref.split("/").pop()!;
    if (depth <= 0 || seen.includes(name) || !schemas[name]) return { type: "object", see_schema: name };
    return resolve(schemas[name], schemas, depth - 1, [...seen, name]);
  }
  const out: Schema = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolve(v, schemas, depth, seen);
  return out;
}

function withoutAuth(schema: Schema): Schema {
  if (!schema?.properties) return schema;
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => !AUTH_FIELDS.has(k)));
  const required = Array.isArray(schema.required) ? schema.required.filter((k: string) => !AUTH_FIELDS.has(k)) : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

const MAX_DESCRIBE_CHARS = 24_000;

/** Corps attendu d'une opération (schéma racine, sans authentification). */
export async function bodySchema(op: ApiOperation, depth = 0): Promise<Schema | undefined> {
  const { schemas } = await loadCatalog();
  const root = op.schema ? schemas[op.schema] : op.inline;
  return root ? withoutAuth(resolve(root, schemas, depth) as Schema) : undefined;
}

/** Documentation d'une opération pour le modèle : description, paramètres, corps (schéma résolu) et exemple. */
export async function describeOperation(method: string, path: string, schemaName?: string) {
  const { schemas } = await loadCatalog();
  if (schemaName) {
    const s = schemas[schemaName];
    if (!s) return { error: `Unknown schema ${schemaName}` };
    return { schema_name: schemaName, schema: resolve(s, schemas, 2) };
  }
  const found = await matchOperation(method, path);
  if (!found) return { error: `No ${method.toUpperCase()} ${path} operation in the OneStock API catalog. Use find_api_operations.` };
  const { op } = found;
  if (!isAllowedOperation(op)) return { error: "This operation (authentication or access rights) is not available to the assistant." };

  // Profondeur décroissante jusqu'à tenir dans la taille maximale ; les sous-schémas restants se lisent via schema_name.
  let schema: Schema | undefined;
  for (const depth of [4, 3, 2, 1, 0]) {
    schema = await bodySchema(op, depth);
    if (JSON.stringify(schema ?? {}).length <= MAX_DESCRIBE_CHARS) break;
  }
  let text = JSON.stringify(schema ?? {});
  const truncated = text.length > MAX_DESCRIBE_CHARS;
  if (truncated) text = text.slice(0, MAX_DESCRIBE_CHARS);
  return {
    method: op.m,
    path: operationPath(op),
    category: op.tag,
    write: !isReadOperation(op),
    summary: op.s,
    description: op.d,
    path_parameters: op.params?.filter((p) => p.in === "path").map((p) => p.name),
    required_body_fields: schema?.required ?? [],
    body_schema: truncated ? { truncated: true, partial_json: text } : schema,
    example: op.ex,
    note: "site_id et token sont ajoutés automatiquement : ne pas les fournir. Un sous-schéma « see_schema » se lit avec describe_api_operation(schema_name).",
  };
}

/** Chemin concret encodé (segments de paramètres encodés, sans « .. » ni requête). */
export function safeConcretePath(rest: string): string {
  const segments = rest.split("/").slice(1);
  if (segments.some((s) => s === ".." || s === "." || /[?#]/.test(s))) throw new Error("Invalid path");
  return "/" + segments.map((s) => encodeURIComponent(decodeURIComponent(s))).join("/");
}

/**
 * Contrôle d'un appel avant exécution ou confirmation : opération connue et autorisée, paramètres de chemin
 * renseignés, champs obligatoires du corps présents et pas de champ inconnu (au premier niveau).
 * Renvoie un message pour le modèle, ou undefined si l'appel peut être proposé.
 */
export async function checkCall(method: string, path: string, body: unknown): Promise<string | undefined> {
  const found = await matchOperation(method, path);
  if (!found) return `Aucune opération ${method.toUpperCase()} ${path} dans l'API OneStock : utilise find_api_operations pour trouver la bonne route.`;
  if (!isAllowedOperation(found.op)) return "Cette opération (authentification ou droits d'accès) n'est pas disponible pour l'assistant.";
  if (/\{[^}]*\}/.test(found.concretePath)) {
    return `Le chemin contient encore des paramètres à remplacer (${found.concretePath}) : demande les identifiants à l'utilisateur ou recherche-les.`;
  }
  const schema = await bodySchema(found.op, 0);
  if (!schema?.properties) return undefined;
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const missing = (schema.required ?? []).filter((k: string) => b[k] === undefined || b[k] === null || b[k] === "");
  const unknown = schema.additionalProperties === false ? Object.keys(b).filter((k) => !(k in schema.properties) && !AUTH_FIELDS.has(k)) : [];
  if (!missing.length && !unknown.length) return undefined;
  return [
    "Demande non envoyée, rien n'a été exécuté.",
    missing.length ? `Champs obligatoires manquants dans le corps : ${missing.join(", ")}.` : "",
    unknown.length ? `Champs inconnus pour cette route : ${unknown.join(", ")} (champs acceptés : ${Object.keys(schema.properties).join(", ")}).` : "",
    "Consulte describe_api_operation, puis demande à l'utilisateur les informations manquantes (sans les inventer).",
  ].filter(Boolean).join(" ");
}
