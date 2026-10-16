import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptSetting } from "../server/utils/encrypt.ts";
import { decryptSetting } from "../server/lib/settings-secrets.mjs";

test("values encrypted by the Settings tab are readable by the Extensions module", () => {
  for (const key of ["a".repeat(64), Buffer.alloc(32, 7).toString("base64"), "une phrase secrète"]) {
    const enc = encryptSetting("token-123", key);
    assert.match(enc, /^enc:v1:/);
    assert.equal(decryptSetting(enc, key), "token-123");
  }
});
