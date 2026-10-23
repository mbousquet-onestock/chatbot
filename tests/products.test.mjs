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

test("no cards without name or image, and no unsafe image URL", () => {
  assert.equal(extractProducts("search_items", { items: [{ id: "x", features: {} }] }, ["fr"]), undefined);
  const list = extractProducts("get_item", { items: [{ id: "y", features: { name: ["A"], image_url: ["javascript:alert(1)"] } }] }, ["fr"]);
  assert.equal(list.products[0].image, undefined);
});
