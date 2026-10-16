<script setup lang="ts">
/** Saisie de la configuration OneStock (table settings), test des connexions et enregistrement. */
interface Current {
  apiRoot?: string;
  stockRequestName?: string;
  defaultLang?: string;
  tokenSet: boolean;
}
interface ConnectionTest {
  name: string;
  ok: boolean;
  detail: string;
}

const props = defineProps<{
  lang?: string;
  siteId: string;
  current: Current;
  editEnabled: boolean;
  environment: string;
}>();
const emit = defineEmits<{ saved: [] }>();
const { apiFetch } = useOnestockContext();

const texts = {
  fr: {
    title: "Configuration OneStock",
    intro: "Valeurs enregistrées dans la table settings. Laissez le token vide pour conserver le token actuel.",
    apiRoot: "URL de l'API OneStock",
    token: "Token OneStock",
    tokenPlaceholderSet: "Inchangé (token déjà enregistré)",
    tokenPlaceholderEmpty: "Saisir le token",
    stockView: "Vue de stock",
    defaultLang: "Langue par défaut",
    scope: "Portée",
    scopeSite: (s: string) => `Ce site (${s})`,
    scopeGlobal: "Tous les sites (global)",
    environment: "Environment",
    adminPassword: "Mot de passe administrateur",
    test: "Tester les connexions",
    save: "Enregistrer",
    disabled: "Enregistrement désactivé : définissez SETTINGS_ADMIN_PASSWORD dans Vercel puis redéployez. Le test reste possible.",
    saved: (n: number, site: string, env: string) => `${n} valeur(s) enregistrée(s) pour ${site} / ${env}.`,
    nothing: "Aucune valeur modifiée.",
    tokenRequired: "Nouvelle URL d'API : saisissez aussi le token (le token enregistré n'est jamais envoyé à une autre adresse).",
    errors: {
      invalid_admin_password: "Mot de passe administrateur incorrect.",
      admin_password_not_configured: "SETTINGS_ADMIN_PASSWORD n'est pas définie : enregistrement désactivé.",
      token_required_for_new_api_root: "Nouvelle URL d'API : saisissez aussi le token.",
      missing_environment: "Indiquez l'environment.",
    } as Record<string, string>,
    names: {
      settings_api: "API Settings (Extensions)",
      database: "Base de données",
      onestock: "API OneStock (URL et token)",
      stock_view: "Vue de stock",
      default_lang: "Langue par défaut",
      openai: "API OpenAI",
    } as Record<string, string>,
    details: {
      "missing-database": "SETTINGS_API_URL + SETTINGS_API_KEY (ou DATABASE_URL) manquantes",
      "missing-api-root": "URL de l'API manquante",
      "missing-token": "token manquant",
      "missing-key": "OPENAI_API_KEY manquante",
    } as Record<string, string>,
  },
  en: {
    title: "OneStock configuration",
    intro: "Values saved in the settings table. Leave the token empty to keep the current token.",
    apiRoot: "OneStock API URL",
    token: "OneStock token",
    tokenPlaceholderSet: "Unchanged (token already saved)",
    tokenPlaceholderEmpty: "Enter the token",
    stockView: "Stock view",
    defaultLang: "Default language",
    scope: "Scope",
    scopeSite: (s: string) => `This site (${s})`,
    scopeGlobal: "All sites (global)",
    environment: "Environment",
    adminPassword: "Admin password",
    test: "Test connections",
    save: "Save",
    disabled: "Saving is disabled: set SETTINGS_ADMIN_PASSWORD in Vercel and redeploy. Testing still works.",
    saved: (n: number, site: string, env: string) => `${n} value(s) saved for ${site} / ${env}.`,
    nothing: "No value changed.",
    tokenRequired: "New API URL: also enter the token (the saved token is never sent to another address).",
    errors: {
      invalid_admin_password: "Wrong admin password.",
      admin_password_not_configured: "SETTINGS_ADMIN_PASSWORD is not set: saving is disabled.",
      token_required_for_new_api_root: "New API URL: also enter the token.",
      missing_environment: "Enter the environment.",
    } as Record<string, string>,
    names: {
      settings_api: "Settings API (Extensions)",
      database: "Database",
      onestock: "OneStock API (URL and token)",
      stock_view: "Stock view",
      default_lang: "Default language",
      openai: "OpenAI API",
    } as Record<string, string>,
    details: {
      "missing-database": "SETTINGS_API_URL + SETTINGS_API_KEY (or DATABASE_URL) missing",
      "missing-api-root": "API URL missing",
      "missing-token": "token missing",
      "missing-key": "OPENAI_API_KEY missing",
    } as Record<string, string>,
  },
};
const t = computed(() => (props.lang?.toLowerCase().startsWith("fr") ? texts.fr : texts.en));

