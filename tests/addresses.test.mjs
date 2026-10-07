import { test } from "node:test";
import assert from "node:assert/strict";
import { missingAddressParts, sameAddress } from "../server/utils/addresses.ts";

test("lists the missing parts of an address", () => {
  assert.deepEqual(missingAddressParts({ lines: ["26 Rue Victor Hugo"], zip_code: "69002", city: "Lyon", country_code: "FR" }), []);
  assert.deepEqual(missingAddressParts({ lines: [" "], city: "Lyon" }), ["numéro et rue", "code postal", "pays"]);
  assert.deepEqual(missingAddressParts(undefined), ["numéro et rue", "code postal", "ville", "pays"]);
});

test("detects a proposed address identical to the current OneStock address", () => {
  const current = { lines: ["26 rue Victor  Hugo"], zip_code: "69002", city: "LYON", regions: { country: { code: "FR" } } };
  assert.equal(sameAddress(current, { lines: ["26 Rue Victor Hugo"], zip_code: "69002", city: "Lyon", country_code: "fr" }), true);
  assert.equal(sameAddress(current, { lines: ["5 Place Bellecour"], zip_code: "69002", city: "Lyon", country_code: "FR" }), false);
});
