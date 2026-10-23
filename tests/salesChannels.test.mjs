import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSalesChannels, salesChannelFor } from "../server/utils/settings.ts";

test("JSON and list formats, country codes upper-cased, * for other countries", () => {
  assert.deepEqual(parseSalesChannels('{"fr": "sc_fr", "BE": "sc_be", "*": "sc_web"}'), { FR: "sc_fr", BE: "sc_be", "*": "sc_web" });
  assert.deepEqual(parseSalesChannels("FR:sc_fr, be = sc_be\n*:sc_web"), { FR: "sc_fr", BE: "sc_be", "*": "sc_web" });
  assert.deepEqual(parseSalesChannels("{not json"), {});
  assert.deepEqual(parseSalesChannels('{"France": "x", "DE": ""}'), {});
  assert.deepEqual(parseSalesChannels(undefined), {});
});

test("channel for a delivery country, then *, then none (site default)", () => {
  const map = { FR: "sc_fr", "*": "sc_web" };
  assert.equal(salesChannelFor(map, "fr"), "sc_fr");
  assert.equal(salesChannelFor(map, "ES"), "sc_web");
  assert.equal(salesChannelFor({ FR: "sc_fr" }, "ES"), undefined);
  assert.equal(salesChannelFor(map, undefined), "sc_web");
});
