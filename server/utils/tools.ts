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

export interface ToolSpec {
  definition: ToolDefinition;
  /** Une action d'écriture n'est exécutée qu'après confirmation explicite de l'utilisateur. */
  write: boolean;
  run: (siteId: string, input: Input) => Promise<OnestockResult>;
}

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
      description: "Détail d'un colis (GET /v2/parcels/{id}) : état, transporteur, suivi, documents.",
      input_schema: { type: "object", properties: { parcel_id: { type: "string" } }, required: ["parcel_id"] },
    },
    run: (siteId, input) => onestockRequest(siteId, "GET", `/v2/parcels/${encodeId(requireString(input, "parcel_id"))}`),
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
        "ÉCRITURE — Fait passer une commande d'un état à un autre (PATCH /v3/orders/{id}, order.from → order.to), " +
        "par exemple pour l'annuler. `from` doit être l'état actuel (lire la commande avant) et la transition doit " +
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
    run(siteId, input) {
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
      return onestockRequest(siteId, "PATCH", `/v3/orders/${encodeId(requireString(input, "order_id"))}`, { order });
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
export async function runTool(siteId: string, name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
  const tool = TOOLS[name];
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  try {
    const res = await tool.run(siteId, (input ?? {}) as Input);
    return {
      content: JSON.stringify(
        res.ok ? res.data ?? { success: true, status: res.status } : { error: true, status: res.status, response: res.data },
      ),
      isError: !res.ok,
    };
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
