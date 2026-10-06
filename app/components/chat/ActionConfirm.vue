<script setup lang="ts">
import type { PendingAction } from "~/composables/useChat";

const props = defineProps<{ actions: PendingAction[]; busy?: boolean; lang?: string }>();
const emit = defineEmits<{ decide: [approved: boolean] }>();
const t = computed(() => messagesFor(props.lang));

function format(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "object" && v && "from" in v && "to" in v)) {
    return value.map((r: any) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`)).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" · ");
  }
  return String(value);
}

const rows = (action: PendingAction) =>
  Object.entries(action.input).map(([key, value]) => ({ key, label: t.value.fields[key] ?? key, value: format(value) }));
</script>

<template>
  <OsCardLayout class="confirm">
    <div class="head">
      <OsIcon icon="warning-outline" size="s" color="orange" />
      <div>
        <div class="os-body-l">{{ t.confirmTitle }}</div>
        <div class="os-body-s os-text-secondary">{{ t.confirmText }}</div>
      </div>
    </div>
    <div v-for="action in actions" :key="action.id" class="action">
      <OsBadge color="orange" icon="edit" :text="t.tools[action.name] ?? action.name" />
      <dl>
        <template v-for="row in rows(action)" :key="row.key">
          <dt class="os-body-s os-text-secondary">{{ row.label }}</dt>
          <dd class="os-label-s">{{ row.value }}</dd>
        </template>
      </dl>
    </div>
    <div class="buttons">
      <OsButton type="secondary" :text="t.cancel" :disabled="busy" @click="emit('decide', false)" />
      <OsButton :text="t.confirm" icon="check" :pending="busy" @click="emit('decide', true)" />
    </div>
  </OsCardLayout>
</template>

<style scoped>
.confirm { display: flex; flex-direction: column; gap: var(--os-spacing-l); border-left: 3px solid var(--os-orange-1000); }
.head { display: flex; gap: var(--os-spacing-m); align-items: flex-start; }
.action { display: flex; flex-direction: column; gap: var(--os-spacing-m); padding: var(--os-spacing-l); background: var(--os-surface-neutral); border-radius: var(--os-radius-m); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--os-spacing-s) var(--os-spacing-l); margin: 0; }
dt { align-self: center; }
dd { margin: 0; overflow-wrap: anywhere; }
.buttons { display: flex; justify-content: flex-end; gap: var(--os-spacing-m); }
</style>
