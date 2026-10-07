import type OpenAI from "openai";
import { toOnestockDate } from "./dates";
import { encodeId, onestockRequest, type OnestockResult } from "./onestock";

type Input = Record<string, any>;

/** Définition d'un outil : nom, description et schéma JSON des paramètres. */
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Message à afficher à l'utilisateur (alerte dans la conversation), traduit côté front à partir de son code. */
export interface ToolNotice {
  code: "cancel_done" | "cancel_partial" | "cancel_not_possible" | "cancel_nothing" | "cancel_error";
  order_id: string;
  /** États des lignes annulées et des lignes dont la transition a été refusée. */
  cancelled_states?: string[];
  refused_states?: string[];
}

export interface ToolSpec {
  definition: ToolDefinition;
  /** Une action d'écriture n'est exécutée qu'après confirmation explicite de l'utilisateur. */
  write: boolean;
  run: (siteId: string, input: Input, ctx: ToolContext) => Promise<OnestockResult & { notice?: ToolNotice }>;
}

/** Contexte de l'appel : utilisateur OneStock à l'origine de l'action (vide s'il n'est pas connu). */
export interface ToolContext {
  userId: string;
}

/**
 * PATCH d'une commande avec `user_id` : OneStock attribue alors la modification à cet utilisateur dans
 * l'historique de la commande. Si l'utilisateur est refusé (4xx), on réessaie sans lui : la modification
 * passe, attribuée à l'utilisateur technique du token, et le résultat le signale.
 */
async function patchOrder(siteId: string, orderId: string, order: Record<string, unknown>, ctx: ToolContext) {
  const path = `/v3/orders/${encodeId(orderId)}`;
  if (!ctx.userId) return onestockRequest(siteId, "PATCH", path, { order });
  const res = await onestockRequest(siteId, "PATCH", path, { order, user_id: ctx.userId });
  if (res.ok || res.status >= 500) return res;
  const retry = await onestockRequest(siteId, "PATCH", path, { order });
  return retry.ok
    ? { ...retry, data: { ...(typeof retry.data === "object" && retry.data ? retry.data : {}), history_user: "technical_user", user_id_refused: ctx.userId } }
    : res;
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

/** Lien vers la route /api/documents qui affiche un document OneStock. */
export function documentLink(documentId: string, siteId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}?site_id=${encodeURIComponent(siteId)}`;
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
        "Détail complet d'une commande (GET /v3/orders/{id}) : état, client, livraison, prix, articles (order_items), " +
        "line item groups (état de préparation par article, avec leurs index), colis et suivi transporteur.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          fields: { ...stringArray, description: "Champs à renvoyer (avancé). Par défaut : vue complète." },
        },
        required: ["order_id"],
      },
    },
    run: (siteId, input) =>
      onestockRequest(siteId, "GET", `/v3/orders/${encodeId(requireString(input, "order_id"))}`, {
        fields: input.fields?.length ? input.fields : DEFAULT_ORDER_FIELDS,
      }),
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
    async run(siteId, input) {
      const res = await onestockRequest(siteId, "GET", `/v3/orders/${encodeId(requireString(input, "order_id"))}`, {
        fields: [
          "id", "state", "information", "parcels.id", "parcels.state", "parcels.line_item_index_ranges", "parcels.information",
          "parcels.delivery.destination.address", "parcels.delivery.destination.endpoint_id", "parcels.delivery.origin",
          "parcels.delivery.carrier", "parcels.delivery.type", "parcels.shipment.tracking_code",
          "parcels.shipment.tracking_link", "parcels.date", "parcels.last_update", "parcels.documents",
        ],
      });
      return res.ok ? { ...res, data: withDocumentLinks(res.data, siteId) } : res;
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
          lang: { type: "string", description: "Langue des caractéristiques (ex. fr, en). Défaut : langue de l'utilisateur." },
          features: { ...stringArray, description: `Caractéristiques à lire. Défaut : ${DEFAULT_ITEM_FEATURES.join(", ")}.` },
        },
        required: ["order_id", "lang"],
      },
    },
    run: (siteId, input) =>
      onestockRequest(siteId, "GET", `/v3/orders/${encodeId(requireString(input, "order_id"))}`, {
        fields: [
          "id",
          "order_items._id",
          "order_items.item_id",
          "order_items.quantity",
          ...featureNames(input).map((f) => `order_items.item.features.${f}`),
        ],
        item_features_lang: requireString(input, "lang"),
      }),
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
    run(siteId, input) {
      const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
      const searchable: string[] = input.searchable_fields?.length ? input.searchable_fields.map(String) : ["name"];
      const lang = typeof input.lang === "string" && input.lang.trim() ? input.lang.trim() : undefined;
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
    run: (siteId, input, ctx) =>
      patchOrder(siteId, requireString(input, "order_id"), { from: requireString(input, "from"), to: requireString(input, "to") }, ctx),
  },

  update_order: {
    write: true,
    definition: {
      name: "update_order",
      description:
        "ÉCRITURE — Met à jour des données d'une commande (PATCH /v3/orders/{id}) : coordonnées client, adresse de " +
        "livraison, informations libres, signature au retrait. N'envoyer que les champs à modifier. " +
        "L'utilisateur devra confirmer avant exécution.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          customer: {
            type: "object",
            properties: {
              title: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" },
              email: { type: "string" }, phone_number: { type: "string" },
            },
          },
          delivery_address: {
            type: "object",
            description: "Adresse de livraison complète (remplace l'adresse existante).",
            properties: {
              lines: stringArray,
              zip_code: { type: "string" },
              city: { type: "string" },
              country_code: { type: "string", description: "Code pays ISO 3166-1 alpha-2." },
              contact: {
                type: "object",
                properties: {
                  title: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" },
                  email: { type: "string" }, phone_number: { type: "string" },
                },
              },
            },
            required: ["lines", "zip_code", "city", "country_code"],
          },
          information: { type: "object", description: "Champs libres de order.information à fusionner." },
          sign_on_collect: { type: "boolean" },
        },
        required: ["order_id"],
      },
    },
    run(siteId, input, ctx) {
      const a = input.delivery_address;
      const order = compact({
        customer: input.customer && Object.keys(input.customer).length ? input.customer : undefined,
        information: input.information && Object.keys(input.information).length ? input.information : undefined,
        sign_on_collect: typeof input.sign_on_collect === "boolean" ? input.sign_on_collect : undefined,
        delivery: a
          ? {
              destination: {
                address: compact({
                  lines: a.lines,
                  zip_code: a.zip_code,
                  city: a.city,
                  regions: { country: { code: a.country_code } },
                  contact: a.contact,
                }),
              },
            }
          : undefined,
      });
      if (!Object.keys(order).length) throw new Error("Nothing to update");
      return patchOrder(siteId, requireString(input, "order_id"), order, ctx);
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
};

/** Outils au format « function calling » d'OpenAI. */
export const TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[] = Object.values(TOOLS).map(({ definition }) => ({
  type: "function",
  function: { name: definition.name, description: definition.description, parameters: definition.input_schema },
}));

export const isWriteTool = (name: string) => TOOLS[name]?.write === true;

/** Exécute un outil et renvoie un résultat sérialisé pour le modèle (les erreurs y sont décrites, pas levées). */
export async function runTool(
  siteId: string,
  name: string,
  input: unknown,
  ctx: ToolContext = { userId: "" },
): Promise<{ content: string; isError: boolean; notice?: ToolNotice }> {
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
    };
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
