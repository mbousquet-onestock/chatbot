/**
 * Contexte OneStock : paramètres d'URL, complétés par le handshake postMessage (extension_ready → onestock_data)
 * quand l'extension est affichée dans le back-office. Le site et l'utilisateur sont transmis au serveur tels quels.
 */
export interface OnestockContext {
  extension_id?: string;
  user_id?: string;
  site_id?: string;
  lang?: string;
  timezone?: string;
  locale?: string;
  parent_url?: string;
  injection_point_path?: string;
  host_app?: string;
  /** Anchor bo.order.action */
  order_id?: string;
  /** Anchor bo.orders.action */
  order_ids?: string[];
}

type Status = "loading" | "ready" | "error";

const HANDSHAKE_TIMEOUT_MS = 10_000;

const state = reactive({
  status: "loading" as Status,
  error: "" as string,
  context: {} as OnestockContext,
  embedded: false,
});

let started = false;
let parentOrigin = "*";

function readUrlParams(): OnestockContext {
  const q = new URLSearchParams(window.location.search);
  const get = (k: string) => q.get(k) ?? undefined;
  return {
    extension_id: get("extension_id"),
    user_id: get("user_id"),
    site_id: get("site_id"),
    lang: get("lang"),
    timezone: get("timezone"),
    locale: get("locale"),
    parent_url: get("parent_url"),
    injection_point_path: get("injection_point_path"),
    host_app: get("host_app"),
    order_id: get("order_id"),
    order_ids: get("order_ids")?.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function postToParent(message: Record<string, unknown>) {
  if (state.embedded) window.parent.postMessage(message, parentOrigin);
}

/** Attend le message onestock_data du back-office, en n'acceptant que l'origine de parent_url. */
function waitForOnestockData(): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("handshake_timeout"));
    }, HANDSHAKE_TIMEOUT_MS);
    function onMessage(event: MessageEvent) {
      if (parentOrigin !== "*" && event.origin !== parentOrigin) return;
      if (!event.data || typeof event.data !== "object" || event.data.type !== "onestock_data") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve((event.data.data ?? {}) as Record<string, any>);
    }
    window.addEventListener("message", onMessage);
    postToParent({ type: "extension_ready" });
  });
}

async function start() {
  state.embedded = window.parent !== window;
  const fromUrl = readUrlParams();
  if (fromUrl.parent_url) {
    try {
      parentOrigin = new URL(fromUrl.parent_url).origin;
    } catch {
      parentOrigin = "*";
    }
  }
  state.context = fromUrl;

  if (state.embedded) {
    // Sans réponse du back-office, on continue avec les paramètres d'URL.
    const data = await waitForOnestockData().catch(() => undefined);
    if (data) {
      const orderIds = typeof data.order_ids === "string"
        ? data.order_ids.split(",").map((s: string) => s.trim()).filter(Boolean)
        : Array.isArray(data.order_ids) ? data.order_ids.map(String) : undefined;
      state.context = {
        ...fromUrl,
        site_id: fromUrl.site_id ?? data.site_id,
        user_id: fromUrl.user_id ?? (data.user_id != null ? String(data.user_id) : undefined),
        host_app: data.host_app ?? fromUrl.host_app,
        injection_point_path: data.injection_point_path ?? fromUrl.injection_point_path,
        order_id: data.order_id ?? fromUrl.order_id,
        order_ids: orderIds ?? fromUrl.order_ids,
      };
    }
  }
  if (state.context.site_id) {
    state.status = "ready";
  } else {
    state.status = "error";
    state.error = "missing_site_id";
  }
}

/** Appel à l'API de l'extension avec le contexte OneStock en en-têtes. */
function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const c = state.context;
  return fetch(path, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      "X-Onestock-Site-Id": c.site_id ?? "",
      "X-Onestock-User-Id": c.user_id ?? "",
      "X-Onestock-Extension-Id": c.extension_id ?? "",
    },
  });
}

export function useOnestockContext() {
  if (import.meta.client && !started) {
    started = true;
    start();
  }
  return {
    state: readonly(state),
    apiFetch,
    /** Ajuste la hauteur de l'iframe (back-office uniquement). */
    resize: (height: number) => postToParent({ type: "extension_resize", height: Math.ceil(height) }),
    /** Ferme la modale des anchors d'action (bo.order.action, bo.orders.action). */
    close: () => postToParent({ type: "extension_close" }),
  };
}
