import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { verifyExtensionSignature } from "../server/utils/signature.ts";
import { decryptSetting } from "../server/lib/settings-secrets.mjs";
import { toOnestockDate } from "../server/utils/dates.ts";

const sign = (key, t, ext, user) => createHmac("sha256", key).update(`${t}.${ext}##${user}`).digest("hex");
const now = 1_760_000_000;
const input = (sig) => ({ extension_signature: sig, extension_id: "ext1", user_id: "u7" });

test("accepts a signature made with any known key (h0/h1/h2)", () => {
  const sig = `t=${now},h0=${sign("latest", now, "ext1", "u7")},h1=${sign("previous", now, "ext1", "u7")}`;
  assert.equal(verifyExtensionSignature(input(sig), ["previous"], now), true);
  assert.equal(verifyExtensionSignature(input(sig), ["latest"], now), true);
});

test("rejects wrong key, other user, missing fields and old signatures", () => {
  const sig = `t=${now},h0=${sign("latest", now, "ext1", "u7")}`;
  assert.equal(verifyExtensionSignature(input(sig), ["other"], now), false);
  assert.equal(verifyExtensionSignature({ ...input(sig), user_id: "u8" }, ["latest"], now), false);
  assert.equal(verifyExtensionSignature(input(undefined), ["latest"], now), false);
  assert.equal(verifyExtensionSignature(input(sig), ["latest"], now + 6 * 3600 + 1), false);
  assert.equal(verifyExtensionSignature(input(`t=abc,h0=${sign("latest", now, "ext1", "u7")}`), ["latest"], now), false);
});

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

test("reports why a signature is rejected and accepts millisecond timestamps", async () => {
  const { checkExtensionSignature } = await import("../server/utils/signature.ts");
  const good = `t=${now},h0=${sign("k", now, "ext1", "u7")}`;
  assert.equal(checkExtensionSignature(input(good), [], now), "no_keys");
  assert.equal(checkExtensionSignature(input(undefined), ["k"], now), "missing_signature");
  assert.equal(checkExtensionSignature(input("h0=abc"), ["k"], now), "malformed");
  assert.equal(checkExtensionSignature(input(good), ["k"], now + 7 * 3600), "expired");
  assert.equal(checkExtensionSignature(input(good), ["other"], now), "mismatch");
  const ms = now * 1000;
  assert.equal(checkExtensionSignature(input(`t=${ms},h0=${sign("k", ms, "ext1", "u7")}`), ["k"], now), "ok");
});
