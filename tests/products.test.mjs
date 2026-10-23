import { test } from "node:test";
import assert from "node:assert/strict";
import { extractProducts, flattenFeatures } from "../server/utils/products.ts";

test("features by language: the preferred language wins, missing values come from other languages", () => {
  const f = flattenFeatures({ en: { name: ["Grill"], price: ["299"] }, fr: { name: ["Barbecue électrique NINJA"], color: ["Gris"] } }, ["fr"]);
  assert.deepEqual(f, { name: "Barbecue électrique NINJA", price: "299", color: "Gris" });
  assert.deepEqual(flattenFeatures({ name: ["T-shirt"] }, ["fr"]), { name: "T-shirt" });
});

test("search results become selectable cards", () => {
  const list = extractProducts("search_items", {
    items: [{ id: "00007", features: { fr: { name: ["Barbecue électrique NINJA"], price: ["299"], color: ["Gris"], image_url: ["https://cdn.example.com/ninja.png"] } } }],
  }, ["fr"]);
  assert.deepEqual(list, {
    context: "search",
    products: [{ id: "00007", name: "Barbecue électrique NINJA", image: "https://cdn.example.com/ninja.png", price: 299, color: "Gris" }],
  });
});

test("order items use the order unit price, currency and quantity", () => {
  const list = extractProducts("get_order", {
    order: {
      id: "ORD1",
      pricing_details: { currency: "EUR" },
      order_items: [{ item_id: "item1", quantity: 2, item: { features: { name: ["Grey T-shirt"] } }, pricing_details: { unit_price: 129 } }],
    },
  }, ["fr"]);
  assert.equal(list.context, "order");
  assert.equal(list.order_id, "ORD1");
  assert.deepEqual(list.products[0], { id: "item1", name: "Grey T-shirt", price: 129, quantity: 2, currency: "EUR" });
});

test("image and price are found under other feature names; a zero price is ignored", async () => {
  const { findImage } = await import("../server/utils/products.ts");
  assert.equal(findImage({ main_picture_url: "https://cdn.example.com/a.jpg" }), "https://cdn.example.com/a.jpg");
  assert.equal(findImage({ link: "https://shop.example.com/p", visuel: "https://cdn.example.com/b.webp?w=200" }), "https://cdn.example.com/b.webp?w=200");
  const list = extractProducts("search_items", { items: [{ id: "00005", features: { fr: { name: ["Friteuse"], price: ["0"] } }, sales_channels_features: { web: { price: 129.99 } } }] }, ["fr"]);
  assert.equal(list.products[0].price, 129.99);
});

test("no unsafe image URL", () => {
  const list = extractProducts("get_item", { items: [{ id: "y", features: { name: ["A"], image_url: ["javascript:alert(1)"] } }] }, ["fr"]);
  assert.equal(list.products[0].image, undefined);
});

test("cards are completed with the full item sheet; order values win", async () => {
  const { enrichProducts } = await import("../server/utils/products.ts");
  const list = { context: "search", products: [{ id: "00005", name: "Friteuse sans huile MOULINEX Easy Fry XXL 7.5L", color: "Terracotta" }] };
  let asked;
  const out = await enrichProducts(list, ["fr"], async (ids) => {
    asked = ids;
    return { ok: true, data: { items: [{ id: "00005", features: { fr: { name: ["Friteuse"], prix_ttc: ["149,90"] }, "*": { visuel_principal: ["https://cdn.example.com/easyfry.jpg"] } } }] } };
  });
  assert.deepEqual(asked, ["00005"]);
  assert.deepEqual(out.products[0], {
    id: "00005", name: "Friteuse sans huile MOULINEX Easy Fry XXL 7.5L", image: "https://cdn.example.com/easyfry.jpg", price: 149.9, color: "Terracotta",
  });
});
