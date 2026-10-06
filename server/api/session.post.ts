import { checkExtensionSignature, extensionSecretKeys, type SignatureCheck } from "../utils/signature";
import { issueSession } from "../utils/session";

interface SessionBody {
  extension_signature?: string;
  extension_id?: string;
  user_id?: string;
  /** user_id du payload onestock_data, s'il diffère de celui de l'URL. */
  handshake_user_id?: string;
  site_id?: string;
  /** Session locale sans OneStock (développement uniquement, voir ALLOW_DEV_SESSION). */
  dev?: boolean;
}

function csv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Vérifie la signature d'extension OneStock et ouvre une session JWT de courte durée. */
export default defineEventHandler(async (event) => {
  const body = await readBody<SessionBody>(event);
  const siteId = body?.site_id?.trim();
  const userId = body?.user_id?.trim();
  const extensionId = body?.extension_id?.trim();
  if (!siteId || !userId || !extensionId) {
    throw createError({ statusCode: 400, statusMessage: "site_id, user_id and extension_id are required" });
  }

  const allowedSites = csv("ALLOWED_SITE_IDS");
  if (allowedSites.length && !allowedSites.includes(siteId)) {
    throw createError({ statusCode: 403, statusMessage: "site_not_allowed" });
  }
  const expectedExtension = process.env.EXTENSION_ID?.trim();
  if (expectedExtension && extensionId !== expectedExtension) {
    throw createError({ statusCode: 403, statusMessage: "unknown_extension" });
  }

  let sessionUserId = userId;
  if (body.dev === true) {
    if (process.env.ALLOW_DEV_SESSION !== "true") {
      throw createError({ statusCode: 403, statusMessage: "dev_session_disabled" });
    }
  } else {
    // La signature couvre extension_id##user_id : on essaie l'user_id de l'URL puis celui du handshake.
    const keys = extensionSecretKeys();
    const candidates = [...new Set([userId, body.handshake_user_id?.trim()].filter((u): u is string => !!u))];
    let result: SignatureCheck = "mismatch";
    for (const candidate of candidates) {
      result = checkExtensionSignature({ ...body, extension_id: extensionId, user_id: candidate }, keys);
      if (result === "ok") {
        sessionUserId = candidate;
        break;
      }
      if (result !== "mismatch") break;
    }
    if (result !== "ok") {
      const t = /(?:^|,)t=(\d+)/.exec(body.extension_signature ?? "")?.[1];
      console.warn("[session] signature check failed", {
        reason: result,
        site_id: siteId,
        extension_id: extensionId,
        user_ids: candidates,
        keys: keys.length,
        signature_age_s: t ? Math.floor(Date.now() / 1000) - (t.length > 11 ? Math.floor(Number(t) / 1000) : Number(t)) : null,
      });
      throw createError({ statusCode: 403, statusMessage: `signature_${result}` });
    }
  }

  const token = await issueSession({ userId: sessionUserId, extensionId, siteId });
  return { verified: true, token };
});
