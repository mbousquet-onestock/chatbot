import type OpenAI from "openai";
import { missingAddressParts, sameAddress } from "./addresses";
import { toOnestockDate } from "./dates";
import { encodeId, onestockRequest, type OnestockResult } from "./onestock";
import { getOnestockSettings, salesChannelFor } from "./settings";
import { contextQuery } from "./apiContext";
import { checkCall, describeOperation, findOperations, listCategories, matchOperation, safeConcretePath } from "./apiCatalog";

type Input = Record<string, any>;

/** Définition d'un outil : nom, description et schéma JSON des paramètres. */
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Message à afficher à l'utilisateur (alerte dans la conversation), traduit côté front à partir de son code. */
export interface ToolNotice {
  code: "cancel_done" | "cancel_partial" | "cancel_not_possible" | "cancel_nothing" | "cancel_error" | "shipping_address_locked" | "order_created";
  order_id: string;
  /** États des lignes annulées et des lignes dont la transition a été refusée. */
  cancelled_states?: string[];
  refused_states?: string[];
  /** Statut de la commande qui bloque l'action. */
  order_state?: string;
  /** Commande créée : type (reservation, click_and_collect, home_delivery). */
  order_mode?: string;
}

/** Magasins ayant du stock d'un article, affichés sur une carte dans la conversation. */
export interface StoreMap {
  item_id: string;
  item_name?: string;
  quantity: number;
  mode: "reservation" | "click_and_collect";
  stores: {
    id: string;
    name: string;
    lines?: string[];
    zip_code?: string;
    city?: string;
    country_code?: string;
    lat?: number;
    lon?: number;
    stock: number;
  }[];
}

/** Statuts de commande pour lesquels l'adresse de livraison ne peut plus être modifiée. */
const SHIPPING_ADDRESS_LOCKED_STATES = ["fulfilled"];

/** Statut actuel d'une commande (relu chez OneStock). */
async function readOrderState(siteId: string, orderId: string): Promise<OnestockResult & { state?: string }> {
  const res = await onestockRequest(siteId, "GET", `/v3/orders/${encodeId(orderId)}`, { fields: ["id", "state"] });
  if (!res.ok) return res;
  const order = ((res.data as { order?: unknown })?.order ?? res.data) as { state?: unknown } | undefined;
  return { ...res, state: String(order?.state ?? "") };
}

export interface ToolSpec {
  definition: ToolDefinition;
  /**
   * Une action d'écriture n'est exécutée qu'après confirmation explicite de l'utilisateur. Fonction : l'outil
   * générique est une écriture selon la méthode HTTP demandée.
   */
  write: boolean | ((input: Input) => boolean);
  run: (siteId: string, input: Input, ctx: ToolContext) => Promise<OnestockResult & { notice?: ToolNotice; stores?: StoreMap }>;
  /**
   * Contrôle d'une action d'écriture avant la carte de confirmation : renvoie un message pour le modèle si les
   * paramètres ne peuvent pas être proposés tels quels (l'utilisateur ne voit alors pas de carte).
   */
  validate?: (siteId: string, input: Input) => Promise<string | undefined>;
}

/** Contexte de l'appel : utilisateur OneStock à l'origine de la demande (vide s'il n'est pas connu). */
export interface ToolContext {
  userId: string;
  /** Langue de l'utilisateur (ex. fr), pour les caractéristiques des articles. */
  lang?: string;
}

/** Taille maximale d'une réponse d'API générique transmise au modèle. */
const MAX_API_RESPONSE_CHARS = 40_000;

/** Caractéristiques des articles incluses dans la lecture d'une commande. */
const ORDER_ITEM_FEATURES = ["name", "description", "image_url"];

/** Code langue court (fr-FR → fr), ou undefined. */
const shortLang = (lang?: string) => lang?.trim().toLowerCase().split(/[-_]/)[0] || undefined;

/**
 * Langues à essayer pour les caractéristiques des articles, dans l'ordre : langue demandée ou de l'utilisateur,
 * puis `default_lang` de la table settings, puis français.
 */
async function featureLangs(siteId: string, ...preferred: (string | undefined)[]): Promise<string[]> {
  const siteDefault = await getOnestockSettings(siteId).then((s) => s.defaultLang, () => undefined);
  return [...new Set([...preferred, siteDefault, "fr"].map(shortLang).filter((l): l is string => !!l))];
}

/** État cible des lignes d'une commande annulée. */
export const CANCELLED_STATE = "removed";

const DEFAULT_SEARCH_FIELDS = [
  "id", "types", "date", "last_update", "sales_channel", "state", "customer",
  "delivery.type", "pricing_details.price", "pricing_details.currency",
];

const DEFAULT_ORDER_FIELDS = [
  "id", "types", "date", "last_update", "sales_channel", "state", "information", "expiration_dates",
  "customer", "ordering.endpoint_id", "delivery.type", "delivery.destination.address",
  "delivery.destination.endpoint_id", "pricing_details", "shipping_fees",
  "order_items._id", "order_items.item_id", "order_items.quantity", "order_items.pricing_details",
  "order_items.information",
  "line_item_groups.id", "line_item_groups.order_item_id", "line_item_groups.item_id",
  "line_item_groups.endpoint_id", "line_item_groups.quantity", "line_item_groups.parcel_id",
  "line_item_groups.reason", "line_item_groups.state", "line_item_groups.index_ranges",
  "line_item_groups.last_update",
  "parcels.id", "parcels.state", "parcels.line_item_index_ranges", "parcels.delivery.carrier",
  "parcels.delivery.origin", "parcels.delivery.type", "parcels.shipment.tracking_code",
  "parcels.shipment.tracking_link", "parcels.date", "parcels.last_update",
  "sent_delivery_option", "current_delivery_etas",
];

const SEARCHABLE_FIELDS = [
  "customer._id", "customer.email", "customer.external_id", "customer.first_name", "customer.last_name",
  "customer.phone_number", "delivery.carrier.name", "delivery.destination.address.zip_code",
  "delivery.destination.endpoint_id", "delivery.type", "id", "order_items.item_id", "ordering_endpoint_id",
  "parcels._id", "parcels.state", "sales_channels", "state", "types",
];

const SEARCH_FILTERS = [
  "order_id", "state", "types", "sales_channel", "endpoint_id", "ordering_endpoint_id",
  "destination_endpoint_id", "item_id", "customer_external_id", "parcels_state",
  "line_item_groups_state", "delivery_type", "carrier", "destination_country_code",
];

const stringArray = { type: "array", items: { type: "string" } } as const;

/** Champs des points de stock renvoyés par défaut (sans les horaires, volumineux). */
const ENDPOINT_FIELDS = ["id", "name", "timezone", "address", "classification", "tags", "open", "modules"];

/** Caractéristiques d'article demandées par défaut (les noms dépendent de la configuration du catalogue). */
const DEFAULT_ITEM_FEATURES = ["name", "description", "image_url", "color", "size", "brand", "price"];

const featureNames = (input: Input): string[] =>
  (Array.isArray(input.features) && input.features.length ? input.features : DEFAULT_ITEM_FEATURES)
    .map(String)
    .filter((f: string) => /^[\w.-]+$/.test(f));
const indexRanges = {
  type: "array",
  description: "Plages d'index de line item groups, ex. [{\"from\":0,\"to\":1}] (bornes incluses).",
  items: {
    type: "object",
    properties: { from: { type: "integer" }, to: { type: "integer" } },
    required: ["from", "to"],
  },
} as const;

