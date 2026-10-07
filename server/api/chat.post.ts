import OpenAI from "openai";
import { requireSession } from "../utils/session";
import { SYSTEM_PROMPT, contextPrompt, type UiContext } from "../utils/prompt";
import { TOOL_DEFINITIONS, isWriteTool, runTool, type ToolNotice } from "../utils/tools";

type MessageParam = OpenAI.Chat.ChatCompletionMessageParam;
type ToolCall = OpenAI.Chat.ChatCompletionMessageFunctionToolCall;

interface ChatBody {
  /** Historique (hors messages système) renvoyé tel quel par le client. */
  messages?: MessageParam[];
  /** Nouveau message de l'utilisateur. */
  input?: string;
  /** Réponse aux actions d'écriture en attente : id de l'appel d'outil → approuvée ou non. */
  decisions?: Record<string, boolean>;
  context?: UiContext;
}

/** Événements NDJSON envoyés au client. */
type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown; status: "running" | "done" | "error" | "declined" }
  | { type: "notice"; notice: ToolNotice }
  | { type: "confirm"; actions: { id: string; name: string; input: unknown }[] }
  | { type: "done"; messages: MessageParam[]; stop_reason: string | null }
  | { type: "error"; message: string };

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const MAX_ITERATIONS = 12;
const MAX_BODY_CHARS = 4_000_000;

let openai: OpenAI | undefined;

/** Arguments d'un appel d'outil (JSON produit par le modèle). */
function parseArguments(call: ToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.function.arguments || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Appels d'outils (de type fonction) d'un message assistant. */
function functionCalls(message: MessageParam | undefined): ToolCall[] {
  if (message?.role !== "assistant" || !message.tool_calls) return [];
  return message.tool_calls.filter((c): c is ToolCall => c.type === "function");
}

export default defineEventHandler(async (event) => {
  const session = requireSession(event);
  const raw = await readRawBody(event, "utf8");
  if (!raw || raw.length > MAX_BODY_CHARS) throw createError({ statusCode: 413, statusMessage: "Conversation too large" });
  const body = JSON.parse(raw) as ChatBody;

  // Les messages système sont toujours fournis par le serveur, jamais par le client.
  const messages: MessageParam[] = (Array.isArray(body.messages) ? body.messages : []).filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "tool",
  );
  const input = body.input?.trim();
  if (!input && !body.decisions) throw createError({ statusCode: 400, statusMessage: "input or decisions required" });

  openai ??= new OpenAI();
  const client = openai;
  const system: MessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: contextPrompt(body.context ?? {}, session.siteId) },
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

      /** Exécute les appels d'outils d'un tour assistant et ajoute un message `tool` par appel. */
      const executeTools = async (calls: ToolCall[], decisions: Record<string, boolean> = {}) => {
        const results = await Promise.all(
          calls.map(async (call): Promise<MessageParam> => {
            const name = call.function.name;
            const args = parseArguments(call);
            if (isWriteTool(name) && decisions[call.id] !== true) {
              send({ type: "tool", id: call.id, name, input: args, status: "declined" });
              return { role: "tool", tool_call_id: call.id, content: "L'utilisateur a refusé cette action : elle n'a pas été exécutée." };
            }
            send({ type: "tool", id: call.id, name, input: args, status: "running" });
            const res = await runTool(session.siteId, name, args);
            send({ type: "tool", id: call.id, name, input: args, status: res.isError ? "error" : "done" });
            if (res.notice) send({ type: "notice", notice: res.notice });
            return { role: "tool", tool_call_id: call.id, content: res.content };
          }),
        );
        messages.push(...results);
      };

      try {
        if (body.decisions) {
          // Reprise après confirmation : le dernier message assistant contient les appels en attente.
          const pending = functionCalls(messages.at(-1));
          if (!pending.length) throw new Error("No pending action to confirm");
          await executeTools(pending, body.decisions);
        } else {
          messages.push({ role: "user", content: input! });
        }

        let stopReason: string | null = null;
        let sentText = false;
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          const stream = client.chat.completions.stream({
            model: MODEL,
            messages: [...system, ...messages],
            tools: TOOL_DEFINITIONS,
          });
          let first = true;
          stream.on("content", (delta) => {
            // Le texte de plusieurs tours (avant/après les outils) s'affiche dans la même bulle : on sépare les paragraphes.
            if (first && sentText) delta = `\n\n${delta}`;
            first = false;
            sentText = true;
            send({ type: "text", delta });
          });
          const completion = await stream.finalChatCompletion();
          const choice = completion.choices[0];
          stopReason = choice?.finish_reason ?? null;
          if (!choice) break;

          const message = choice.message;
          const calls = (message.tool_calls ?? []).filter((c): c is ToolCall => c.type === "function");
          messages.push({
            role: "assistant",
            content: message.content ?? null,
            ...(calls.length ? { tool_calls: calls.map(({ id, type, function: fn }) => ({ id, type, function: fn })) } : {}),
          });
          if (message.refusal) {
            send({ type: "error", message: message.refusal });
            break;
          }
          if (!calls.length) break;

          const writes = calls.filter((c) => isWriteTool(c.function.name));
          if (writes.length) {
            // Rien n'est exécuté avant la décision de l'utilisateur ; les lectures du même tour seront faites ensuite.
            send({
              type: "confirm",
              actions: writes.map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c) })),
            });
            break;
          }
          await executeTools(calls);
        }
        send({ type: "done", messages, stop_reason: stopReason });
      } catch (err) {
        console.error("[chat]", err);
        const message = err instanceof OpenAI.APIError
          ? `Erreur du service d'IA (${err.status ?? "réseau"}).`
          : err instanceof Error ? err.message : String(err);
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });
});
