import { encodeId, onestockRequest } from "./onestock";

/** Préfixe des commentaires écrits par l'extension, pour les distinguer dans le back-office. */
const PREFIX = "Assistant commandes";

/**
 * Ajoute un commentaire à une commande (POST /v2/orders/{id}/comments, `{ comment }`, même format que la
 * lecture des commentaires). Ne lève jamais : un échec est journalisé et renvoyé à false, pour ne pas bloquer
 * l'action de l'utilisateur.
 */
export async function addOrderComment(siteId: string, orderId: string, text: string): Promise<boolean> {
  try {
    const res = await onestockRequest(siteId, "POST", `/v2/orders/${encodeId(orderId)}/comments`, {
      comment: `${PREFIX} : ${text}`,
    });
    if (!res.ok) console.warn("[comments] OneStock refused the comment", { orderId, status: res.status, response: res.data });
    return res.ok;
  } catch (err) {
    console.warn("[comments] comment failed", { orderId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export const byUser = (userId: string) => (userId ? `par l'utilisateur ${userId}` : "par un utilisateur");
