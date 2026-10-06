import { requireSession } from "../../utils/session";
import { onestockFetch, encodeId } from "../../utils/onestock";
import { extractDocument } from "../../utils/documents";

/**
 * Affiche un document OneStock (étiquette, bon de retour…) dans le navigateur. Les liens sont produits par
 * l'outil get_order_parcels : /api/documents/{id}?site_id=…
 */
export default defineEventHandler(async (event) => {
  const session = requireSession(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing_document_id" });

  const res = await onestockFetch(session.siteId, "GET", `/v3/documents/${encodeId(id)}`, {}, "*/*");
  if (!res.ok) throw createError({ statusCode: res.status === 404 ? 404 : 502, statusMessage: `OneStock HTTP ${res.status}` });

  const file = extractDocument(new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type") ?? "");
  if (!file) throw createError({ statusCode: 422, statusMessage: "document_not_readable" });

  setResponseHeaders(event, {
    "Content-Type": file.contentType,
    "Content-Disposition": `inline; filename="document-${id.replace(/[^\w.-]/g, "_")}"`,
    "Cache-Control": "private, no-store",
  });
  return file.body;
});
