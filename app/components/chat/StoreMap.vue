<script setup lang="ts">
import "leaflet/dist/leaflet.css";
import type { Map as LeafletMap, CircleMarker } from "leaflet";
import type { ChatStoreMap, ChatStore } from "~/composables/useChat";

/** Carte du pays avec les magasins qui ont du stock pour l'article, et liste des magasins à choisir. */
const props = defineProps<{ data: ChatStoreMap; lang?: string; disabled?: boolean }>();
const emit = defineEmits<{ ask: [text: string] }>();
const t = computed(() => messagesFor(props.lang).stores);

const el = ref<HTMLElement>();
const rows = ref<HTMLElement[]>([]);
const selected = ref<string>();
const located = computed(() => props.data.stores.filter((s) => s.lat !== undefined && s.lon !== undefined));
const markers = new Map<string, CircleMarker>();
let map: LeafletMap | undefined;
let observer: ResizeObserver | undefined;
const config = useRuntimeConfig().public;

const brand = () => getComputedStyle(document.documentElement).getPropertyValue("--os-surface-brand").trim() || "#24bdb0";
const address = (s: ChatStore) => [s.lines?.join(", "), [s.zip_code, s.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");

function select(id: string, from: "map" | "list") {
  selected.value = id;
  for (const [key, m] of markers) {
    m.setStyle(key === id ? { radius: 10, fillOpacity: 1, weight: 3 } : { radius: 7, fillOpacity: 0.8, weight: 2 });
    if (key === id) m.bringToFront();
  }
  if (from === "map") {
    const i = props.data.stores.findIndex((s) => s.id === id);
    rows.value[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } else {
    const m = markers.get(id);
    // La carte ne bouge que si le magasin choisi est hors de la vue.
    if (m && map && !map.getBounds().contains(m.getLatLng())) map.panTo(m.getLatLng());
    m?.openTooltip();
  }
}

function choose(s: ChatStore) {
  emit("ask", t.value.choose(s.name, s.id, props.data.item_name ?? props.data.item_id, props.data.item_id, props.data.quantity, props.data.mode));
}

onMounted(async () => {
  if (!el.value || !located.value.length) return;
  const L = (await import("leaflet")).default;
  map = L.map(el.value, { scrollWheelZoom: false, attributionControl: true });
  // Fond de carte configurable (NUXT_PUBLIC_MAP_TILES_URL / NUXT_PUBLIC_MAP_ATTRIBUTION), OpenStreetMap par défaut.
  L.tileLayer(config.mapTilesUrl as string, { attribution: config.mapAttribution as string, maxZoom: 19 }).addTo(map);
  const color = brand();
  for (const s of located.value) {
    const m = L.circleMarker([s.lat!, s.lon!], { radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.8 })
      .bindTooltip(`<strong>${escapeHtml(s.name)}</strong><br>${escapeHtml(t.value.inStock(s.stock))}`, { direction: "top", offset: [0, -6] })
      .on("click", () => select(s.id, "map"))
      .addTo(map);
    markers.set(s.id, m);
  }
  const bounds = L.latLngBounds(located.value.map((s) => [s.lat!, s.lon!] as [number, number]));
  // Cadrage sur tous les magasins, recalculé quand la carte prend sa taille réelle (iframe, rendu progressif).
  const fit = () => {
    map?.invalidateSize();
    map?.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
  };
  fit();
  let lastWidth = el.value.clientWidth;
  observer = new ResizeObserver(() => {
    if (!el.value || el.value.clientWidth === lastWidth) return;
    lastWidth = el.value.clientWidth;
    fit();
  });
  observer.observe(el.value);
  requestAnimationFrame(fit);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  map?.remove();
});

function escapeHtml(v: string) {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
</script>

<template>
  <section class="stores">
    <div class="head">
      <span class="os-label-m title">{{ t.title(data.stores.length) }}</span>
      <span class="os-body-s os-text-secondary">{{ t.subtitle(data.item_name ?? data.item_id, data.quantity) }}</span>
    </div>
    <div v-if="located.length" ref="el" class="map" />
    <ul class="list">
      <li
        v-for="(s, i) in data.stores"
        :key="s.id"
        :ref="(r) => (rows[i] = r as HTMLElement)"
        :class="['store', { active: selected === s.id }]"
        @click="select(s.id, 'list')"
      >
        <div class="info">
          <span class="os-label-s name">{{ s.name }}</span>
          <span v-if="address(s)" class="os-body-s os-text-secondary">{{ address(s) }}</span>
        </div>
        <OsBadge type="secondary" color="green" :text="t.inStock(s.stock)" />
        <OsButton type="secondary" :text="t.chooseButton" :disabled="disabled" @click.stop="choose(s)" />
      </li>
    </ul>
  </section>
</template>

<style scoped>
.stores { display: flex; flex-direction: column; gap: var(--os-spacing-m); }
.head { display: flex; flex-direction: column; gap: 2px; }
.title { font-weight: 700; }
.map {
  height: 300px; border: 1px solid var(--os-border-primary); border-radius: var(--os-radius-m); overflow: hidden;
  z-index: 0; /* sous les menus et la carte de confirmation */
}
.list {
  list-style: none; margin: 0; padding: 0; max-height: 240px; overflow-y: auto;
  border: 1px solid var(--os-border-primary); border-radius: var(--os-radius-m);
}
.store { display: flex; align-items: center; gap: var(--os-spacing-m); padding: var(--os-spacing-m) var(--os-spacing-l); cursor: pointer; }
.store + .store { border-top: 1px solid var(--os-border-primary); }
.store:hover { background: var(--os-surface-hover); }
.store.active { background: var(--os-surface-brand-transparent); }
.info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.name { font-weight: 500; }
@media (max-width: 480px) {
  .store { flex-wrap: wrap; }
  .info { flex-basis: 100%; }
}
</style>
