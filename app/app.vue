<script setup lang="ts">
const { state: os, close, resize } = useOnestockContext();
const t = computed(() => messagesFor(os.context.lang));
const ready = computed(() => os.status === "ready");

const { items, pending, busy, send, decide, reset } = useChat();
const draft = ref("");
const tab = ref<"chat" | "settings">("chat");
const tabs = computed(() => [
  { key: "chat", label: t.value.tabChat, icon: "message-outlined" },
  { key: "settings", label: t.value.tabSettings, icon: "settings-outline" },
]);
const scroller = ref<HTMLElement>();
const textarea = ref<HTMLTextAreaElement>();

const isModal = computed(() => !!os.context.order_id || !!os.context.order_ids?.length);
const suggestions = computed(() =>
  os.context.order_id ? t.value.suggestionsOrder : os.context.order_ids?.length ? t.value.suggestionsOrders : t.value.suggestions,
);

function submit(text = draft.value) {
  if (!text.trim() || busy.value || pending.value.length) return;
  send(text);
  draft.value = "";
  nextTick(autosize);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}

function autosize() {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

// Défilement automatique tant que l'utilisateur est en bas de la conversation.
watch(
  () => [items.value.length, items.value.at(-1)?.text, items.value.at(-1)?.tools.length, pending.value.length],
  async () => {
    const el = scroller.value;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    await nextTick();
    if (atBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  },
);

// Hauteur de l'iframe dans le back-office : la page de l'extension occupe une hauteur fixe confortable.
onMounted(() => resize(Math.max(640, Math.round(window.screen.availHeight * 0.75))));
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="brand">
        <span class="logo"><OsIcon icon="onebot" size="s" /></span>
        <div>
          <div class="os-label-l">{{ t.title }}</div>
          <div class="os-body-s os-text-secondary">{{ t.subtitle }}</div>
        </div>
      </div>
      <div class="header-actions">
        <OsBadge v-if="os.context.order_id" color="blue" icon="shopping-cart-outline" :text="`${t.currentOrder} ${os.context.order_id}`" />
        <OsBadge v-else-if="os.context.order_ids?.length" color="blue" icon="shopping-cart-outline" :text="`${os.context.order_ids.length} ${t.selectedOrders}`" />
        <OsButton v-if="items.length" type="tertiary" icon="refresh" :disabled="busy" :aria-label="t.newChat" :title="t.newChat" @click="reset" />
        <OsButton v-if="isModal && os.embedded" type="tertiary" icon="close" :aria-label="t.close" :title="t.close" @click="close" />
      </div>
    </header>

    <nav v-if="ready" class="tabs">
      <OsTabs v-model="tab" :tabs="tabs" />
    </nav>

    <main v-if="ready && tab === 'settings'" class="conversation">
      <SettingsPanel :lang="os.context.lang" />
    </main>

    <main v-else ref="scroller" class="conversation">
      <div v-if="os.status === 'loading'" class="center">
        <OsIcon icon="loader" size="l" color="brand" />
        <span class="os-body-s os-text-secondary">{{ t.connecting }}</span>
      </div>

      <div v-else-if="os.status === 'error'" class="center narrow">
        <OsAlert type="danger" :title="t.errorTitle" :subtitle="t.errors[os.error] ?? (t as any)[os.error] ?? os.error" />
      </div>

      <template v-else>
        <div v-if="!items.length" class="welcome">
          <span class="welcome-icon"><OsIcon icon="onebot" size="l" /></span>
          <div class="os-title-m">{{ t.title }}</div>
          <div class="os-label-s os-text-secondary">{{ t.subtitle }}</div>
          <div class="suggestions">
            <button v-for="s in suggestions" :key="s" type="button" class="suggestion os-label-s" @click="s.endsWith('…') ? (draft = s.slice(0, -1)) : submit(s)">
              <span>{{ s }}</span>
              <OsIcon icon="chevron-right" size="s" color="secondary" />
            </button>
          </div>
        </div>

        <div class="messages">
          <ChatMessage
            v-for="(item, i) in items"
            :key="i"
            :item="item"
            :lang="os.context.lang"
            :streaming="busy && i === items.length - 1"
          />
          <ActionConfirm v-if="pending.length" :actions="pending" :busy="busy" :lang="os.context.lang" @decide="decide" />
        </div>
      </template>
    </main>

    <footer v-show="tab === 'chat'" class="composer">
      <div :class="['input', { disabled: !ready }]">
        <textarea
          ref="textarea"
          v-model="draft"
          rows="1"
          class="os-label-s"
          :placeholder="t.placeholder"
          :disabled="!ready || pending.length > 0"
          @input="autosize"
          @keydown="onKeydown"
        />
        <OsButton
          icon="paper-plane"
          :aria-label="t.send"
          :title="t.send"
          :pending="busy"
          :disabled="!ready || !draft.trim() || pending.length > 0"
          @click="submit()"
        />
      </div>
    </footer>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; background: var(--os-surface-page-background); }
.header {
  display: flex; align-items: center; justify-content: space-between; gap: var(--os-spacing-l);
  padding: var(--os-spacing-l) var(--os-spacing-xl); background: var(--os-surface-white); border-bottom: 1px solid var(--os-border-primary);
}
.brand { display: flex; align-items: center; gap: var(--os-spacing-l); min-width: 0; }
.logo {
  display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0;
  border-radius: var(--os-radius-m); background: var(--os-surface-brand); color: #fff;
}
.header-actions { display: flex; align-items: center; gap: var(--os-spacing-s); min-width: 0; }
.tabs { padding: var(--os-spacing-m) var(--os-spacing-xl); background: var(--os-surface-white); border-bottom: 1px solid var(--os-border-primary); }
.conversation { flex: 1; overflow-y: auto; padding: var(--os-spacing-2xl) var(--os-spacing-xl); }
.messages { display: flex; flex-direction: column; gap: var(--os-spacing-xl); max-width: 900px; margin: 0 auto; }
.center { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--os-spacing-m); }
.narrow { max-width: 480px; margin: 0 auto; }
.welcome { display: flex; flex-direction: column; align-items: center; text-align: center; gap: var(--os-spacing-m); padding: var(--os-spacing-3xl) 0; }
.welcome-icon {
  display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: var(--os-spacing-s);
  border-radius: var(--os-radius-l); background: var(--os-surface-brand-transparent); color: var(--os-text-brand);
}
.suggestions { display: flex; flex-direction: column; gap: var(--os-spacing-m); width: min(480px, 100%); margin-top: var(--os-spacing-xl); }
.suggestion {
  display: flex; align-items: center; justify-content: space-between; gap: var(--os-spacing-m);
  padding: var(--os-spacing-m) var(--os-spacing-l); text-align: left; cursor: pointer; color: var(--os-text-primary);
  background: var(--os-surface-white); border: 1px solid var(--os-border-primary); border-radius: var(--os-radius-m);
}
.suggestion:hover { background: var(--os-surface-hover); border-color: var(--os-primary-800); }
.composer { padding: var(--os-spacing-l) var(--os-spacing-xl) var(--os-spacing-xl); background: var(--os-surface-page-background); }
.input {
  display: flex; align-items: flex-end; gap: var(--os-spacing-m); max-width: 900px; margin: 0 auto;
  padding: var(--os-spacing-s) var(--os-spacing-s) var(--os-spacing-s) var(--os-spacing-l);
  background: var(--os-surface-white); border: 1px solid var(--os-border-primary); border-radius: var(--os-radius-m);
}
.input:focus-within { border-color: var(--os-border-focus); }
.input.disabled { background: var(--os-neutral-30); }
textarea {
  flex: 1; resize: none; border: none; outline: none; background: transparent; color: var(--os-text-primary);
  padding: var(--os-spacing-m) 0; line-height: 20px; max-height: 160px;
}
textarea::placeholder { color: var(--os-text-placeholder); }
@media (max-width: 560px) {
  .header { flex-wrap: wrap; }
  .brand .os-body-s { display: none; }
}
</style>
