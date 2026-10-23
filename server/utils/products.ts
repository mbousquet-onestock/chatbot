/**
 * Articles à afficher en cartes dans la conversation (vignette, nom, prix, couleur, référence), extraits des
 * réponses des outils catalogue et commande.
 */
export interface ProductCard {
  id: string;
  name?: string;
  image?: string;
  price?: number;
  currency?: string;
  color?: string;
  size?: string;
  /** Quantité commandée (articles d'une commande). */
  quantity?: number;
}

export interface ProductList {
  /** order : articles d'une commande ; search : résultat de recherche ou fiche article (sélectionnables). */
  context: "order" | "search";
  order_id?: string;
  products: ProductCard[];
}

/** Outils dont la réponse contient des articles. */
export const PRODUCT_TOOLS = new Set(["get_order", "get_order_items_details", "get_item", "search_items"]);

const MAX_CARDS = 20;

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const text = (v: unknown): string | undefined => {
  const x = first(v);
  return x === undefined || x === null || x === "" ? undefined : isObj(x) ? undefined : String(x);
};

/**
 * Caractéristiques à plat (nom → valeur) : les réponses OneStock les donnent soit par langue
 * ({ fr: { name: ["…"] } }), soit directement ({ name: ["…"] }). La première langue disponible de `langs` est
 * retenue, sinon « * », sinon la première langue présente.
 */
