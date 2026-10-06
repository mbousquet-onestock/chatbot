import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { decryptSetting } from "../server/lib/settings-secrets.mjs";
import { toOnestockDate } from "../server/utils/dates.ts";

test("decrypts enc:v1 settings and passes plain values through", () => {
  const key = randomBytes(32).toString("hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const ct = Buffer.concat([cipher.update("tok-123", "utf8"), cipher.final()]);
  const value = "enc:v1:" + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  assert.equal(decryptSetting(value, key), "tok-123");
  assert.equal(decryptSetting("plain", key), "plain");
});

test("formats dates for search_orders", () => {
  assert.equal(toOnestockDate("2026-10-06"), 20261006000000);
  assert.equal(toOnestockDate("2026-10-06", true), 20261006235959);
  assert.equal(toOnestockDate("2026-10-06T13:54:16Z"), 20261006135416);
  assert.equal(toOnestockDate("20190105135416"), 20190105135416);
  assert.throws(() => toOnestockDate("demain"));
});

