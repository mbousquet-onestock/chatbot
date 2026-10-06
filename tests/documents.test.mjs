import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDocument } from "../server/utils/documents.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const enc = (s) => new Uint8Array(Buffer.from(s, "latin1"));

test("extracts the preview image of a multipart document (format from the API docs)", () => {
  const raw = `--191cde\n  Content-Disposition: form-data; name="preview"\n\n<img src="data:image/png;base64,${png.toString("base64")}"></img>\n\n--191cde\nContent-Type: application/json\n\n{"comment":"","date":1654967931}\n--191cde--`;
  const file = extractDocument(enc(raw), "text/plain");
  assert.equal(file?.contentType, "image/png");
  assert.deepEqual(Buffer.from(file.body), png);
});

test("prefers a binary file part and uses the boundary from the header", () => {
  const pdf = "%PDF-1.4 fake";
  const raw = `--b\r\nContent-Type: application/json\r\n\r\n{}\r\n--b\r\nContent-Type: application/pdf\r\n\r\n${pdf}\r\n--b--\r\n`;
  const file = extractDocument(enc(raw), 'multipart/form-data; boundary="b"');
  assert.equal(file?.contentType, "application/pdf");
  assert.equal(Buffer.from(file.body).toString("latin1"), pdf);
});

test("passes PDFs and images through and returns nothing for unreadable content", () => {
  assert.equal(extractDocument(enc("%PDF"), "application/pdf")?.contentType, "application/pdf");
  assert.equal(extractDocument(enc("{}"), "application/json"), undefined);
});
