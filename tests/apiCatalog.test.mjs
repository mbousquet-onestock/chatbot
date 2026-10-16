import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Le catalogue est lu par useStorage (Nitro) : remplacé ici par une lecture du fichier.
const data = JSON.parse(readFileSync(new URL("../server/data/onestock-api.json", import.meta.url), "utf8"));
globalThis.useStorage = () => ({ getItem: async () => data });
const { findOperations, matchOperation, checkCall, describeOperation, safeConcretePath } = await import("../server/utils/apiCatalog.ts");

test("search finds zones and delivery routes, with French keywords", async () => {
  const zones = await findOperations("zones");
  assert.ok(zones.operations.some((o) => o.path === "/v1/zones" && o.method === "POST"));
  const routes = await findOperations("routes de livraison");
  assert.ok(routes.operations.some((o) => o.path.startsWith("/v1/delivery_routes")));
});

test("authentication routes are never exposed", async () => {
  const res = await findOperations("login token password");
  assert.ok(res.operations.every((o) => !/login|token|password/i.test(o.path) && o.category !== "Authentication"));
  assert.match(await checkCall("POST", "/v1/login", {}), /pas disponible|Aucune opération/);
});

test("concrete paths match the most specific template and keep the requested version", async () => {
  const m = await matchOperation("PATCH", "/v1/zones/zone_paris");
  assert.equal(m.op.p, "/zones/{id}");
  assert.equal(m.version, "v1");
  const orders = await matchOperation("POST", "/orders");
  assert.equal(orders.op.p, "/orders");
});

test("missing required fields are reported before any call", async () => {
  const problem = await checkCall("POST", "/v1/zones", {});
  assert.match(problem, /zone/);
  assert.equal(await checkCall("POST", "/v1/zones", { zone: { id: "z1" } }), undefined);
  assert.match(await checkCall("PATCH", "/v1/zones/{id}", {}), /paramètres/);
});

test("describe returns the body schema without authentication fields", async () => {
  const d = await describeOperation("POST", "/v1/zones");
  assert.deepEqual(d.required_body_fields, ["zone"]);
  assert.ok(!("token" in d.body_schema.properties) && !("site_id" in d.body_schema.properties));
});

test("unsafe path segments are rejected and ids encoded", () => {
  assert.throws(() => safeConcretePath("/zones/../login"));
  assert.equal(safeConcretePath("/items/a b"), "/items/a%20b");
});
