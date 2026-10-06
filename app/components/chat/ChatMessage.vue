<script setup lang="ts">
import MarkdownIt from "markdown-it";
import type { ChatItem } from "~/composables/useChat";

const props = defineProps<{ item: ChatItem; streaming?: boolean; lang?: string }>();
const t = computed(() => messagesFor(props.lang));

// HTML brut désactivé : seul le Markdown produit par l'assistant est rendu.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer");
  return defaultLink(tokens, idx, options, env, self);
};
const html = computed(() => md.render(props.item.text));

const statusColor = { running: "blue", done: "primary", error: "red", declined: "grey" } as const;
const statusIcon = { running: "loader", done: "check", error: "error-outline", declined: "close" } as const;
</script>

<template>
  <div v-if="item.role === 'user' || item.text || item.tools.length || item.error || streaming" :class="['message', item.role]">
    <div v-if="item.role === 'assistant'" class="avatar"><OsIcon icon="onebot" size="s" /></div>
    <div class="bubble">
      <div v-if="item.tools.length" class="tools">
        <OsBadge
          v-for="tool in item.tools"
          :key="tool.id"
          type="secondary"
          :color="statusColor[tool.status]"
          :icon="statusIcon[tool.status]"
          :text="t.tools[tool.name] ?? tool.name"
        />
      </div>
      <p v-if="item.role === 'user'" class="user-text os-label-s">{{ item.text }}</p>
      <div v-else-if="item.text" class="markdown os-label-s" v-html="html" />
      <div v-else-if="streaming && !item.error" class="placeholder">
        <OsLoadingEl width="60%" />
        <OsLoadingEl width="40%" />
        <span class="os-body-s os-text-secondary">{{ t.thinking }}</span>
      </div>
      <OsAlert v-if="item.error" type="danger" :title="t.genericError" :subtitle="item.error" />
    </div>
  </div>
</template>

<style scoped>
.message { display: flex; gap: var(--os-spacing-m); align-items: flex-start; }
.message.user { justify-content: flex-end; }
.avatar {
  display: grid; place-items: center; width: 28px; height: 28px; flex-shrink: 0;
  border-radius: var(--os-radius-round); background: var(--os-surface-brand-transparent); color: var(--os-text-brand);
}
.bubble { display: flex; flex-direction: column; gap: var(--os-spacing-m); min-width: 0; max-width: min(760px, 100%); }
.user .bubble {
  max-width: min(560px, 85%); padding: var(--os-spacing-m) var(--os-spacing-l);
  background: var(--os-surface-brand-secondary); color: #fff; border-radius: var(--os-radius-l) var(--os-radius-l) var(--os-spacing-s) var(--os-radius-l);
}
.assistant .bubble {
  flex: 1; padding: var(--os-spacing-l) var(--os-spacing-xl); background: var(--os-surface-white);
  border: 1px solid var(--os-border-primary); border-radius: var(--os-spacing-s) var(--os-radius-l) var(--os-radius-l) var(--os-radius-l);
}
.user-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.tools { display: flex; flex-wrap: wrap; gap: var(--os-spacing-s); }
.placeholder { display: flex; flex-direction: column; gap: var(--os-spacing-m); }
.markdown { line-height: 1.5; overflow-wrap: anywhere; }
.markdown :deep(> :first-child) { margin-top: 0; }
.markdown :deep(> :last-child) { margin-bottom: 0; }
.markdown :deep(p), .markdown :deep(ul), .markdown :deep(ol) { margin: 0 0 var(--os-spacing-m); }
.markdown :deep(ul), .markdown :deep(ol) { padding-left: var(--os-spacing-2xl); }
.markdown :deep(h1), .markdown :deep(h2), .markdown :deep(h3) { font-size: 1rem; font-weight: 500; margin: var(--os-spacing-l) 0 var(--os-spacing-s); }
.markdown :deep(a) { color: var(--os-text-brand); }
.markdown :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem;
  padding: 1px var(--os-spacing-s); border-radius: var(--os-radius-s); background: var(--os-surface-neutral);
}
.markdown :deep(pre) { padding: var(--os-spacing-m); background: var(--os-surface-neutral); border-radius: var(--os-radius-m); overflow-x: auto; }
.markdown :deep(pre code) { padding: 0; background: none; }
.markdown :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 0 0 var(--os-spacing-m); }
.markdown :deep(th), .markdown :deep(td) { padding: var(--os-spacing-s) var(--os-spacing-m); border-bottom: 1px solid var(--os-border-primary); text-align: left; white-space: nowrap; }
.markdown :deep(th) { font-weight: 500; color: var(--os-text-secondary); font-size: 0.75rem; }
</style>
