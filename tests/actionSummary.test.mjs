import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAction } from "../app/utils/actionSummary.ts";

const julien = { title: "M.", first_name: "Julien", last_name: "Moreau", email: "alertes_os@onestock-retail.com", phone_number: "+33 6 45 12 98 23" };

test("customer and address update reads like a form, without technical field names", () => {
  const s = summarizeAction("update_order", {
    order_id: "SFS-004",
    customer: julien,
    shipping_address: { lines: ["26 Rue Victor Hugo"], zip_code: "69002", city: "Lyon", country_code: "FR", contact: julien },
  }, "fr");
  assert.equal(s.title, "Modifier la commande");
  assert.match(s.description, /SFS-004/);
  assert.deepEqual(s.sections, [
    { label: "Client", lines: ["M. Julien Moreau", "alertes_os@onestock-retail.com", "+33 6 45 12 98 23"] },
    { label: "Adresse de livraison (envoi du colis)", lines: ["26 Rue Victor Hugo", "69002 Lyon", "France"] },
  ]);
  const shown = [s.title, s.description, ...s.sections.flatMap((x) => [x.label, ...x.lines])].join("\n");
  assert.doesNotMatch(shown, /first_name|zip_code|country_code|[{}]/);
});

test("shipping and billing addresses are labelled separately; contacts only when they differ", () => {
  const s = summarizeAction("update_order", {
    order_id: "A",
    shipping_address: { lines: ["1 rue"], zip_code: "1", city: "X", country_code: "BE", contact: { first_name: "Anne" } },
    billing_address: { lines: ["2 rue"], zip_code: "2", city: "Y", country_code: "fr" },
  }, "en");
  assert.deepEqual(s.sections.map((x) => x.label), [
    "Shipping address (where the parcel goes)", "Parcel recipient", "Billing address (on the invoice)",
  ]);
  assert.equal(s.sections[0].lines.at(-1), "Belgium");
  assert.equal(s.sections[2].lines.at(-1), "France");
});

test("billing address alone does not mention the shipping address", () => {
  const s = summarizeAction("update_order", { order_id: "A", billing_address: { lines: ["2 rue"], zip_code: "2", city: "Y", country_code: "FR" } }, "fr");
  assert.deepEqual(s.sections.map((x) => x.label), ["Adresse de facturation (sur la facture)"]);
});

test("cancellations and item changes are plain sentences, item numbers start at 1", () => {
  assert.equal(summarizeAction("cancel_order", { order_id: "SFS-004" }, "fr").danger, true);
  const s = summarizeAction("update_line_item_groups_state", { order_id: "A", index_ranges: [{ from: 0, to: 1 }, { from: 3, to: 3 }], from: "pending", to: "removed" }, "fr");
  assert.equal(s.description, "Les articles n° 1, 2 et 4 de la commande A passeront du statut « pending » au statut « annulé ».");
});
