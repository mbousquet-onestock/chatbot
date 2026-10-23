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

test("rows of the context extension are used; environment given as host or origin of the parent_url", async () => {
  const { selectRows } = await import("../server/utils/settings.ts");
  delete process.env.ONESTOCK_ENVIRONMENT;
  const rows = [
    row("sales_channels_by_country", "p0039", "6adb7ad4f3aef36cd2aa88e3", "qualif", "old"),
    row("sales_channels_by_country", "p0039", "6adb7ad4f3aef36cd2aa88e3", "admin.eu1.qualif.onestock-retail.com", "eu1"),
    row("default_lang", "", "*", "*", "en"),
    row("onestock_stock_request_name", "", "other_ext", "admin.eu1.qualif.onestock-retail.com", "x"),
  ];
  const { used, environment, environmentSource, status } = selectRows(rows, "p0039", "https://admin.eu1.qualif.onestock-retail.com", "6adb7ad4f3aef36cd2aa88e3");
  assert.equal(environment, "https://admin.eu1.qualif.onestock-retail.com");
  assert.equal(environmentSource, "parent_url");
  assert.equal(used.get("sales_channels_by_country").value, "eu1");
  assert.equal(used.get("default_lang").value, "en");
  assert.equal(status(rows[0]), "other_environment");
  assert.equal(status(rows[3]), "other_extension");
  // Sans extension du contexte, les lignes propres à l'extension sont écartées.
  assert.equal(selectRows(rows, "p0039", "https://admin.eu1.qualif.onestock-retail.com").used.get("sales_channels_by_country"), undefined);
});
