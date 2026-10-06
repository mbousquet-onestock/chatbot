<script setup lang="ts">
/** Équivalent de OsTabs / OsTab du design system OneStock. */
defineProps<{ tabs: { key: string; label: string; icon?: string }[] }>();
const model = defineModel<string>({ required: true });
</script>

<template>
  <div class="os-tabs-list" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      role="tab"
      :aria-selected="model === tab.key"
      :class="['os-tab', 'os-body-l', { active: model === tab.key }]"
      @click="model = tab.key"
    >
      <OsIcon v-if="tab.icon" :icon="tab.icon" size="s" />
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
.os-tabs-list { display: flex; flex-wrap: wrap; gap: 8px; }
.os-tab {
  display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; min-height: 36px;
  border: none; border-radius: 5px; background-color: transparent; color: #b2b2b2; cursor: pointer;
}
.os-tab:hover { background-color: #00000008; }
.os-tab.active { background-color: #24bdb01a; color: #24bdb0; }
.os-tab:focus-visible { outline: 2px solid var(--os-border-focus); outline-offset: 1px; }
</style>