const form = reactive({
  apiRoot: props.current.apiRoot ?? "",
  token: "",
  stockView: props.current.stockRequestName ?? "",
  defaultLang: props.current.defaultLang ?? "",
  scope: "global" as "site" | "global",
  environment: props.environment,
  adminPassword: "",
});

const apiRootChanged = computed(() => !!form.apiRoot.trim() && form.apiRoot.trim() !== (props.current.apiRoot ?? ""));

/** Seules les valeurs modifiées sont envoyées (vide = inchangé). */
function changedValues() {
  const v: Record<string, string> = {};
  if (apiRootChanged.value) v.onestock_api_root = form.apiRoot.trim();
  if (form.token.trim()) v.onestock_token = form.token.trim();
  if (form.stockView.trim() && form.stockView.trim() !== (props.current.stockRequestName ?? "")) v.onestock_stock_request_name = form.stockView.trim();
  if (form.defaultLang.trim() && form.defaultLang.trim() !== (props.current.defaultLang ?? "")) v.default_lang = form.defaultLang.trim();
  return v;
}

const testing = ref(false);
const saving = ref(false);
const tests = ref<ConnectionTest[]>([]);
const message = ref<{ type: "success" | "danger" | "info"; text: string }>();

async function call(path: string, method: string, body: unknown) {
  const res = await apiFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(t.value.errors[data?.statusMessage] ?? data?.statusMessage ?? `HTTP ${res.status}`);
  return data;
}

async function runTests() {
  testing.value = true;
  message.value = undefined;
  try {
    tests.value = (await call("/api/settings/test", "POST", { values: changedValues() })).tests;
  } catch (err) {
    message.value = { type: "danger", text: err instanceof Error ? err.message : String(err) };
  } finally {
    testing.value = false;
  }
}

async function save() {
  const values = changedValues();
  if (!Object.keys(values).length) {
    message.value = { type: "info", text: t.value.nothing };
    return;
  }
  saving.value = true;
  message.value = undefined;
  try {
    const res = await call("/api/settings", "PUT", {
      values,
      scope: form.scope,
      environment: form.environment,
      admin_password: form.adminPassword,
    });
    message.value = { type: "success", text: t.value.saved(res.saved.length, res.site_id, res.environment) };
    form.token = "";
    form.adminPassword = "";
    emit("saved");
  } catch (err) {
    message.value = { type: "danger", text: err instanceof Error ? err.message : String(err) };
  } finally {
    saving.value = false;
  }
}

const testDetail = (c: ConnectionTest) => t.value.details[c.detail] ?? c.detail;
</script>

