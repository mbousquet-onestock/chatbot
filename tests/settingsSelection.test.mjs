import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRows } from "../server/utils/settings.ts";

const row = (key, site_id, extension_id, environment, value = "v") => ({ key, value, site_id, extension_id, environment, encrypted: false });

test("without ONESTOCK_ENVIRONMENT, the environment that has both an API URL and a token wins", () => {
  delete process.env.ONESTOCK_ENVIRONMENT;
  const rows = [
    row("onestock_api_root", "o0057", "*", "prod", "https://api.onestock-retail.com"),
    row("onestock_api_root", "", "*", "qualif", "https://api-qualif.onestock-retail.com"),
    row("onestock_token", "", "*", "qualif", "tok"),
    row("onestock_token", "o0057", "exchange", "qualif", "other"),
  ];
  const { used, environment, environmentSource } = selectRows(rows, "o0057");
  assert.equal(environment, "qualif");
  assert.equal(environmentSource, "api_root");
  assert.equal(used.get("onestock_token").value, "tok");
  assert.equal(used.get("onestock_api_root").value, "https://api-qualif.onestock-retail.com");
});

test("ONESTOCK_ENVIRONMENT wins and is compared case-insensitively", () => {
  process.env.ONESTOCK_ENVIRONMENT = "Qualif";
  const rows = [row("onestock_api_root", "", "*", "qualif"), row("onestock_token", "", "*", "qualif", "tok"), row("onestock_token", "", "*", "prod", "p")];
  const { used, environmentSource, status } = selectRows(rows, "c42");
  assert.equal(used.get("onestock_token").value, "tok");
  assert.equal(environmentSource, "variable");
  assert.equal(status(rows[2]), "other_environment");
  delete process.env.ONESTOCK_ENVIRONMENT;
});
