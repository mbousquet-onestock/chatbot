import { extensionSecretKeys, verifyExtensionSignature } from "../utils/signature";
import { issueSession } from "../utils/session";

interface SessionBody {
  extension_signature?: string;
  extension_id?: string;
  user_id?: string;
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
    throw createError({ statusCode: 403, statusMessage: "Site not allowed" });
  }
  const expectedExtension = process.env.EXTENSION_ID?.trim();
  if (expectedExtension && extensionId !== expectedExtension) {
    throw createError({ statusCode: 403, statusMessage: "Unknown extension" });
  }

  const devSession = body.dev === true && process.env.ALLOW_DEV_SESSION === "true";
  if (!devSession && !verifyExtensionSignature(body, extensionSecretKeys())) {
    throw createError({ statusCode: 403, statusMessage: "Invalid extension signature" });
  }

  const token = await issueSession({ userId, extensionId, siteId });
  return { verified: true, token };
});
