import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface ToolActivity {
  id: string;
  name: string;
  status: "running" | "done" | "error" | "declined";
}

export interface PendingAction {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatItem {
  role: "user" | "assistant";
  text: string;
  tools: ToolActivity[];
  error?: string;
}

/** Conversation avec /api/chat : l'historique brut (pour le modèle) est gardé à part de l'affichage. */
export function useChat() {
  const { state: os, refreshSession } = useOnestockContext();

  const history = ref<MessageParam[]>([]);
  const items = ref<ChatItem[]>([]);
  const pending = ref<PendingAction[]>([]);
  const busy = ref(false);

  function context() {
    const c = os.context;
    return {
      host_app: c.host_app,
      injection_point_path: c.injection_point_path,
      order_id: c.order_id,
      order_ids: c.order_ids,
      lang: c.lang,
      timezone: c.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: c.locale,
    };
  }

  async function post(payload: Record<string, unknown>, retried = false): Promise<Response> {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${os.token}` },
      body: JSON.stringify({ ...payload, messages: history.value, context: context() }),
    });
    if (res.status === 401 && !retried) {
      await refreshSession();
      return post(payload, true);
    }
    return res;
  }

  async function run(payload: Record<string, unknown>) {
    busy.value = true;
    const reply: ChatItem = reactive({ role: "assistant", text: "", tools: [] });
    items.value.push(reply);
    try {
      const res = await post(payload);
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.statusMessage ?? body?.message ?? `HTTP ${res.status}`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) handle(JSON.parse(line), reply);
        }
      }
    } catch (err) {
      reply.error = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  }

  function handle(event: any, reply: ChatItem) {
    switch (event.type) {
      case "text":
        reply.text += event.delta;
        break;
      case "tool": {
        const existing = reply.tools.find((t) => t.id === event.id);
        if (existing) existing.status = event.status;
        else reply.tools.push({ id: event.id, name: event.name, status: event.status });
        break;
      }
      case "confirm":
        pending.value = event.actions;
        break;
      case "done":
        history.value = event.messages;
        break;
      case "error":
        reply.error = event.message;
        break;
    }
  }

  async function send(input: string) {
    const text = input.trim();
    if (!text || busy.value || pending.value.length) return;
    items.value.push({ role: "user", text, tools: [] });
    await run({ input: text });
  }

  /** Réponse de l'utilisateur aux actions d'écriture proposées par l'assistant. */
  async function decide(approved: boolean) {
    if (busy.value || !pending.value.length) return;
    const actions = pending.value;
    const decisions = Object.fromEntries(actions.map((a) => [a.id, approved]));
    pending.value = [];
    await run({ decisions });
    // Échec avant exécution : l'historique attend toujours la décision, on la redemande.
    const last = history.value.at(-1);
    const stillPending = last?.role === "assistant" && Array.isArray(last.content)
      && last.content.some((b) => b.type === "tool_use" && b.id in decisions);
    if (stillPending && !pending.value.length) pending.value = actions;
  }

  function reset() {
    if (busy.value) return;
    history.value = [];
    items.value = [];
    pending.value = [];
  }

  return { items, pending, busy, send, decide, reset };
}
