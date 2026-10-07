<script setup lang="ts">
import type { PendingAction } from "~/composables/useChat";

const props = defineProps<{ actions: PendingAction[]; busy?: boolean; lang?: string }>();
const emit = defineEmits<{ decide: [approved: boolean] }>();
const t = computed(() => messagesFor(props.lang));
const summaries = computed(() =>
  props.actions.map((action) => ({ id: action.id, ...summarizeAction(action.name, action.input, props.lang) })),
);
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
    <div v-for="summary in summaries" :key="summary.id" :class="['action', { danger: summary.danger }]">
      <OsBadge :color="summary.danger ? 'red' : 'orange'" :icon="summary.danger ? 'close-circle-outline' : 'edit'" :text="summary.title" />
      <p v-if="summary.description" class="os-label-s description">{{ summary.description }}</p>
      <div v-if="summary.sections.length" class="sections">
        <div v-for="section in summary.sections" :key="section.label" class="section">
          <div class="os-body-m os-text-secondary">{{ section.label }}</div>
          <div class="os-label-s">
            <div v-for="(line, i) in section.lines" :key="i">{{ line }}</div>
          </div>
        </div>
      </div>
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
.action.danger { background: var(--os-red-t-100); }
.description { margin: 0; line-height: 1.5; }
.sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--os-spacing-l); }
.section { display: flex; flex-direction: column; gap: var(--os-spacing-xs); overflow-wrap: anywhere; line-height: 1.5; }
.buttons { display: flex; justify-content: flex-end; gap: var(--os-spacing-m); }
</style>
