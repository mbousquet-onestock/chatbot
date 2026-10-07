import { requireSession } from "../../utils/session";
import { encodeId, onestockRequest } from "../../utils/onestock";
import { addOrderComment, byUser } from "../../utils/comments";

/**
 * Ouvre la facture d'une commande (URL de information.invoice) après avoir tracé sa consultation dans les
 * commentaires de la commande. Les liens sont produits par les outils get_order et get_order_parcels.
 */
export default defineEventHandler(async (event) => {
  const session = requireSession(event);
  const orderId = getRouterParam(event, "orderId");
  if (!orderId) throw createError({ statusCode: 400, statusMessage: "missing_order_id" });

  const res = await onestockRequest(session.siteId, "GET", `/v3/orders/${encodeId(orderId)}`, { fields: ["id", "information"] });
  if (!res.ok) throw createError({ statusCode: res.status === 404 ? 404 : 502, statusMessage: `OneStock HTTP ${res.status}` });
  const order = (res.data as { order?: unknown })?.order ?? res.data;
  const invoice = (order as { information?: { invoice?: unknown } })?.information?.invoice;
  if (typeof invoice !== "string" || !/^https?:\/\//i.test(invoice)) {
    throw createError({ statusCode: 404, statusMessage: "no_invoice" });
  }

  const userId = getQuery(event).user_id;
  await addOrderComment(session.siteId, orderId, `facture consultée ${byUser(typeof userId === "string" ? userId : session.userId)}.`);
  return sendRedirect(event, invoice, 302);
});
