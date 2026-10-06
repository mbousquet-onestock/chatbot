import { getOnestockSettings } from "./settings";

export type HttpMethod = "GET" | "PATCH" | "POST";

export interface OnestockResult {
  ok: boolean;
  status: number;
  data: unknown;
}

const TIMEOUT_MS = 25_000;

/**
 * Appel à l'API OneStock pour un site. Le `site_id` et le `token` sont ajoutés à la racine du corps.
 * Les GET OneStock prennent un corps JSON : ils partent en POST avec `X-HTTP-Method-Override: GET`
 * (fetch ne permet pas de corps sur un GET), comme le prévoit la documentation de l'API.
 */
export async function onestockRequest(
  siteId: string,
  method: HttpMethod,
  path: string,
  body: Record<string, unknown> = {},
): Promise<OnestockResult> {
  const { token, apiRoot } = await getOnestockSettings(siteId);
  const isGet = method === "GET";
  const res = await fetch(`${apiRoot}${path}`, {
    method: isGet ? "POST" : method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(isGet ? { "X-HTTP-Method-Override": "GET" } : {}),
    },
    body: JSON.stringify({ ...body, site_id: siteId, token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // corps non JSON : renvoyé tel quel
  }
  return { ok: res.ok, status: res.status, data };
}

export const encodeId = (id: string) => encodeURIComponent(id);