<template>
  <section class="editor">
    <h2 class="os-label-l">{{ t.title }}</h2>
    <OsCardLayout class="card">
      <p class="os-body-s os-text-secondary intro">{{ t.intro }}</p>

      <div class="fields">
        <label class="field wide">
          <span class="os-body-m os-text-secondary">{{ t.apiRoot }}</span>
          <input v-model="form.apiRoot" class="os-label-s" type="url" placeholder="https://api-qualif.onestock-retail.com" />
        </label>
        <label class="field wide">
          <span class="os-body-m os-text-secondary">{{ t.token }}</span>
          <input
            v-model="form.token"
            class="os-label-s"
            type="password"
            autocomplete="new-password"
            :placeholder="current.tokenSet ? t.tokenPlaceholderSet : t.tokenPlaceholderEmpty"
          />
          <span v-if="apiRootChanged && !form.token" class="os-body-s warn">{{ t.tokenRequired }}</span>
        </label>
        <label class="field">
          <span class="os-body-m os-text-secondary">{{ t.stockView }}</span>
          <input v-model="form.stockView" class="os-label-s" type="text" placeholder="detailed" />
        </label>
        <label class="field">
          <span class="os-body-m os-text-secondary">{{ t.defaultLang }}</span>
          <input v-model="form.defaultLang" class="os-label-s" type="text" placeholder="fr" maxlength="10" />
        </label>
      </div>

      <div class="actions">
        <OsButton type="secondary" icon="refresh" :text="t.test" :pending="testing" @click="runTests" />
      </div>

      <div v-if="tests.length" class="tests">
        <div v-for="c in tests" :key="c.name" class="test">
          <OsIcon :icon="c.ok ? 'check-circle-outline' : 'error-outline'" size="s" :color="c.ok ? 'green' : 'red'" />
          <span class="os-body-l name">{{ t.names[c.name] ?? c.name }}</span>
          <span class="os-body-s os-text-secondary detail">{{ testDetail(c) }}</span>
        </div>
      </div>

      <OsAlert v-if="!editEnabled" type="warning" :subtitle="t.disabled" />
      <template v-else>
        <div class="fields">
          <div class="field">
            <span class="os-body-m os-text-secondary">{{ t.scope }}</span>
            <OsTabs
              v-model="form.scope"
              :tabs="[
                { key: 'global', label: t.scopeGlobal },
                { key: 'site', label: t.scopeSite(siteId) },
              ]"
            />
          </div>
          <label class="field">
            <span class="os-body-m os-text-secondary">{{ t.environment }}</span>
            <input v-model="form.environment" class="os-label-s" type="text" placeholder="qualif" />
          </label>
          <label class="field">
            <span class="os-body-m os-text-secondary">{{ t.adminPassword }}</span>
            <input v-model="form.adminPassword" class="os-label-s" type="password" autocomplete="current-password" />
          </label>
        </div>
        <div class="actions">
          <OsButton icon="save" :text="t.save" :pending="saving" :disabled="!form.adminPassword || !form.environment" @click="save" />
        </div>
      </template>

      <OsAlert v-if="message" :type="message.type" :subtitle="message.text" />
    </OsCardLayout>
  </section>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: var(--os-spacing-m); }
h2 { margin: 0; }
.card { display: flex; flex-direction: column; gap: var(--os-spacing-l); }
.intro { margin: 0; }
.fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--os-spacing-l); }
.field { display: flex; flex-direction: column; gap: var(--os-spacing-xs); min-width: 0; }
.field.wide { grid-column: 1 / -1; }
input {
  height: 36px; padding: 8px 8px 8px 12px; border: 1px solid var(--os-border-primary); border-radius: var(--os-radius-m);
  color: var(--os-text-primary); background: var(--os-surface-white); min-width: 0;
}
input:focus { outline: none; border-color: var(--os-border-focus); }
input::placeholder { color: var(--os-text-placeholder); }
.actions { display: flex; justify-content: flex-end; gap: var(--os-spacing-m); }
.tests { display: flex; flex-direction: column; border: 1px solid var(--os-border-primary); border-radius: var(--os-radius-m); }
.test { display: flex; align-items: center; gap: var(--os-spacing-l); padding: var(--os-spacing-m) var(--os-spacing-l); }
.test + .test { border-top: 1px solid var(--os-border-primary); }
.name { min-width: 200px; }
.detail { overflow-wrap: anywhere; }
.warn { color: var(--os-orange-1000); }
@media (max-width: 640px) {
  .fields { grid-template-columns: 1fr; }
  .name { min-width: 0; }
}
</style>
