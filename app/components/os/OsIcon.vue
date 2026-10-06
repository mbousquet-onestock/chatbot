<script setup lang="ts">
/** Équivalent de OsIcon du design system OneStock (icon, size, color). */
withDefaults(defineProps<{ icon: string; size?: "xs" | "s" | "m" | "l"; color?: string }>(), { size: "m" });
</script>

<template>
  <i :class="['os-icon', `os-icon-${icon}`, `size-${size}`, color && `color-${color}`]" aria-hidden="true" />
</template>

<style scoped>
.os-icon { flex-shrink: 0; }
.size-xs { width: 14px; min-width: 14px; height: 14px; }
.size-s { width: 18px; min-width: 18px; height: 18px; }
.size-m { width: 24px; min-width: 24px; height: 24px; }
.size-l { width: 30px; min-width: 30px; height: 30px; }
.color-primary { color: #4c4c4c; }
.color-secondary { color: #7f7f7f; }
.color-brand { color: #24bdb0; }
.color-red { color: #f44539; }
.color-orange { color: #fd7e14; }
.color-blue { color: #2695f3; }
.color-green { color: #43a047; }
.os-icon-loader { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
