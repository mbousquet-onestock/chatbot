<script setup lang="ts">
/** Équivalent de OsLoadingEl du design system OneStock (squelette de chargement). */
withDefaults(defineProps<{ width?: string; height?: string; round?: boolean }>(), { width: "100%", height: "14px" });
</script>

<template>
  <div :class="['os-loading-el', { round }]" :style="{ width, height }" />
</template>

<style scoped>
@keyframes loading { to { transform: translate(100%); } }
.os-loading-el { position: relative; overflow: hidden; border-radius: 5px; background: #0000000d; }
.os-loading-el::after {
  content: ""; position: absolute; inset: 0; transform: translate(-100%);
  animation: loading 3s infinite; background-image: linear-gradient(90deg, #fff0 0, #fffc, #fff0);
}
.os-loading-el.round { border-radius: 999px; }
</style>
