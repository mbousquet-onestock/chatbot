<script setup lang="ts">
interface ConfigEntry {
  name: string;
  source: "env" | "settings";
  required: boolean;
  secret: boolean;
  set: boolean;
  value?: string;
  note?: string;
}
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
interface SettingsReport {
  session: { site_id: string; user_id: string; extension_id: string };
  environment: ConfigEntry[];
  settings: ConfigEntry[];
  checks: Check[];
}

const props = defineProps<{ lang?: string }>();
const t = computed(() => messagesFor(props.lang).settings);
const { apiFetch } = useOnestockContext();

const report = ref<SettingsReport>();
const loading = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await apiFetch("/api/settings");
    const body = await res.json();
    if (!res.ok) throw new Error(body?.statusMessage ?? `HTTP ${res.status}`);
    report.value = body;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function status(e: ConfigEntry) {
  if (e.set) return { color: "green", icon: "check", text: t.value.set } as const;
  if (e.required) return { color: "red", icon: "error-outline", text: t.value.missing } as const;
  return { color: "grey", icon: "remove", text: t.value.optional } as const;
}

/** Détail affiché sous la valeur : notes codées par le serveur traduites ici. */
function noteText(e: ConfigEntry): string {
  const n = e.note;
  if (!n) return "";
  if (n === "default") return t.value.defaultValue;
  if (n === "POSTGRES_URL") return "POSTGRES_URL";
  if (n === "all") return t.value.allEnvironments;
  if (e.name === "ALLOWED_SITE_IDS") {
    const [count, current] = n.split("|");
    return `${count} ${t.value.sites} · ${current === "current" ? t.value.currentIncluded : t.value.currentExcluded}`;
  }
  if (e.source === "settings") {
    const [enc, scope] = n.split("|");
    return [enc === "encrypted" ? t.value.encrypted : enc === "plain" ? t.value.plain : "", `${t.value.scope} : ${scope}`]
      .filter(Boolean)
      .join(" · ");
  }
  return n;
}

const warn = (e: ConfigEntry) =>
  (e.name === "ALLOWED_SITE_IDS" && (!e.set || e.note?.endsWith("not-current"))) ||
  (e.name === "onestock_token" && e.note?.startsWith("plain"));

const checkDetail = (c: Check) => t.value.errors[c.detail] ?? (c.detail === "env-fallback" ? t.value.envFallback : c.detail);
</script>

<template>
  <div class="settings">
    <div class="intro">
      <OsAlert type="info" :subtitle="t.intro" />
      <OsButton type="secondary" icon="refresh" :text="t.refresh" :pending="loading" @click="load" />
    </div>

    <OsAlert v-if="error" type="danger" :title="error" />

    <div v-if="loading && !report" class="loading">
      <OsLoadingEl v-for="i in 6" :key="i" height="36px" />
      <span class="os-body-s os-text-secondary">{{ t.loading }}</span>
    </div>

    <template v-if="report">
      <section>
        <h2 class="os-label-l">{{ t.session }}</h2>
        <OsCardLayout class="grid">
          <div><div class="os-body-s os-text-secondary">{{ t.site }}</div><div class="os-body-l">{{ report.session.site_id }}</div></div>
          <div><div class="os-body-s os-text-secondary">{{ t.user }}</div><div class="os-body-l">{{ report.session.user_id }}</div></div>
          <div><div class="os-body-s os-text-secondary">{{ t.extension }}</div><div class="os-body-l">{{ report.session.extension_id }}</div></div>
        </OsCardLayout>
      </section>

      <section>
        <h2 class="os-label-l">{{ t.checks }}</h2>
        <OsCardLayout class="rows">
          <div v-for="c in report.checks" :key="c.name" class="row">
            <OsIcon :icon="c.ok ? 'check-circle-outline' : 'error-outline'" size="s" :color="c.ok ? 'green' : 'red'" />
            <span class="os-body-l name">{{ t.checkNames[c.name] ?? c.name }}</span>
            <span class="os-body-s os-text-secondary detail">{{ checkDetail(c) }}</span>
          </div>
        </OsCardLayout>
      </section>

      <section v-for="group in [{ title: t.settingsTable, entries: report.settings }, { title: t.environment, entries: report.environment }]" :key="group.title">
        <h2 class="os-label-l">{{ group.title }}</h2>
        <OsCardLayout class="rows">
          <div v-for="e in group.entries" :key="e.name" class="row entry">
            <div class="label">
              <code>{{ e.name }}</code>
              <span class="os-body-s os-text-secondary">{{ t.descriptions[e.name] ?? "" }}</span>
            </div>
            <div class="value">
              <span v-if="e.value" class="os-label-s mono">{{ e.value }}</span>
              <span v-else-if="e.secret && e.set" class="os-body-s os-text-secondary">{{ t.secret }}</span>
              <span v-if="noteText(e)" :class="['os-body-s', warn(e) ? 'warn' : 'os-text-secondary']">{{ noteText(e) }}</span>
            </div>
            <OsBadge type="secondary" :color="warn(e) ? 'orange' : status(e).color" :icon="status(e).icon" :text="status(e).text" />
          </div>
        </OsCardLayout>
      </section>
    </template>
  </div>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: var(--os-spacing-2xl); max-width: 900px; margin: 0 auto; }
.intro { display: flex; gap: var(--os-spacing-l); align-items: flex-start; }
.intro > :first-child { flex: 1; }
.loading { display: flex; flex-direction: column; gap: var(--os-spacing-m); }
section { display: flex; flex-direction: column; gap: var(--os-spacing-m); }
h2 { margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--os-spacing-l); }
.rows { display: flex; flex-direction: column; padding: 0; }
.row { display: flex; align-items: center; gap: var(--os-spacing-l); padding: var(--os-spacing-l) var(--os-spacing-xl); }
.row + .row { border-top: 1px solid var(--os-border-primary); }
.name { min-width: 140px; }
.detail { overflow-wrap: anywhere; }
.entry { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 110px; }
.entry .label, .entry .value { display: flex; flex-direction: column; gap: var(--os-spacing-xs); min-width: 0; overflow-wrap: anywhere; }
.entry > :last-child { justify-self: end; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; color: var(--os-text-primary); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; }
.warn { color: var(--os-orange-1000); }
@media (max-width: 640px) {
  .intro { flex-direction: column; }
  .entry { grid-template-columns: minmax(0, 1fr) auto; }
  .entry .value { grid-row: 2; grid-column: 1 / -1; }
}
</style>
