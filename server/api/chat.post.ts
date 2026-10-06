import Anthropic from "@anthropic-ai/sdk";
import { requireSession } from "../utils/session";
import { SYSTEM_PROMPT, contextPrompt, type UiContext } from "../utils/prompt";
import { TOOL_DEFINITIONS, isWriteTool, runTool } from "../utils/tools";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;

interface ChatBody {
  /** Historique complet renvoyé tel quel par le client (blocs de réflexion compris). */
  messages?: MessageParam[];
  /** Nouveau message de l'utilisateur. */
  input?: string;
  /** Réponse aux actions d'écriture en attente : id du tool_use → approuvée ou non. */
  decisions?: Record<string, boolean>;
  context?: UiContext;
}

/** Événements NDJSON envoyés au client. */
type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown; status: "running" | "done" | "error" | "declined" }
  | { type: "confirm"; actions: { id: string; name: string; input: unknown }[] }
  | { type: "done"; messages: MessageParam[]; stop_reason: string | null }
  | { type: "error"; message: string };

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const MAX_ITERATIONS = 12;
const MAX_BODY_CHARS = 4_000_000;

let anthropic: Anthropic | undefined;

export default defineEventHandler(async (event) => {
  const session = requireSession(event);
  const raw = await readRawBody(event, "utf8");
  if (!raw || raw.length > MAX_BODY_CHARS) throw createError({ statusCode: 413, statusMessage: "Conversation too large" });
  const body = JSON.parse(raw) as ChatBody;

  const messages: MessageParam[] = Array.isArray(body.messages) ? [...body.messages] : [];
  const input = body.input?.trim();
  if (!input && !body.decisions) throw createError({ statusCode: 400, statusMessage: "input or decisions required" });

  anthropic ??= new Anthropic();
  const client = anthropic;
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT },
    { type: "text", text: contextPrompt(body.context ?? {}, session.siteId) },
  ];

  setResponseHeaders(event, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });

  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (e: ChatEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));

      /** Exécute les outils d'un tour assistant et ajoute leurs résultats (dans un seul message utilisateur). */
      const executeTools = async (toolUses: ToolUse[], decisions: Record<string, boolean> = {}) => {
        const results = await Promise.all(
          toolUses.map(async (tu): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            if (isWriteTool(tu.name) && decisions[tu.id] !== true) {
              send({ type: "tool", id: tu.id, name: tu.name, input: tu.input, status: "declined" });
              return { type: "tool_result", tool_use_id: tu.id, content: "L'utilisateur a refusé cette action : elle n'a pas été exécutée." };
            }
            send({ type: "tool", id: tu.id, name: tu.name, input: tu.input, status: "running" });
            const res = await runTool(session.siteId, tu.name, tu.input);
            send({ type: "tool", id: tu.id, name: tu.name, input: tu.input, status: res.isError ? "error" : "done" });
            return { type: "tool_result", tool_use_id: tu.id, content: res.content, is_error: res.isError };
          }),
        );
        messages.push({ role: "user", content: results });
      };

      try {
        if (body.decisions) {
          // Reprise après confirmation : le dernier tour assistant contient les tool_use en attente.
          const last = messages.at(-1);
          const pending = last?.role === "assistant" && Array.isArray(last.content)
            ? (last.content.filter((b) => b.type === "tool_use") as ToolUse[])
            : [];
          if (!pending.length) throw new Error("No pending action to confirm");
          await executeTools(pending, body.decisions);
        } else {
          messages.push({ role: "user", content: input! });
        }

        let stopReason: string | null = null;
        let sentText = false;
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          const stream = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 16000,
            system,
            tools: TOOL_DEFINITIONS,
            messages,
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            cache_control: { type: "ephemeral" },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          });
          let first = true;
          stream.on("text", (delta) => {
            // Le texte de plusieurs tours (avant/après les outils) s'affiche dans la même bulle : on sépare les paragraphes.
            if (first && sentText) delta = `\n\n${delta}`;
            first = false;
            sentText = true;
            send({ type: "text", delta });
          });
          const message = await stream.finalMessage();
          stopReason = message.stop_reason;

          if (message.stop_reason === "refusal") {
            send({ type: "error", message: "La demande a été refusée par le modèle." });
            break;
          }
          messages.push({ role: "assistant", content: message.content as MessageParam["content"] });
          if (message.stop_reason === "pause_turn") continue;
          if (message.stop_reason !== "tool_use") break;

          const toolUses = message.content.filter((b): b is ToolUse => b.type === "tool_use");
          const writes = toolUses.filter((tu) => isWriteTool(tu.name));
          if (writes.length) {
            // Rien n'est exécuté avant la décision de l'utilisateur ; les lectures du même tour seront faites ensuite.
            send({ type: "confirm", actions: writes.map((tu) => ({ id: tu.id, name: tu.name, input: tu.input })) });
            break;
          }
          await executeTools(toolUses);
        }
        send({ type: "done", messages, stop_reason: stopReason });
      } catch (err) {
        console.error("[chat]", err);
        const message = err instanceof Anthropic.APIError
          ? `Erreur du service d'IA (${err.status ?? "réseau"}).`
          : err instanceof Error ? err.message : String(err);
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });
});
