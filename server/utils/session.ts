import { createHash } from "node:crypto";
import type { H3Event } from "h3";
import { SignJWT, jwtVerify } from "jose";

/** Session issue de la vérification de signature : identité OneStock de l'utilisateur et site. */
export interface ChatSession {
  userId: string;
  extensionId: string;
  siteId: string;
}

const SESSION_TTL = "1h";

function jwtKey(): Uint8Array {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return new TextEncoder().encode(secret);
  // À défaut, dérivé du secret de l'extension (connu du seul serveur) pour ne pas multiplier les variables.
  const fallback = process.env.EXTENSION_SECRET_KEYS?.split(",")[0]?.trim();
  if (!fallback) throw new Error("JWT_SECRET (or EXTENSION_SECRET_KEYS) is not set");
  return createHash("sha256").update(`chatbot-jwt:${fallback}`).digest();
}

export async function issueSession(session: ChatSession): Promise<string> {
  return new SignJWT({ ext: session.extensionId, site: session.siteId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.userId)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(jwtKey());
}

/** Lit et vérifie le JWT `Authorization: Bearer …`, ou répond 401. */
export async function requireSession(event: H3Event): Promise<ChatSession> {
  const auth = getHeader(event, "authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw createError({ statusCode: 401, statusMessage: "Missing session token" });
  try {
    const { payload } = await jwtVerify(token, jwtKey(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.site !== "string" || typeof payload.ext !== "string") {
      throw new Error("malformed");
    }
    return { userId: payload.sub, siteId: payload.site, extensionId: payload.ext };
  } catch {
    throw createError({ statusCode: 401, statusMessage: "Invalid or expired session" });
  }
}
