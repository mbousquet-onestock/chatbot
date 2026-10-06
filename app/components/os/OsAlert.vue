<script setup lang="ts">
/** Équivalent de OsAlert du design system OneStock (type, icon, hideIcon, title, subtitle). */
const props = withDefaults(
  defineProps<{
    type?: "neutral" | "danger" | "warning" | "info" | "success";
    icon?: string;
    hideIcon?: boolean;
    title?: string;
    subtitle?: string;
  }>(),
  { type: "neutral" },
);
const defaultIcons: Record<string, string> = {
  danger: "error-outline",
  warning: "warning-outline",
  info: "info-outline",
  success: "check-circle-outline",
  neutral: "info-outline",
};
const iconName = computed(() => props.icon ?? defaultIcons[props.type] ?? "info-outline");
</script>

<template>
  <div :class="['os-alert', type, { 'single-line': !subtitle && !$slots.default }]" role="status">
    <div class="os-alert-element">
      <OsIcon v-if="!hideIcon" class="os-alert-icon" :icon="iconName" size="s" />
      <div class="os-alert-content">
        <span v-if="title" class="os-body-l">{{ title }}</span>
        <span v-if="subtitle" class="os-body-s">{{ subtitle }}</span>
        <slot />
      </div>
    </div>
    <slot name="actions" />
  </div>
</template>

<style scoped>
.os-alert { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding: 8px 8px 8px 12px; border-radius: 5px; }
.os-alert.neutral { color: #333; background-color: #00000008; }
.os-alert.neutral .os-alert-icon { color: #4c4c4c; }
.os-alert.danger { color: #f44539; background-color: #f445391a; }
.os-alert.warning { color: #fd7e14; background-color: #fd7e141a; }
.os-alert.info { color: #2695f3; background-color: #2695f31a; }
.os-alert.success { color: #24bdb0; background-color: #24bdb01a; }
.os-alert-element { display: flex; gap: 8px; flex: 1; }
.os-alert-icon { min-width: 18px; }
.os-alert-content { display: flex; flex-direction: column; justify-content: center; gap: 4px; flex: 1; }
.single-line { align-items: center; }
</style>
