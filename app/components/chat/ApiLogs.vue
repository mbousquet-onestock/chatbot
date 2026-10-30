<script setup lang="ts">
import type { ToolActivity } from "~/composables/useChat";

/** Journal technique d'un tour : pour chaque outil, ses paramètres, son résultat et les appels à l'API OneStock. */
const props = defineProps<{ tools: ToolActivity[]; lang?: string }>();
const t = computed(() => messagesFor(props.lang).apiLogs);
const logged = computed(() => props.tools.filter((tool) => tool.log));
const calls = computed(() => logged.value.reduce((n, tool) => n + (tool.log?.entries.filter((e) => e.method !== "INFO").length ?? 0), 0));

const pretty = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const statusClass = (s: number) => (s === 0 ? "neutral" : s >= 200 && s < 300 ? "ok" : "ko");
const short = (url: string) => url.replace(/^https?:\/\//, "");

const copied = ref(false);
async function copyAll() {
  const text = JSON.stringify(logged.value.map((tool) => ({ tool: tool.name, ...tool.log })), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // presse-papiers indisponible (iframe sans permission)
  }
}
</script>

<template>
  <details v-if="logged.length" class="logs">
    <summary class="os-body-s os-text-secondary">{{ t.title(calls) }}</summary>
    <div class="actions">
      <button type="button" class="copy os-body-s" @click="copyAll">{{ copied ? t.copied : t.copy }}</button>
    </div>
    <div v-for="tool in logged" :key="tool.id" class="tool">
      <details>
        <summary class="os-body-s">
          <span :class="['dot', tool.log!.tool.error ? 'ko' : 'ok']" />
          <strong>{{ tool.name }}</strong> — {{ t.toolCall }}
        </summary>
        <div class="io">
          <span class="label os-body-s">{{ t.input }}</span>
          <pre>{{ pretty(tool.log!.tool.input) }}</pre>
          <span class="label os-body-s">{{ t.output }}</span>
          <pre>{{ pretty(tool.log!.tool.output) }}</pre>
        </div>
      </details>
      <details v-for="(e, i) in tool.log!.entries" :key="i" class="call">
        <summary class="os-body-s">
          <template v-if="e.method === 'INFO'">
            <span class="dot neutral" /> {{ t.info }} : {{ e.note }}
          </template>
          <template v-else>
            <span :class="['dot', e.error ? 'ko' : statusClass(e.status)]" />
            <code>{{ e.method }}</code> {{ short(e.url) }} · <strong>{{ e.error ? t.networkError : e.status }}</strong> · {{ e.ms }} ms
          </template>
        </summary>
        <div class="io">
          <template v-if="e.method !== 'INFO'">
            <span class="label os-body-s">{{ t.request }}</span>
            <pre>{{ pretty(e.request) }}</pre>
          </template>
          <span class="label os-body-s">{{ e.method === "INFO" ? t.details : t.response }}</span>
          <pre>{{ e.error ?? pretty(e.response) }}</pre>
        </div>
      </details>
    </div>
  </details>
</template>

<style scoped>
.logs { border: 1px dashed var(--os-border-primary); border-radius: var(--os-radius-m); padding: var(--os-spacing-s) var(--os-spacing-m); }
.logs > summary { cursor: pointer; }
.actions { display: flex; justify-content: flex-end; }
.copy { border: none; background: none; color: var(--os-text-brand); cursor: pointer; padding: 0; }
.tool { display: flex; flex-direction: column; gap: 2px; margin-top: var(--os-spacing-s); }
.tool details summary { cursor: pointer; overflow-wrap: anywhere; }
.call { margin-left: var(--os-spacing-l); }
.io { display: flex; flex-direction: column; gap: 2px; margin: var(--os-spacing-xs) 0 var(--os-spacing-s) var(--os-spacing-l); }
.label { color: var(--os-text-secondary); }
pre {
  margin: 0; max-height: 260px; overflow: auto; padding: var(--os-spacing-s); border-radius: var(--os-radius-s);
  background: var(--os-surface-neutral); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; background: var(--os-border-primary); }
.dot.ok { background: #2e9e5b; }
.dot.ko { background: #d64545; }
.dot.neutral { background: #8a94a6; }
</style>
