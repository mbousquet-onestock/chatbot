<script setup lang="ts">
/** Équivalent de OsButton du design system OneStock (type, color, text, icon, pending, disabled). */
const props = withDefaults(
  defineProps<{
    type?: "primary" | "secondary" | "tertiary";
    color?: "primary" | "red" | "orange" | "blue" | "white-transparent" | "neutral";
    text?: string;
    icon?: string;
    pending?: boolean;
    disabled?: boolean;
  }>(),
  { type: "primary", color: "primary" },
);
const emit = defineEmits<{ click: [MouseEvent] }>();
const allowed: Record<string, string[]> = {
  primary: ["primary", "red", "orange", "blue", "white-transparent"],
  secondary: ["primary"],
  tertiary: ["primary", "red", "neutral"],
};
const color = computed(() => (allowed[props.type]?.includes(props.color) ? props.color : "primary"));
function onClick(e: MouseEvent) {
  if (!props.disabled && !props.pending) emit("click", e);
}
</script>

<template>
  <button
    type="button"
    :class="[
      'os-button',
      type,
      `os-button-${type}-${color}`,
      { disabled, pending, 'os-button-icon-only': icon && !text, 'os-button-icon-start': icon && text },
    ]"
    :disabled="disabled"
    :aria-busy="pending || undefined"
    @click="onClick"
  >
    <OsIcon v-if="pending" icon="loader" size="s" />
    <OsIcon v-else-if="icon" :icon="icon" size="s" />
    <span v-if="text" class="os-button-text">{{ text }}</span>
  </button>
</template>

<style scoped>
.os-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 36px; min-width: 36px; flex-shrink: 0; padding: 8px 16px;
  border: none; border-radius: 5px; cursor: pointer; position: relative;
  font-size: 0.875rem; font-weight: 500;
}
.os-button-text { white-space: nowrap; }
.os-button-icon-start { padding-inline-start: 8px; }
.os-button-icon-only { padding: 8px; }
.os-button:focus-visible { outline: 2px solid var(--os-border-focus); outline-offset: 1px; }
.pending { cursor: default; }
.primary:not(.disabled).os-button-primary-primary { color: #fff; background-color: #24bdb0; }
.primary:not(.disabled).os-button-primary-primary:hover:not(.pending) { background-color: #50cac0; }
.primary:not(.disabled).os-button-primary-red { color: #fff; background-color: #f44539; }
.primary:not(.disabled).os-button-primary-red:hover:not(.pending) { background-color: #f66a61; }
.primary:not(.disabled).os-button-primary-orange { color: #fff; background-color: #fd7e14; }
.primary:not(.disabled).os-button-primary-orange:hover:not(.pending) { background-color: #fd9843; }
.primary:not(.disabled).os-button-primary-blue { color: #fff; background-color: #2695f3; }
.primary:not(.disabled).os-button-primary-blue:hover:not(.pending) { background-color: #51aaf5; }
.primary:not(.disabled).os-button-primary-white-transparent { color: #fff; background-color: #fff3; }
.secondary:not(.disabled).os-button-secondary-primary { color: #4c4c4c; background-color: #fff; border: 1px solid #e5e5e5; }
.secondary:not(.disabled).os-button-secondary-primary:hover:not(.pending) { background-color: #00000008; }
.tertiary:not(.disabled).os-button-icon-only { border-radius: 9999px; }
.tertiary:not(.disabled).os-button-tertiary-primary { color: #4c4c4c; background-color: transparent; }
.tertiary:not(.disabled).os-button-tertiary-primary:hover:not(.pending) { background-color: #00000008; }
.tertiary:not(.disabled).os-button-tertiary-red { color: #f44539; background-color: transparent; }
.tertiary:not(.disabled).os-button-tertiary-red:hover:not(.pending) { background-color: #f445391a; }
.tertiary:not(.disabled).os-button-tertiary-neutral { color: #fff; background-color: transparent; }
.disabled { cursor: default; color: #b2b2b2; background-color: #f7f7f7; }
.disabled.tertiary { background-color: transparent; }
</style>
