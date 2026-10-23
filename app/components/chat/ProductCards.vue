<script setup lang="ts">
import type { ChatProductList, ChatProduct } from "~/composables/useChat";

/** Articles en cartes : vignette, nom, « prix | couleur », référence ; bouton « Réserver » pour une recherche. */
const props = defineProps<{ list: ChatProductList; lang?: string; disabled?: boolean }>();
const emit = defineEmits<{ ask: [text: string] }>();
const t = computed(() => messagesFor(props.lang).products);

const locale = computed(() => props.lang || "fr-FR");
function price(p: ChatProduct): string | undefined {
  if (p.price === undefined) return undefined;
  try {
    return new Intl.NumberFormat(locale.value, { style: "currency", currency: p.currency || "EUR" }).format(p.price);
  } catch {
    return `${p.price} ${p.currency ?? ""}`.trim();
  }
}
const details = (p: ChatProduct) => [price(p), p.color, p.size].filter(Boolean).join(" | ");

const broken = reactive(new Set<string>());
</script>

<template>
  <ul class="products">
    <li v-for="p in list.products" :key="p.id" class="product">
      <div class="thumb">
        <img v-if="p.image && !broken.has(p.id)" :src="p.image" :alt="p.name ?? p.id" loading="lazy" @error="broken.add(p.id)" />
        <OsIcon v-else icon="parcel-outline" size="m" color="secondary" />
      </div>
      <div class="info">
        <span class="name os-label-m">{{ p.name ?? p.id }}</span>
        <span v-if="details(p)" class="details os-body-l">{{ details(p) }}</span>
        <span class="ref os-body-s os-text-secondary">
          {{ p.id }}<template v-if="p.quantity !== undefined"> · {{ t.quantity(p.quantity) }}</template>
        </span>
      </div>
      <div v-if="list.context === 'search'" class="actions">
        <OsButton
          type="secondary"
          icon="truck"
          :text="t.order"
          :disabled="disabled"
          @click="emit('ask', t.orderMessage(p.name ?? p.id, p.id))"
        />
        <OsButton
          type="secondary"
          icon="shopping-cart-outline"
          :text="t.reserve"
          :disabled="disabled"
          @click="emit('ask', t.reserveMessage(p.name ?? p.id, p.id))"
        />
      </div>
    </li>
  </ul>
</template>

<style scoped>
.products { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--os-spacing-s); }
.product {
  display: flex; align-items: center; gap: var(--os-spacing-l); padding: var(--os-spacing-m);
  border: 1px solid var(--os-border-primary); border-radius: var(--os-radius-m); background: var(--os-surface-white);
}
.thumb {
  display: grid; place-items: center; width: 56px; height: 56px; flex-shrink: 0; overflow: hidden;
  border: 1px solid var(--os-border-primary); border-radius: var(--os-radius-m); background: #fff;
}
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.name { font-weight: 700; color: var(--os-text-primary); overflow-wrap: anywhere; }
.details { color: var(--os-text-primary); font-weight: 400; }
.ref { overflow-wrap: anywhere; }
.actions { flex-shrink: 0; display: flex; gap: var(--os-spacing-s); }
@media (max-width: 480px) {
  .product { flex-wrap: wrap; }
  .actions { width: 100%; justify-content: flex-end; }
}
</style>