export function flattenFeatures(features: unknown, langs: string[]): Record<string, string> {
  if (!isObj(features)) return {};
  const values = Object.values(features);
  const byLang = values.length > 0 && values.every((v) => isObj(v));
  let chosen: Obj = features;
  if (byLang) {
    const key = [...langs, "*"].find((l) => isObj(features[l])) ?? Object.keys(features)[0]!;
    // Valeurs manquantes dans la langue retenue : complétées par les autres langues (ex. prix sous « * »).
    chosen = Object.assign({}, ...Object.values(features).reverse(), features[key]);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(chosen)) {
    const s = text(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

const IMAGE_KEYS = ["image_url", "image", "images", "image_urls", "picture", "thumbnail", "media"];
const COLOR_KEYS = ["color", "colour", "couleur"];
const SIZE_KEYS = ["size", "taille"];

const pick = (f: Record<string, string>, keys: string[]) => keys.map((k) => f[k]).find(Boolean);
/** Nombre strictement positif (un prix à 0 est considéré comme absent). */
const toNumber = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const isUrl = (v: string | undefined) => !!v && /^https?:\/\//i.test(v);

/**
 * URL de l'image dans les caractéristiques : noms usuels, puis toute caractéristique dont le nom évoque une image,
 * puis toute valeur qui ressemble à une URL d'image.
 */
export function findImage(f: Record<string, string>): string | undefined {
  const known = IMAGE_KEYS.map((k) => f[k]).find(isUrl);
  if (known) return known;
  const named = Object.entries(f).find(([k, v]) => /image|img|picture|photo|visual|media|thumb/i.test(k) && isUrl(v));
  if (named) return named[1];
  return Object.values(f).find((v) => isUrl(v) && /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(v));
}

/** Prix : caractéristique price, sinon une caractéristique dont le nom contient price ou prix. */
function findPrice(f: Record<string, string>): number | undefined {
  return toNumber(f.price) ?? Object.entries(f).filter(([k]) => /price|prix/i.test(k) && !/compare|original|old|barr/i.test(k))
    .map(([, v]) => toNumber(v)).find((n) => n !== undefined);
}

function card(id: unknown, features: Record<string, string>, extra: Partial<ProductCard> = {}): ProductCard | undefined {
  if (id === undefined || id === null || id === "") return undefined;
  return Object.fromEntries(
    Object.entries({
      id: String(id),
      name: features.name ?? features.title ?? features.label,
      image: findImage(features),
      price: findPrice(features),
      color: pick(features, COLOR_KEYS),
      size: pick(features, SIZE_KEYS),
      ...extra,
    }).filter(([, v]) => v !== undefined),
  ) as unknown as ProductCard;
}

/** Cartes articles à partir de la réponse JSON d'un outil (undefined si aucune). */
export function extractProducts(tool: string, data: unknown, langs: string[], input: Obj = {}): ProductList | undefined {
  if (!PRODUCT_TOOLS.has(tool) || !isObj(data)) return undefined;
  let list: ProductList | undefined;

  if (tool === "get_order" || tool === "get_order_items_details") {
    const order: Obj = isObj(data.order) ? data.order : data;
    const currency = text(order.pricing_details?.currency);
    const items: unknown[] = Array.isArray(order.order_items) ? order.order_items : [];
    const products = items.flatMap((oi) => {
      if (!isObj(oi)) return [];
      const f = flattenFeatures(oi.item?.features, langs);
      const unit = toNumber(oi.pricing_details?.unit_price ?? oi.pricing_details?.original_unit_price);
      const c = card(oi.item_id, f, compactCard({ quantity: toNumber(oi.quantity), price: unit ?? findPrice(f), currency }));
      return c ? [c] : [];
    });
    list = { context: "order", order_id: text(order.id) ?? text(input.order_id), products };
  } else {
    const items: unknown[] = Array.isArray(data.items) ? data.items : [];
    const products = items.flatMap((it) => {
      if (!isObj(it)) return [];
      const f = flattenFeatures(it.features, langs);
      const scf = it.sales_channels_features;
      const c = card(it.id, f, compactCard({ price: findPrice(f) ?? salesChannelPrice(scf) }));
      return c ? [c] : [];
    });
    list = { context: "search", products };
  }

  if (!list.products.length) return undefined;
  return { ...list, products: list.products.slice(0, MAX_CARDS) };
}

/** Prix d'un article dans ses caractéristiques par canal de vente ({ canal: { price } } ou { price }). */
function salesChannelPrice(scf: unknown): number | undefined {
  if (!isObj(scf)) return undefined;
  if (scf.price !== undefined) return toNumber(scf.price);
  return Object.values(scf).map((v) => (isObj(v) ? toNumber(v.price) : undefined)).find((n) => n !== undefined);
}

/**
 * Complète les cartes (image, prix, nom, couleur, taille) avec la fiche article complète (GET /v3/items, toutes
 * les caractéristiques) : la recherche ou la commande ne renvoient souvent qu'une partie des caractéristiques.
 */
export async function enrichProducts(
  list: ProductList,
  langs: string[],
  /** Lecture des fiches articles complètes (GET /v3/items, filtre ids). */
  readItems: (ids: string[]) => Promise<{ ok: boolean; data: unknown }>,
): Promise<ProductList> {
  const missing = list.products.filter((p) => !p.image || p.price === undefined || !p.name).map((p) => p.id);
  if (!missing.length) return list;
  const res = await readItems(missing);
  if (!res.ok || !isObj(res.data) || !Array.isArray(res.data.items)) return list;
  const sheets = new Map<string, ProductCard>();
  for (const it of res.data.items as unknown[]) {
    if (!isObj(it)) continue;
    const f = flattenFeatures(it.features, langs);
    const c = card(it.id, f, compactCard({ price: findPrice(f) ?? salesChannelPrice(it.sales_channels_features) }));
    if (c) sheets.set(c.id, c);
  }
  return {
    ...list,
    products: list.products.map((p) => {
      const sheet = sheets.get(p.id);
      if (!sheet) return p;
      // Les valeurs de la commande (prix payé, quantité) priment ; la fiche complète le reste.
      return compactCard({ ...sheet, ...compactCard(p), price: p.price ?? sheet.price, image: p.image ?? sheet.image }) as ProductCard;
    }),
  };
}

function compactCard(c: Partial<ProductCard>): Partial<ProductCard> {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as Partial<ProductCard>;
}
