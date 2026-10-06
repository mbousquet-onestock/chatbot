/** Fichier extrait d'une réponse de GET /documents/{id}. */
export interface DocumentFile {
  contentType: string;
  body: Uint8Array;
}

const DATA_URI = /data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)/;

function boundaryOf(contentType: string, body: Buffer): string | undefined {
  const fromHeader = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  // Sinon, première ligne du corps : --<boundary>
  const firstLine = body.subarray(0, 200).toString("latin1").split(/\r?\n/)[0]?.trim();
  return firstLine?.startsWith("--") ? firstLine.slice(2) : undefined;
}

/**
 * GET /documents/{id} renvoie un multipart : un aperçu (`<img src="data:…;base64,…">`), des métadonnées JSON
 * et, selon les documents, le fichier lui-même. On renvoie le fichier s'il est présent, sinon l'aperçu décodé.
 */
export function extractDocument(raw: Uint8Array, contentType: string): DocumentFile | undefined {
  const body = Buffer.from(raw);
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "application/pdf" || type.startsWith("image/")) return { contentType: type, body: raw };

  const boundary = boundaryOf(contentType, body);
  const parts: { headers: Record<string, string>; body: Buffer }[] = [];
  if (boundary) {
    const delimiter = Buffer.from(`--${boundary}`, "latin1");
    let start = body.indexOf(delimiter);
    while (start >= 0) {
      const next = body.indexOf(delimiter, start + delimiter.length);
      if (next < 0) break;
      const chunk = body.subarray(start + delimiter.length, next);
      const crlf = chunk.indexOf("\r\n\r\n");
      const lf = chunk.indexOf("\n\n");
      const sep = crlf >= 0 && (lf < 0 || crlf <= lf) ? { at: crlf, len: 4 } : { at: lf, len: 2 };
      if (sep.at >= 0) {
        const headers: Record<string, string> = {};
        for (const line of chunk.subarray(0, sep.at).toString("latin1").split(/\r?\n/)) {
          const i = line.indexOf(":");
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        let partBody = chunk.subarray(sep.at + sep.len);
        if (partBody.subarray(-2).toString("latin1") === "\r\n") partBody = partBody.subarray(0, -2);
        else if (partBody.subarray(-1).toString("latin1") === "\n") partBody = partBody.subarray(0, -1);
        parts.push({ headers, body: partBody });
      }
      start = next;
    }
  } else {
    parts.push({ headers: {}, body });
  }

  // 1. Le fichier lui-même (PDF ou image).
  for (const part of parts) {
    const partType = (part.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (partType === "application/pdf" || partType.startsWith("image/")) return { contentType: partType, body: part.body };
  }
  // 2. Une donnée encodée en base64 (aperçu `<img src="data:…">`).
  for (const part of parts) {
    const match = DATA_URI.exec(part.body.toString("latin1"));
    if (match) return { contentType: match[1]!.toLowerCase(), body: Buffer.from(match[2]!.replace(/\s/g, ""), "base64") };
  }
  return undefined;
}
