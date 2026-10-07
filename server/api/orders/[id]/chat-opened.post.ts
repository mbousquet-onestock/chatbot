import { requireSession } from "../../../utils/session";
import { addOrderComment, byUser } from "../../../utils/comments";

/** Trace dans les commentaires de la commande l'ouverture du chat sur celle-ci (anchor bo.order.action). */
export default defineEventHandler(async (event) => {
  const session = requireSession(event);
  const orderId = getRouterParam(event, "id");
  if (!orderId) throw createError({ statusCode: 400, statusMessage: "missing_order_id" });
  const ok = await addOrderComment(session.siteId, orderId, `chat ouvert sur la commande ${byUser(session.userId)}.`);
  return { ok };
});