/** Lien vers la route /api/invoices qui trace la consultation puis ouvre la facture de la commande. */
export function invoiceLink(orderId: string, siteId: string, userId: string): string {
  const user = userId ? `&user_id=${encodeURIComponent(userId)}` : "";
  return `/api/invoices/${encodeURIComponent(orderId)}?site_id=${encodeURIComponent(siteId)}${user}${contextQuery()}`;
}

/** Remplace l'URL de facture (information.invoice) par un lien qui trace sa consultation (`invoice_link`). */
function withInvoiceLink(data: unknown, orderId: string, siteId: string, userId: string): unknown {
  const order = ((data as { order?: unknown })?.order ?? data) as { information?: Record<string, unknown> } | undefined;
  const invoice = order?.information?.invoice;
  if (typeof invoice === "string" && invoice) {
    order!.information = { ...order!.information, invoice: "(voir invoice_link)" };
    (order as Record<string, unknown>).invoice_link = invoiceLink(orderId, siteId, userId);
  }
  return data;
}

/** Lien vers la route /api/documents qui affiche un document OneStock. */
export function documentLink(documentId: string, siteId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}?site_id=${encodeURIComponent(siteId)}${contextQuery()}`;
}

/** Ajoute `document_links` ({type: lien}) à chaque colis qui a des `documents` ({type: id}). */
function withDocumentLinks(data: unknown, siteId: string): unknown {
  const order = (data as { order?: unknown })?.order ?? data;
  const parcels = (order as { parcels?: unknown })?.parcels;
  if (!Array.isArray(parcels)) return data;
  for (const parcel of parcels) {
    const documents = parcel?.documents;
    if (!documents || typeof documents !== "object") continue;
    parcel.document_links = Object.fromEntries(
      Object.entries(documents as Record<string, unknown>)
        .filter(([, id]) => typeof id === "string" && id)
        .map(([type, id]) => [type, documentLink(id as string, siteId)]),
    );
  }
  return data;
}

const contactSchema = {
  type: "object",
  properties: {
    title: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" },
    email: { type: "string" }, phone_number: { type: "string" },
  },
} as const;

const addressSchema = {
  type: "object",
  properties: {
    lines: stringArray,
    zip_code: { type: "string" },
    city: { type: "string" },
    country_code: { type: "string", description: "Code pays ISO 3166-1 alpha-2." },
    contact: { ...contactSchema, description: "Personne à cette adresse." },
  },
  required: ["lines", "zip_code", "city", "country_code"],
} as const;

/** Adresse saisie (lines, zip_code, city, country_code, contact) → format d'adresse OneStock. */
function toOnestockAddress(a: Input | undefined): Record<string, unknown> | undefined {
  if (!a || typeof a !== "object") return undefined;
  return compact({
    lines: a.lines,
    zip_code: a.zip_code,
    city: a.city,
    regions: a.country_code ? { country: { code: String(a.country_code).toUpperCase() } } : undefined,
    contact: a.contact,
  });
}

/** Pays de livraison : celui de l'adresse (livraison à domicile) ou du magasin de retrait (lu chez OneStock). */
async function deliveryCountry(siteId: string, mode: string, input: Input): Promise<string | undefined> {
  if (mode === "home_delivery") return input.delivery_address?.country_code ? String(input.delivery_address.country_code).toUpperCase() : undefined;
  if (!input.endpoint_id) return undefined;
  const res = await onestockRequest(siteId, "GET", `/v3/endpoints/${encodeId(String(input.endpoint_id))}`, { fields: ["id", "address"] });
  const e = ((res.data as Input)?.endpoint ?? res.data) as Input | undefined;
  const code = res.ok ? e?.address?.regions?.country?.code : undefined;
  return code ? String(code).toUpperCase() : undefined;
}

/** Mode de création de commande (réservation en magasin par défaut). */
function orderMode(input: Input): "reservation" | "click_and_collect" | "home_delivery" {
  return input.mode === "click_and_collect" || input.mode === "home_delivery" ? input.mode : "reservation";
}

function requireString(input: Input, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`"${key}" is required`);
  return v.trim();
}

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)),
  ) as Partial<T>;
}

export const TOOLS: Record<string, ToolSpec> = {
  search_orders: {
    write: false,
    definition: {
      name: "search_orders",
      description:
        "Recherche des commandes client OneStock (route GET /v2/search_orders). Utiliser `pattern` + `searchable_fields` " +
        "pour une recherche partielle insensible à la casse (email, nom, téléphone, référence…), et/ou `filters` pour des " +
        "valeurs exactes (états, canal de vente, magasin…). Les dates filtrent sur la date de commande du canal de vente. " +
        "Renvoie au plus `limit` commandes (max 50) et le total ; utiliser `start` (dernier id reçu) pour la page suivante.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Texte recherché (partiel, insensible à la casse)." },
          searchable_fields: {
            type: "array",
            items: { type: "string", enum: SEARCHABLE_FIELDS },
            description: "Champs où chercher `pattern`, par ordre de priorité. Par défaut : id, email, nom, téléphone.",
          },
          filters: {
            type: "object",
            description: "Filtres exacts ; chaque valeur est une liste.",
            properties: Object.fromEntries(SEARCH_FILTERS.map((f) => [f, stringArray])),
          },
          from_date: { type: "string", description: "Date de début (YYYY-MM-DD ou ISO 8601)." },
          to_date: { type: "string", description: "Date de fin incluse (YYYY-MM-DD ou ISO 8601)." },
          sort_by: { type: "string", enum: ["sales_channel_date", "state", "id"], description: "Tri (défaut : date décroissante)." },
          sort_order: { type: "string", enum: ["asc", "desc"] },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Défaut 20." },
          start: { type: "string", description: "Id de la dernière commande de la page précédente." },
          fields: { ...stringArray, description: "Champs à renvoyer (avancé) ; un champ parent exclut ses sous-champs." },
        },
      },
    },
    run(siteId, input) {
      const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
      const searchable: string[] = input.searchable_fields?.length
        ? input.searchable_fields
        : ["id", "customer.email", "customer.last_name", "customer.first_name", "customer.phone_number", "customer.external_id"];
      const filter = compact(
        Object.fromEntries(
          SEARCH_FILTERS.map((f) => [f, Array.isArray(input.filters?.[f]) ? input.filters[f].map(String) : undefined]),
        ),
      );
      return onestockRequest(siteId, "GET", "/v2/search_orders", compact({
        fields: input.fields?.length ? input.fields : DEFAULT_SEARCH_FIELDS,
        pattern: pattern || undefined,
        searchable_fields: pattern ? searchable.map((name, i) => ({ name, priority: i + 1 })) : undefined,
        filter: Object.keys(filter).length ? filter : undefined,
        from_date: toOnestockDate(input.from_date),
        to_date: toOnestockDate(input.to_date, true),
        sort: [{ key: input.sort_by ?? "sales_channel_date", sort_order: input.sort_order === "asc" ? 1 : -1 }],
        pagination: compact({ limit: Math.min(Math.max(Number(input.limit) || 20, 1), 50), start: input.start }),
        get_total: true,
      }));
    },
  },

  get_order: {
    write: false,
    definition: {
      name: "get_order",
      description:
        "Détail complet d'une commande (GET /v3/orders/{id}) : état, client, livraison, prix, articles (order_items, " +
        "avec nom, description et image dans order_items.item.features), line item groups (état de préparation par " +
        "article, avec leurs index), colis et suivi transporteur.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          fields: { ...stringArray, description: "Champs à renvoyer (avancé). Par défaut : vue complète." },
        },
        required: ["order_id"],
      },
    },
    async run(siteId, input, ctx) {
      const orderId = requireString(input, "order_id");
      const path = `/v3/orders/${encodeId(orderId)}`;
      const fields = input.fields?.length ? input.fields : DEFAULT_ORDER_FIELDS;
      if (input.fields?.length) {
        const res = await onestockRequest(siteId, "GET", path, { fields });
        return res.ok ? { ...res, data: withInvoiceLink(res.data, orderId, siteId, ctx.userId) } : res;
      }
      // Vue par défaut : avec les fiches articles (nom, description, image), dans la langue de l'utilisateur, puis
      // celle du site (default_lang) si OneStock la refuse, et enfin sans les fiches.
      const withFeatures = [...fields, ...ORDER_ITEM_FEATURES.map((f) => `order_items.item.features.${f}`)];
      let res: OnestockResult | undefined;
      for (const lang of await featureLangs(siteId, ctx.lang)) {
        res = await onestockRequest(siteId, "GET", path, { fields: withFeatures, item_features_lang: lang });
        if (res.ok || res.status >= 500) break;
      }
      if (!res || (!res.ok && res.status < 500)) res = await onestockRequest(siteId, "GET", path, { fields });
      return res.ok ? { ...res, data: withInvoiceLink(res.data, orderId, siteId, ctx.userId) } : res;
    },
  },

  get_orders: {
    write: false,
    definition: {
      name: "get_orders",
      description: "Lecture de plusieurs commandes par identifiants exacts (GET /v3/orders, 50 max).",
      input_schema: {
        type: "object",
        properties: {
          order_ids: { ...stringArray, maxItems: 50 },
          fields: { ...stringArray, description: "Champs à renvoyer (avancé)." },
        },
        required: ["order_ids"],
      },
    },
    run(siteId, input) {
      const ids: string[] = (input.order_ids ?? []).map(String).slice(0, 50);
      if (!ids.length) throw new Error('"order_ids" is required');
      return onestockRequest(siteId, "GET", "/v3/orders", {
        filter: { ids },
        fields: input.fields?.length ? input.fields : DEFAULT_SEARCH_FIELDS,
        pagination: { limit: ids.length },
      });
    },
  },

  get_order_comments: {
    write: false,
    definition: {
      name: "get_order_comments",
      description: "Commentaires d'une commande (GET /v2/orders/{id}/comments).",
      input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    },
    run: (siteId, input) =>
      onestockRequest(siteId, "GET", `/v2/orders/${encodeId(requireString(input, "order_id"))}/comments`),
  },

  get_order_history: {
    write: false,
    definition: {
      name: "get_order_history",
      description:
        "Historique (logs) d'une commande (GET /v1/history) : changements d'état, actions utilisateurs, erreurs. " +
        "Utile pour expliquer pourquoi/quand une commande a changé d'état.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Défaut 50." },
          page_id: { type: "string", description: "Id de page précédente pour paginer." },
        },
        required: ["order_id"],
      },
    },
    run: (siteId, input) =>
      onestockRequest(siteId, "GET", "/v1/history", {
        order_id: requireString(input, "order_id"),
        pagination: compact({ limit: Math.min(Number(input.limit) || 50, 100), id: input.page_id }),
      }),
  },

  get_parcel: {
    write: false,
    definition: {
      name: "get_parcel",
      description:
        "Détail d'un colis par son id (GET /v2/parcels/{id}) : état, commande, articles (index), adresse, origine, " +
        "transporteur et suivi. Pour les documents (étiquette…) et la date, utiliser get_order_parcels.",
      input_schema: { type: "object", properties: { parcel_id: { type: "string" } }, required: ["parcel_id"] },
    },
    run: (siteId, input) =>
      onestockRequest(siteId, "GET", `/v2/parcels/${encodeId(requireString(input, "parcel_id"))}`, {
        fields: [
          "id", "order_id", "state", "line_item_index_ranges", "information", "delivery.destination.address",
          "delivery.destination.endpoint_id", "delivery.origin", "delivery.carrier", "shipment.tracking_code",
          "shipment.tracking_link",
        ],
      }),
  },

  get_order_parcels: {
    write: false,
    definition: {
      name: "get_order_parcels",
      description:
        "Colis d'une commande et leur avancement (GET /v3/orders/{id}, champs parcels.*) : état, dates de création " +
        "et de mise à jour, articles (index), origine, destination, transporteur, numéro et lien de suivi, et " +
        "documents liés (étiquette d'expédition, bon de retour…), ainsi que information de la commande (facture dans " +
        "information.invoice). Chaque document est fourni avec un lien " +
        "`document_links` à afficher tel quel en Markdown pour l'ouvrir.",
      input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    },
    async run(siteId, input, ctx) {
      const res = await onestockRequest(siteId, "GET", `/v3/orders/${encodeId(requireString(input, "order_id"))}`, {
        fields: [
          "id", "state", "information", "parcels.id", "parcels.state", "parcels.line_item_index_ranges", "parcels.information",
          "parcels.delivery.destination.address", "parcels.delivery.destination.endpoint_id", "parcels.delivery.origin",
          "parcels.delivery.carrier", "parcels.delivery.type", "parcels.shipment.tracking_code",
          "parcels.shipment.tracking_link", "parcels.date", "parcels.last_update", "parcels.documents",
        ],
      });
      return res.ok
        ? { ...res, data: withInvoiceLink(withDocumentLinks(res.data, siteId), requireString(input, "order_id"), siteId, ctx.userId) }
        : res;
    },
  },

  get_order_items_details: {
    write: false,
    definition: {
      name: "get_order_items_details",
      description:
        "Données catalogue des articles d'une commande (GET /v3/orders/{id}, champs order_items.item.features.*) : " +
        "nom, description, URL de l'image, couleur, taille… pour chaque article commandé. Utiliser quand " +
        "l'utilisateur veut décrire ou voir un article. Les noms de caractéristiques dépendent du catalogue du site : " +
        "si une valeur manque, chercher l'article avec search_items sans `features` pour découvrir les noms disponibles.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          lang: {
            type: "string",
            description: "Langue des caractéristiques (ex. fr, en). Défaut : langue de l'utilisateur, puis default_lang du site.",
          },
          features: { ...stringArray, description: `Caractéristiques à lire. Défaut : ${DEFAULT_ITEM_FEATURES.join(", ")}.` },
        },
        required: ["order_id"],
      },
    },
    async run(siteId, input, ctx) {
      const path = `/v3/orders/${encodeId(requireString(input, "order_id"))}`;
      const fields = [
        "id",
        "order_items._id",
        "order_items.item_id",
        "order_items.quantity",
        ...featureNames(input).map((f) => `order_items.item.features.${f}`),
      ];
      let res: OnestockResult | undefined;
      for (const lang of await featureLangs(siteId, input.lang, ctx.lang)) {
        res = await onestockRequest(siteId, "GET", path, { fields, item_features_lang: lang });
        if (res.ok || res.status >= 500) break;
      }
      return res!;
    },
  },

  get_item: {
    write: false,
    definition: {
      name: "get_item",
      description:
        "Détail d'un ou plusieurs articles par identifiant exact (GET /v3/items, filtre ids) : toutes les " +
        "caractéristiques (nom, description, image, prix, couleur, taille…) dans toutes les langues, produit et " +
        "catégories. Pour trouver un article à partir d'un nom ou d'une référence partielle, utiliser search_items.",
      input_schema: {
        type: "object",
        properties: { item_ids: { ...stringArray, maxItems: 20, description: "Identifiants d'articles (SKU)." } },
        required: ["item_ids"],
      },
    },
    run(siteId, input) {
      const ids: string[] = (Array.isArray(input.item_ids) ? input.item_ids : [input.item_ids]).filter(Boolean).map(String).slice(0, 20);
      if (!ids.length) throw new Error('"item_ids" is required');
      return onestockRequest(siteId, "GET", "/v3/items", {
        filters: { ids },
        fields: ["product_id", "category_ids", "is_default"],
        pagination: { limit: ids.length, start: 0 },
        get_total: true,
      });
    },
  },

  get_item_stock: {
    write: false,
    definition: {
      name: "get_item_stock",
      description:
        "Stock en temps réel d'articles (GET /v1/stock_export) : quantité par point de stock et par type de stock " +
        "(on_hand = en stock, in_transit = en transit avec date d'arrivée), selon la vue de stock configurée pour le " +
        "site (clé onestock_stock_request_name de la table settings, « detailed » par défaut). Limiter aux points de stock utiles (endpoint_ids) quand c'est possible ; total_by_item = true " +
        "donne directement le total tous points de stock confondus.",
      input_schema: {
        type: "object",
        properties: {
          item_ids: { ...stringArray, maxItems: 50, description: "Identifiants d'articles (SKU)." },
          endpoint_ids: { ...stringArray, description: "Points de stock à interroger (par défaut : ceux de la requête de stock)." },
          total_by_item: { type: "boolean", description: "Additionner le stock de tous les points de stock." },
        },
        required: ["item_ids"],
      },
    },
    async run(siteId, input) {
      // Vue de stock lue dans la table settings (onestock_stock_request_name), « detailed » par défaut.
      const requestName = (await getOnestockSettings(siteId)).stockRequestName;
      const items: string[] = (Array.isArray(input.item_ids) ? input.item_ids : [input.item_ids]).filter(Boolean).map(String).slice(0, 50);
      if (!items.length) throw new Error('"item_ids" is required');
      const endpoints: string[] = Array.isArray(input.endpoint_ids) ? input.endpoint_ids.filter(Boolean).map(String) : [];
      return onestockRequest(siteId, "GET", "/v1/stock_export", compact({
        request_name: requestName,
        aggregates: {
          "*": compact({ item_filter: { ids: items }, endpoint_filter: endpoints.length ? { ids: endpoints } : undefined }),
        },
        unification: input.total_by_item ? { by_endpoint: true, by_stock_type: true } : undefined,
      }));
    },
  },

  search_items: {
    write: false,
    definition: {
      name: "search_items",
      description:
        "Recherche dans le catalogue d'articles OneStock (GET /v3/items) : par texte partiel (`pattern`, sur les " +
        "caractéristiques indexées comme le nom), par product_ids ou par filtres de caractéristiques. Renvoie les " +
        "articles (id, product_id, catégories) et leurs caractéristiques : description, URL de l'image, prix, " +
        "couleur… Sans `lang` ni `features`, toutes les caractéristiques dans toutes les langues sont renvoyées " +
        "(utile pour découvrir les noms disponibles).",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Texte recherché (partiel, insensible à la casse)." },
          searchable_fields: {
            ...stringArray,
            description: "Caractéristiques où chercher `pattern`, par priorité. Défaut : name.",
          },
          product_ids: stringArray,
          feature_filters: {
            type: "object",
            description: "Filtres exacts par caractéristique, ex. {\"color\": [\"red\", \"blue\"]} (OU entre valeurs, ET entre caractéristiques).",
          },
          lang: { type: "string", description: "Langue des caractéristiques (ex. fr, en)." },
          features: { ...stringArray, description: "Caractéristiques à renvoyer (avec `lang`). Défaut : toutes." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Défaut 10." },
          start: { type: "integer", minimum: 0, description: "Index de départ (pagination)." },
        },
      },
    },
    async run(siteId, input) {
      const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
      const searchable: string[] = input.searchable_fields?.length ? input.searchable_fields.map(String) : ["name"];
      const askedFeatures = Array.isArray(input.features) && input.features.length > 0;
      // Caractéristiques demandées sans langue : langue par défaut du site (default_lang), sinon français.
      const lang = typeof input.lang === "string" && input.lang.trim()
        ? input.lang.trim()
        : askedFeatures ? (await featureLangs(siteId))[0] : undefined;
      const filters = input.feature_filters && typeof input.feature_filters === "object"
        ? Object.entries(input.feature_filters as Record<string, unknown>).map(([name, values]) => [
            name,
            (Array.isArray(values) ? values : [values]).map((v) => [String(v)]),
          ])
        : [];
      const itemFilters = compact({
        product_ids: input.product_ids?.length ? input.product_ids.map(String) : undefined,
        features: filters.length ? [Object.fromEntries(filters)] : undefined,
        lang: filters.length ? lang : undefined,
      });
      return onestockRequest(siteId, "GET", "/v3/items", compact({
        pattern: pattern || undefined,
        searchable_fields: pattern ? searchable.map((name, i) => ({ name, priority: i + 1 })) : undefined,
        filters: Object.keys(itemFilters).length ? itemFilters : undefined,
        lang,
        features: lang && Array.isArray(input.features) && input.features.length ? featureNames(input) : undefined,
        fields: ["product_id", "category_ids", "is_default"],
        pagination: { limit: Math.min(Math.max(Number(input.limit) || 10, 1), 50), start: Math.max(Number(input.start) || 0, 0) },
        get_total: true,
      }));
    },
  },

  get_endpoint: {
    write: false,
    definition: {
      name: "get_endpoint",
      description:
        "Détail d'un point de stock (magasin, entrepôt…) par son id (GET /v3/endpoints/{id}) : nom, adresse, contact, " +
        "classification, modules (ckc, ffs, ropis…), ouvert ou non, horaires des 7 prochains jours. Utile pour les " +
        "endpoint_id d'une commande (line_item_groups, origine ou destination des colis).",
      input_schema: {
        type: "object",
        properties: { endpoint_id: { type: "string" } },
        required: ["endpoint_id"],
      },
    },
    run: (siteId, input) =>
      onestockRequest(siteId, "GET", `/v3/endpoints/${encodeId(requireString(input, "endpoint_id"))}`, {
        fields: [...ENDPOINT_FIELDS, "opening_hours_next_seven_days"],
      }),
  },

  search_endpoints: {
    write: false,
    definition: {
      name: "search_endpoints",
      description:
        "Recherche de points de stock (GET /v3/endpoints) : par ids, ville, code postal, pays, type, classification, " +
        "modules, ouverture actuelle, ou proximité (autour d'un point de stock ou de coordonnées GPS).",
      input_schema: {
        type: "object",
        properties: {
          endpoint_ids: stringArray,
          city: { type: "string", description: "Ville (sensible à la casse)." },
          zip_code: { type: "string" },
          country_code: { type: "string", description: "Code pays ISO 3166-1 alpha-2." },
          type: { type: "string", description: "Type de point de stock (classification endpoint_type), ex. store, warehouse." },
          classification: {
            type: "array",
            items: { type: "object" },
            description: "Filtre de classification OneStock, ex. [{\"endpoint_type\": [[\"store\"]], \"region\": [[\"north\"]]}].",
          },
          modules: { type: "object", description: "Modules requis, ex. {\"ckc\": true}." },
          open: { type: "boolean", description: "Seulement les points de stock ouverts (true) ou fermés (false) maintenant." },
          near_endpoint_id: { type: "string", description: "Chercher autour de ce point de stock." },
          near_lat: { type: "number" },
          near_lon: { type: "number" },
          distance_m: { type: "number", description: "Distance maximale en mètres (avec near_*)." },
          include_opening_hours: { type: "boolean", description: "Ajouter les horaires des 7 prochains jours." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Défaut 20." },
          start: { type: "integer", minimum: 0 },
        },
      },
    },
    run(siteId, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
      const hasCoordinates = typeof input.near_lat === "number" && typeof input.near_lon === "number";
      const near = input.near_endpoint_id || hasCoordinates
        ? compact({
            endpoint_id: input.near_endpoint_id,
            centre_coordinates: hasCoordinates ? { lat: input.near_lat, lon: input.near_lon } : undefined,
            distance: typeof input.distance_m === "number" ? input.distance_m : undefined,
            limit,
          })
        : undefined;
      const address = compact({
        city: input.city,
        zip_code: input.zip_code,
        regions: input.country_code ? { country: { code: String(input.country_code).toUpperCase() } } : undefined,
      });
      return onestockRequest(siteId, "GET", "/v3/endpoints", compact({
        endpoint_ids: input.endpoint_ids?.length ? input.endpoint_ids.map(String) : undefined,
        address: Object.keys(address).length ? address : undefined,
        type: input.type,
        classification: Array.isArray(input.classification) ? input.classification : undefined,
        modules: input.modules && typeof input.modules === "object" ? input.modules : undefined,
        open: typeof input.open === "boolean" ? input.open : undefined,
        near,
        fields: input.include_opening_hours ? [...ENDPOINT_FIELDS, "opening_hours_next_seven_days"] : ENDPOINT_FIELDS,
        pagination: { limit, start: Math.max(Number(input.start) || 0, 0) },
      }));
    },
  },

  get_line_item_groups: {
    write: false,
    definition: {
      name: "get_line_item_groups",
      description: "Line item groups d'une commande (GET /v2/line_item_groups) : état, magasin, quantité et index par article.",
      input_schema: {
        type: "object",
        properties: { order_id: { type: "string" }, item_ids: stringArray },
        required: ["order_id"],
      },
    },
    run: (siteId, input) =>
      onestockRequest(siteId, "GET", "/v2/line_item_groups", {
        filter: compact({ order_id: requireString(input, "order_id"), item_ids: input.item_ids }),
        fields: ["id", "date", "order_id", "order_item_id", "item_id", "quantity", "parcel_id", "endpoint_id", "reason", "last_update", "state", "index_ranges"],
      }),
  },

  update_order_state: {
    write: true,
    definition: {
      name: "update_order_state",
      description:
        "ÉCRITURE — Fait passer une commande d'un état à un autre (PATCH /v3/orders/{id}, order.from → order.to). " +
        "Ne pas l'utiliser pour annuler une commande : utiliser cancel_order. `from` doit être l'état actuel (lire la commande avant) et la transition doit " +
        "exister dans le workflow du site. L'utilisateur devra confirmer avant exécution.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          from: { type: "string", description: "État actuel de la commande." },
          to: { type: "string", description: "État cible." },
        },
        required: ["order_id", "from", "to"],
      },
    },
    run: (siteId, input) =>
      onestockRequest(siteId, "PATCH", `/v3/orders/${encodeId(requireString(input, "order_id"))}`, {
        order: { from: requireString(input, "from"), to: requireString(input, "to") },
      }),
  },

  check_shipping_address_change: {
    write: false,
    definition: {
      name: "check_shipping_address_change",
      description:
        "Vérifie si l'adresse de livraison d'une commande peut encore être modifiée (impossible si le statut de la " +
        "commande est « fulfilled »). À appeler EN PREMIER dès que l'utilisateur demande à changer l'adresse de " +
        "livraison, avant de lui demander la nouvelle adresse.",
      input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    },
    async run(siteId, input) {
      const orderId = requireString(input, "order_id");
      const current = await readOrderState(siteId, orderId);
      if (!current.ok) return current;
      const state = current.state ?? "";
      const allowed = !SHIPPING_ADDRESS_LOCKED_STATES.includes(state);
      return {
        ok: true,
        status: 200,
        data: { order_id: orderId, order_state: state, shipping_address_change_allowed: allowed },
        notice: allowed ? undefined : { code: "shipping_address_locked", order_id: orderId, order_state: state },
      };
    },
  },

  update_order: {
    write: true,
    definition: {
      name: "update_order",
      description:
        "ÉCRITURE — Met à jour des données d'une commande (PATCH /v3/orders/{id}) : coordonnées client, adresse de " +
        "livraison (shipping_address → delivery.destination.address, où le colis est envoyé), adresse de " +
        "facturation (billing_address → pricing_details.address, celle de la facture), informations libres, " +
        "signature au retrait. N'envoyer que ce qui doit changer : ne jamais recopier une adresse sur l'autre sans " +
        "demande explicite. L'utilisateur devra confirmer avant exécution.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          customer: { ...contactSchema, description: "Coordonnées du client de la commande." },
          shipping_address: {
            ...addressSchema,
            description: "Adresse de LIVRAISON complète (delivery.destination.address), remplace l'existante.",
          },
          billing_address: {
            ...addressSchema,
            description: "Adresse de FACTURATION complète (pricing_details.address), remplace l'existante.",
          },
          information: { type: "object", description: "Champs libres de order.information à fusionner." },
          sign_on_collect: { type: "boolean" },
        },
        required: ["order_id"],
      },
    },
    async validate(siteId, input) {
      const addresses = [
        { key: "shipping_address", label: "de livraison", value: input.shipping_address ?? input.delivery_address, current: "delivery" },
        { key: "billing_address", label: "de facturation", value: input.billing_address, current: "billing" },
      ].filter((a) => a.value !== undefined && a.value !== null);
      if (!addresses.length) return undefined;

      // 0. Adresse de livraison : seulement si la commande n'est pas « fulfilled ».
      if (addresses.some((a) => a.current === "delivery")) {
        const current = await readOrderState(siteId, requireString(input, "order_id"));
        if (current.ok && SHIPPING_ADDRESS_LOCKED_STATES.includes(current.state ?? "")) {
          return `La commande est au statut « ${current.state} » : son adresse de livraison ne peut plus être modifiée. ` +
            "Rien n'a été proposé à l'utilisateur : explique-le-lui, sans demander d'adresse.";
        }
      }

      // 1. Adresse complète : rue, code postal, ville et pays, tous fournis par l'utilisateur.
      for (const a of addresses) {
        const missing = missingAddressParts(a.value);
        if (missing.length) {
          return `Adresse ${a.label} incomplète (manque : ${missing.join(", ")}). Rien n'a été proposé à l'utilisateur : ` +
            `demande-lui l'adresse ${a.label} complète, sans compléter ni deviner les éléments manquants.`;
        }
      }
      // 2. Adresse différente de l'actuelle : sinon, aucune nouvelle adresse n'a été donnée.
      const current = await onestockRequest(siteId, "GET", `/v3/orders/${encodeId(requireString(input, "order_id"))}`, {
        fields: ["id", "delivery.destination.address", "pricing_details.address"],
      });
      if (current.ok) {
        const order = ((current.data as { order?: unknown })?.order ?? current.data) as Input;
        for (const a of addresses) {
          const existing = a.current === "delivery" ? order?.delivery?.destination?.address : order?.pricing_details?.address;
          if (existing && sameAddress(existing, a.value)) {
            return `L'adresse ${a.label} proposée est identique à l'adresse actuelle de la commande. Rien n'a été ` +
              `proposé à l'utilisateur : demande-lui la nouvelle adresse ${a.label}.`;
          }
        }
      }
      return undefined;
    },
    async run(siteId, input) {
      // `delivery_address` : ancien nom du paramètre, accepté pour l'adresse de livraison.
      const shipping = toOnestockAddress(input.shipping_address ?? input.delivery_address);
      const billing = toOnestockAddress(input.billing_address);
      const order = compact({
        customer: input.customer && Object.keys(input.customer).length ? input.customer : undefined,
        information: input.information && Object.keys(input.information).length ? input.information : undefined,
        sign_on_collect: typeof input.sign_on_collect === "boolean" ? input.sign_on_collect : undefined,
        delivery: shipping ? { destination: { address: shipping } } : undefined,
        pricing_details: billing ? { address: billing } : undefined,
      });
      if (!Object.keys(order).length) throw new Error("Nothing to update");
      const orderId = requireString(input, "order_id");

      // L'adresse de livraison n'est modifiable que si la commande n'est pas « fulfilled » : statut relu juste
      // avant l'écriture, et rien n'est envoyé si la règle n'est pas respectée.
      if (shipping) {
        const current = await readOrderState(siteId, orderId);
        if (!current.ok) return current;
        const state = current.state ?? "";
        if (SHIPPING_ADDRESS_LOCKED_STATES.includes(state)) {
          return {
            ok: true,
            status: 200,
            data: { order_id: orderId, outcome: "shipping_address_locked", order_state: state, updated: false },
            notice: { code: "shipping_address_locked", order_id: orderId, order_state: state },
          };
        }
      }
      return onestockRequest(siteId, "PATCH", `/v3/orders/${encodeId(orderId)}`, { order });
    },
  },

  cancel_order: {
    write: true,
    definition: {
      name: "cancel_order",
      description:
        `ÉCRITURE — Annule une commande en passant toutes ses lignes (line item groups) à l'état « ${CANCELLED_STATE} » ` +
        "(PATCH /v2/line_item_groups, une transition par état actuel). Les lignes déjà annulées sont ignorées. " +
        "Si OneStock refuse la transition, rien n'est modifié pour ces lignes et le résultat l'indique " +
        "(outcome = not_possible ou partial). L'utilisateur devra confirmer avant exécution.",
      input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    },
    async run(siteId, input) {
      const orderId = requireString(input, "order_id");
      const read = await onestockRequest(siteId, "GET", "/v2/line_item_groups", {
        filter: { order_id: orderId },
        fields: ["id", "item_id", "quantity", "state", "index_ranges"],
      });
      if (!read.ok) return read;

      const data = read.data as { line_item_groups?: unknown } | unknown[];
      const groups = (Array.isArray(data) ? data : Array.isArray(data?.line_item_groups) ? data.line_item_groups : []) as {
        state?: string;
        index_ranges?: { from: number; to: number }[];
      }[];
      const byState = new Map<string, { from: number; to: number }[]>();
      for (const g of groups) {
        if (!g.state || g.state === CANCELLED_STATE || !g.index_ranges?.length) continue;
        byState.set(g.state, [...(byState.get(g.state) ?? []), ...g.index_ranges]);
      }
      if (!byState.size) {
        return { ok: true, status: 200, data: { order_id: orderId, outcome: "nothing_to_cancel" }, notice: { code: "cancel_nothing", order_id: orderId } };
      }

      const cancelled: string[] = [];
      const refused: { state: string; status: number; response: unknown }[] = [];
      const failed: { state: string; status: number; response: unknown }[] = [];
      for (const [state, ranges] of byState) {
        const res = await onestockRequest(siteId, "PATCH", "/v2/line_item_groups", {
          order_id: orderId,
          index_ranges: ranges,
          from: state,
          to: CANCELLED_STATE,
        });
        if (res.ok) cancelled.push(state);
        // 4xx : transition refusée par le workflow ; 5xx ou réseau : erreur technique.
        else (res.status < 500 ? refused : failed).push({ state, status: res.status, response: res.data });
      }

      const outcome = failed.length && !cancelled.length && !refused.length
        ? "error"
        : !cancelled.length ? "not_possible" : refused.length || failed.length ? "partial" : "cancelled";
      const code = ({ cancelled: "cancel_done", partial: "cancel_partial", not_possible: "cancel_not_possible", error: "cancel_error" } as const)[outcome];
      return {
        ok: true,
        status: 200,
        data: { order_id: orderId, outcome, cancelled_states: cancelled, refused, failed },
        notice: {
          code,
          order_id: orderId,
          cancelled_states: cancelled,
          refused_states: [...refused, ...failed].map((r) => r.state),
        },
      };
    },
  },

  update_line_item_groups_state: {
    write: true,
    definition: {
      name: "update_line_item_groups_state",
      description:
        "ÉCRITURE — Change l'état de line item groups d'une commande (PATCH /v2/line_item_groups), par exemple pour " +
        "annuler un article. Lire d'abord les line item groups pour connaître leurs index et état actuel. " +
        "L'utilisateur devra confirmer avant exécution.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          index_ranges: indexRanges,
          from: { type: "string", description: "État actuel des line item groups concernés." },
          to: { type: "string", description: "État cible." },
          endpoint_id: { type: "string", description: "Point de stock où a lieu la transition (optionnel)." },
        },
        required: ["order_id", "index_ranges", "to"],
      },
    },
    run(siteId, input) {
      if (!Array.isArray(input.index_ranges) || !input.index_ranges.length) throw new Error('"index_ranges" is required');
      return onestockRequest(siteId, "PATCH", "/v2/line_item_groups", compact({
        order_id: requireString(input, "order_id"),
        index_ranges: input.index_ranges,
        from: input.from,
        to: requireString(input, "to"),
        endpoint_id: input.endpoint_id,
      }));
    },
  },

  find_stores_with_stock: {
    write: false,
    definition: {
      name: "find_stores_with_stock",
      description:
        "Magasins où un article peut être réservé ou retiré : stock disponible en magasin (on_hand) d'au moins la " +
        "quantité demandée, magasin ouvert et proposant le service (module ropis pour la réservation, ckc pour le " +
        "retrait). Affiche à l'utilisateur une carte du pays avec ces magasins, qu'il peut choisir. À utiliser pour " +
        "toute réservation ou retrait en magasin, avant create_order.",
      input_schema: {
        type: "object",
        properties: {
          item_id: { type: "string" },
          item_name: { type: "string", description: "Nom de l'article (affiché sur la carte)." },
          quantity: { type: "integer", minimum: 1, description: "Quantité souhaitée. Défaut 1." },
          mode: { type: "string", enum: ["reservation", "click_and_collect"], description: "Défaut : reservation." },
          country_code: { type: "string", description: "Pays (ISO 3166-1 alpha-2), si le client l'a précisé." },
        },
        required: ["item_id"],
      },
    },
    async run(siteId, input) {
      const itemId = requireString(input, "item_id");
      const quantity = Math.max(1, Math.floor(Number(input.quantity) || 1));
      const mode = input.mode === "click_and_collect" ? "click_and_collect" : "reservation";
      const module = mode === "reservation" ? "ropis" : "ckc";
      const country = typeof input.country_code === "string" && input.country_code.trim() ? input.country_code.trim().toUpperCase() : undefined;

      const requestName = (await getOnestockSettings(siteId)).stockRequestName;
      const stock = await onestockRequest(siteId, "GET", "/v1/stock_export", {
        request_name: requestName,
        aggregates: { "*": { item_filter: { ids: [itemId] } } },
      });
      if (!stock.ok) return stock;
      // Stock immédiatement disponible (on_hand) par point de stock.
      const byEndpoint = new Map<string, number>();
      for (const s of ((stock.data as Input)?.stocks ?? []) as Input[]) {
        if (s?.endpoint_id === undefined || (s.type && s.type !== "on_hand") || (s.item_id && s.item_id !== itemId)) continue;
        byEndpoint.set(String(s.endpoint_id), (byEndpoint.get(String(s.endpoint_id)) ?? 0) + (Number(s.quantity) || 0));
      }
      const candidates = [...byEndpoint].filter(([, q]) => q >= quantity).sort((a, b) => b[1] - a[1]).slice(0, 200);

      const endpoints: Input[] = [];
      for (let i = 0; i < candidates.length; i += 50) {
        const ids = candidates.slice(i, i + 50).map(([id]) => id);
        const res = await onestockRequest(siteId, "GET", "/v3/endpoints", {
          endpoint_ids: ids,
          fields: ENDPOINT_FIELDS,
          pagination: { limit: ids.length, start: 0 },
        });
        if (res.ok) endpoints.push(...(((res.data as Input)?.endpoints ?? []) as Input[]));
      }
      const byId = new Map(endpoints.map((e) => [String(e.id), e]));
      const stores: StoreMap["stores"] = [];
      for (const [id, qty] of candidates) {
        const e = byId.get(id);
        if (!e) continue;
        if (e.open === false || e.modules?.[module] === false) continue;
        const a: Input = e.address ?? {};
        const countryCode = a.regions?.country?.code ? String(a.regions.country.code).toUpperCase() : undefined;
        if (country && countryCode && countryCode !== country) continue;
        const lat = Number(a.coordinates?.lat);
        const lon = Number(a.coordinates?.lon);
        stores.push(compact({
          id,
          name: String(e.name ?? id),
          lines: Array.isArray(a.lines) ? a.lines.map(String) : undefined,
          zip_code: a.zip_code ? String(a.zip_code) : undefined,
          city: a.city ? String(a.city) : undefined,
          country_code: countryCode,
          lat: Number.isFinite(lat) && a.coordinates?.lat !== undefined ? lat : undefined,
          lon: Number.isFinite(lon) && a.coordinates?.lon !== undefined ? lon : undefined,
          stock: qty,
        }) as StoreMap["stores"][number]);
      }
      const map: StoreMap = compact({ item_id: itemId, item_name: input.item_name || undefined, quantity, mode, stores }) as StoreMap;
      return {
        ok: true,
        status: 200,
        data: {
          item_id: itemId,
          quantity,
          mode,
          stores_with_stock: stores.length,
          // Le modèle reçoit une liste courte ; la carte affiche tous les magasins.
          stores: stores.slice(0, 30).map(({ id, name, city, zip_code, stock: qty }) => ({ id, name, city, zip_code, stock: qty })),
          note: stores.length
            ? "Une carte avec ces magasins est affichée à l'utilisateur : il peut cliquer sur un magasin pour le choisir."
            : "Aucun magasin n'a assez de stock pour ce service : propose une livraison à domicile ou une autre quantité.",
        },
        stores: stores.length ? map : undefined,
      };
    },
  },

  create_order: {
    write: true,
    definition: {
      name: "create_order",
      description:
        "Création d'une commande client (POST /v3/orders). Mode par défaut et à proposer en premier : " +
        "« reservation » (e-réservation / Reserve & Collect, type ropis : les articles sont réservés dans un magasin " +
        "et payés au retrait). Autres modes : « click_and_collect » (payé en ligne, retiré en magasin) et " +
        "« home_delivery » (livraison à domicile, adresse obligatoire). Les prix unitaires viennent de la fiche " +
        "article (caractéristique price) ; le magasin doit avoir du stock (get_item_stock).",
      input_schema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["reservation", "click_and_collect", "home_delivery"], description: "Défaut : reservation." },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                item_id: { type: "string" },
                quantity: { type: "integer", minimum: 1 },
                unit_price: { type: "number", description: "Prix unitaire TTC (fiche article)." },
                name: { type: "string", description: "Nom de l'article (affiché dans le récapitulatif)." },
              },
              required: ["item_id", "quantity", "unit_price"],
            },
          },
          endpoint_id: { type: "string", description: "Magasin de retrait (reservation, click_and_collect)." },
          endpoint_name: { type: "string", description: "Nom du magasin (affiché dans le récapitulatif)." },
          customer: { ...contactSchema, description: "Client : nom, prénom, et email ou téléphone." },
          delivery_address: { ...addressSchema, description: "Adresse de livraison (home_delivery uniquement)." },
          currency: { type: "string", description: "Devise ISO 4217. Défaut : EUR." },
          sales_channel: {
            type: "string",
            description: "Canal de vente, seulement si l'utilisateur l'impose. Sinon, il est choisi selon le pays de livraison (sales_channels_by_country de la table settings).",
          },
          id_format: { type: "string", description: "Format d'identifiant de commande configuré chez OneStock (facultatif)." },
        },
        required: ["items", "customer"],
      },
    },
    async validate(_siteId, input) {
      const mode = orderMode(input);
      const items: Input[] = Array.isArray(input.items) ? input.items : [];
      const problems: string[] = [];
      if (!items.length) problems.push("aucun article");
      for (const it of items) {
        if (!it?.item_id) problems.push("un article sans référence");
        if (!(Number(it?.quantity) >= 1)) problems.push(`quantité de ${it?.item_id ?? "?"}`);
        if (!Number.isFinite(Number(it?.unit_price)) || it?.unit_price === "" || it?.unit_price === null) {
          problems.push(`prix unitaire de ${it?.item_id ?? "?"} (à lire dans la fiche article, sinon à demander)`);
        }
      }
      const c: Input = input.customer ?? {};
      if (!c.last_name) problems.push("nom du client");
      if (!c.email && !c.phone_number) problems.push("email ou téléphone du client");
      if (mode !== "home_delivery" && !input.endpoint_id) problems.push("magasin de retrait (endpoint_id)");
      if (mode === "home_delivery") {
        const missing = missingAddressParts(input.delivery_address);
        if (missing.length) problems.push(`adresse de livraison (${missing.join(", ")})`);
      }
      return problems.length
        ? `Commande non proposée, rien n'a été créé. Informations manquantes : ${problems.join(" ; ")}. Demande-les à l'utilisateur (sans les inventer), puis rappelle create_order.`
        : undefined;
    },
    async run(siteId, input) {
      const mode = orderMode(input);
      const currency = String(input.currency || "EUR").toUpperCase();
      const items: Input[] = Array.isArray(input.items) ? input.items : [];
      const round = (n: number) => Math.round(n * 100) / 100;
      const orderItems = items.map((it) => {
        const quantity = Math.max(1, Math.floor(Number(it.quantity) || 1));
        const unit = Number(it.unit_price);
        const total = round(unit * quantity);
        return {
          item_id: String(it.item_id),
          quantity,
          pricing_details: { unit_price: unit, original_unit_price: unit, price: total, original_price: total },
        };
      });
      const customer = compact({
        title: input.customer?.title, first_name: input.customer?.first_name, last_name: input.customer?.last_name,
        email: input.customer?.email, phone_number: input.customer?.phone_number,
      });
      const destination = mode === "home_delivery"
        ? { address: toOnestockAddress({ ...input.delivery_address, contact: input.delivery_address?.contact ?? customer }) }
        : { endpoint_id: String(input.endpoint_id) };
      const types = mode === "reservation" ? ["ropis"] : mode === "click_and_collect" ? ["ffs", "ckc"] : ["ffs"];
      // Canal de vente : imposé par l'utilisateur, sinon celui du pays de livraison (adresse du client ou du magasin).
      const country = await deliveryCountry(siteId, mode, input);
      const salesChannel = input.sales_channel || salesChannelFor((await getOnestockSettings(siteId)).salesChannels, country);
      const res = await onestockRequest(siteId, "POST", "/v3/orders", compact({
        id_format: input.id_format || undefined,
        order: compact({
          types,
          customer,
          delivery: { destination },
          order_items: orderItems,
          pricing_details: { currency, price: round(orderItems.reduce((sum, i) => sum + i.pricing_details.price, 0)) },
          sales_channel: salesChannel || undefined,
        }),
      }));
      if (!res.ok) return res;
      const data = res.data as Input | null;
      const orderId = String(data?.id ?? data?.order?.id ?? data?.order_id ?? "");
      return {
        ...res,
        data: { created: true, order_id: orderId || undefined, mode, delivery_country: country, sales_channel: salesChannel ?? "default", response: data },
        notice: { code: "order_created", order_id: orderId, order_mode: mode },
      };
    },
  },

  find_api_operations: {
    write: false,
    definition: {
      name: "find_api_operations",
      description:
        "Recherche dans le catalogue complet des API OneStock (≈ 750 routes) quand aucun outil dédié ne convient : " +
        "fiches articles et produits, création de commande, zones et routes de livraison, transporteurs, points de " +
        "stock, canaux de vente, clients, retours, paiements, gestes commerciaux, capacités, réservations, règles " +
        "d'orchestration, cartes cadeaux, taxes, webhooks… Mots-clés en français ou en anglais (ex. « zone », " +
        "« delivery route », « créer commande »). Sans mot-clé ni catégorie : liste des catégories. Renvoie méthode, " +
        "chemin (avec version) et résumé ; ensuite, describe_api_operation pour le détail.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Mots-clés (ressource, action)." },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "Filtrer par méthode." },
          category: { type: "string", description: "Filtrer par catégorie (ex. Delivery Promise, Product Information)." },
        },
      },
    },
    async run(_siteId, input) {
      const query = typeof input.query === "string" ? input.query : "";
      if (!query.trim() && !input.category) return { ok: true, status: 200, data: { categories: await listCategories() } };
      const data = await findOperations(query, { method: input.method, tag: input.category });
      return { ok: true, status: 200, data };
    },
  },

  describe_api_operation: {
    write: false,
    definition: {
      name: "describe_api_operation",
      description:
        "Documentation d'une route OneStock : description, paramètres de chemin, champs obligatoires, schéma du " +
        "corps et exemple. À lire avant tout appel avec call_onestock_api, pour savoir quelles informations " +
        "demander à l'utilisateur. schema_name permet de lire un sous-schéma signalé par « see_schema ».",
      input_schema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", description: "Chemin, ex. /v1/zones ou /v1/zones/{id}." },
          schema_name: { type: "string", description: "Nom d'un sous-schéma (valeur de see_schema)." },
        },
        required: ["method", "path"],
      },
    },
    async run(_siteId, input) {
      const data = await describeOperation(String(input.method ?? "GET"), String(input.path ?? ""), input.schema_name || undefined);
      return { ok: !("error" in data), status: "error" in data ? 404 : 200, data };
    },
  },

  call_onestock_api: {
    // Lecture (GET) exécutée directement ; toute autre méthode passe par la carte de confirmation.
    write: (input) => String(input.method ?? "GET").toUpperCase() !== "GET",
    definition: {
      name: "call_onestock_api",
      description:
        "Appel d'une route de l'API OneStock du catalogue (après describe_api_operation). GET = lecture, exécutée " +
        "directement ; POST, PUT, PATCH, DELETE = création, modification ou suppression, soumises à la confirmation " +
        "de l'utilisateur. site_id et token sont ajoutés automatiquement. Les routes d'authentification et de droits " +
        "d'accès ne sont pas disponibles.",
      input_schema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", description: "Chemin concret avec version, ex. /v1/zones/zone_paris (identifiants réels)." },
          body: { type: "object", description: "Corps JSON de la requête (filtres, champs, objet à créer ou modifier).", additionalProperties: true },
          title: { type: "string", description: "Écriture : titre court de l'action pour l'utilisateur, dans sa langue, sans jargon (ex. « Créer la zone Île-de-France »)." },
          summary: { type: "string", description: "Écriture : une ou deux phrases qui expliquent à l'utilisateur, sans jargon technique, ce qui va être créé, modifié ou supprimé." },
        },
        required: ["method", "path"],
      },
    },
    async validate(_siteId, input) {
      const method = String(input.method ?? "GET").toUpperCase();
      const problem = await checkCall(method, String(input.path ?? ""), input.body);
      if (problem) return problem;
      if (method !== "GET" && (!input.title || !input.summary)) {
        return "Renseigne title et summary (récapitulatif compréhensible par l'utilisateur) pour cette action, puis rappelle l'outil.";
      }
      return undefined;
    },
    async run(siteId, input) {
      const method = String(input.method ?? "GET").toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      const problem = await checkCall(method, String(input.path ?? ""), input.body);
      if (problem) return { ok: false, status: 400, data: { error: problem } };
      const found = (await matchOperation(method, String(input.path)))!;
      const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? { ...(input.body as Input) } : {};
      delete body.site_id;
      delete body.token;
      const res = await onestockRequest(siteId, method, `/${found.version}${safeConcretePath(found.concretePath)}`, body);
      // Réponses volumineuses (listes) tronquées pour rester dans le contexte du modèle.
      const text = JSON.stringify(res.data ?? null);
      if (text.length <= MAX_API_RESPONSE_CHARS) return res;
      return {
        ...res,
        data: {
          truncated: true,
          note: "Réponse tronquée : affiner la requête (fields, filtres, pagination.limit).",
          partial_json: text.slice(0, MAX_API_RESPONSE_CHARS),
        },
      };
    },
  },
};

