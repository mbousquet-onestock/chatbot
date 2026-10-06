import type { H3Event } from "h3";

/** Contexte OneStock de la requête : site, utilisateur et extension transmis par le front. */
export interface ChatSession {
  userId: string;
  extensionId: string;
  siteId: string;
}

function csv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Lit le contexte envoyé par le front (en-têtes X-Onestock-*), issu des paramètres d'URL et du handshake
 * OneStock. Il n'est pas authentifié : ALLOWED_SITE_IDS limite les sites utilisables.
 */
export function requireSession(event: H3Event): ChatSession {
  // En-tête pour les appels du front ; paramètre `site_id` pour les liens ouverts dans un onglet (documents).
  const fromQuery = getQuery(event).site_id;
  const siteId = (getHeader(event, "x-onestock-site-id") ?? (typeof fromQuery === "string" ? fromQuery : ""))?.trim();
  if (!siteId) throw createError({ statusCode: 400, statusMessage: "missing_site_id" });

  const allowedSites = csv("ALLOWED_SITE_IDS");
  if (allowedSites.length && !allowedSites.includes(siteId)) {
    throw createError({ statusCode: 403, statusMessage: "site_not_allowed" });
  }
  const extensionId = getHeader(event, "x-onestock-extension-id")?.trim() ?? "";
  const expectedExtension = process.env.EXTENSION_ID?.trim();
  if (expectedExtension && extensionId !== expectedExtension) {
    throw createError({ statusCode: 403, statusMessage: "unknown_extension" });
  }
  return { siteId, extensionId, userId: getHeader(event, "x-onestock-user-id")?.trim() ?? "" };
}
