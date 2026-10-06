<script setup lang="ts">
/** Équivalent de OsBadge du design system OneStock (type, text, color, icon, disabled). */
withDefaults(
  defineProps<{
    type?: "primary" | "secondary";
    text: string;
    color?: "primary" | "orange" | "red" | "green" | "blue" | "purple" | "grey" | "neutral";
    icon?: string;
    disabled?: boolean;
  }>(),
  { type: "primary", color: "primary" },
);
</script>

<template>
  <span :class="['os-badge', type, color, { disabled }]">
    <OsIcon v-if="icon" class="os-badge-icon" :icon="icon" size="xs" />
    <span class="os-badge-text">{{ text }}</span>
  </span>
</template>

<style scoped>
.os-badge {
  display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 12px; gap: 4px; user-select: none;
  font-size: 0.75rem; font-weight: 500; max-width: 100%;
}
.os-badge.secondary { border-radius: 5px; padding: 4px; }
.os-badge-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.os-badge.primary:not(.disabled) { background-color: #24bdb01a; color: #24bdb0; }
.os-badge.orange:not(.disabled) { background-color: #fd7e141a; color: #fd7e14; }
.os-badge.red:not(.disabled) { background-color: #f445391a; color: #f44539; }
.os-badge.green:not(.disabled) { background-color: #43a0471a; color: #43a047; }
.os-badge.blue:not(.disabled) { background-color: #2695f31a; color: #2695f3; }
.os-badge.purple:not(.disabled) { background-color: #673ab71a; color: #673ab7; }
.os-badge.grey:not(.disabled) { background-color: #0000000d; color: #4c4c4c; }
.os-badge.neutral:not(.disabled) { background-color: #fff; outline: 1px solid #e5e5e5; color: #7f7f7f; }
.os-badge.disabled { background-color: #0000000d; color: #b2b2b2; }
</style>