/** Outils au format « function calling » d'OpenAI. */
export const TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[] = Object.values(TOOLS).map(({ definition }) => ({
  type: "function",
  function: { name: definition.name, description: definition.description, parameters: definition.input_schema },
}));

/** Action d'écriture (confirmation obligatoire) ; un appel d'API générique l'est pour toute méthode autre que GET. */
export function isWriteTool(name: string, input: unknown = {}): boolean {
  const write = TOOLS[name]?.write;
  return typeof write === "function" ? write((input ?? {}) as Input) : write === true;
}

/** Contrôle avant confirmation (voir ToolSpec.validate) ; une erreur de contrôle n'empêche pas la proposition. */
export async function validateTool(siteId: string, name: string, input: unknown): Promise<string | undefined> {
  const tool = TOOLS[name];
  if (!tool?.validate) return undefined;
  try {
    return await tool.validate(siteId, (input ?? {}) as Input);
  } catch (err) {
    console.warn("[tools] validation failed", name, err);
    return undefined;
  }
}

/** Exécute un outil et renvoie un résultat sérialisé pour le modèle (les erreurs y sont décrites, pas levées). */
export async function runTool(
  siteId: string,
  name: string,
  input: unknown,
  ctx: ToolContext = { userId: "" },
): Promise<{ content: string; isError: boolean; notice?: ToolNotice; stores?: StoreMap }> {
  const tool = TOOLS[name];
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  try {
    const res = await tool.run(siteId, (input ?? {}) as Input, ctx);
    return {
      content: JSON.stringify(
        res.ok ? res.data ?? { success: true, status: res.status } : { error: true, status: res.status, response: res.data },
      ),
      isError: !res.ok,
      notice: res.notice,
      stores: res.stores,
    };
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
