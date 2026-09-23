<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import PakSection from './components/PakSection.vue'
import UnpakedSection from './components/UnpakedSection.vue'
import ProgressSection from './components/ProgressSection.vue'
import ActivityLog from './components/ActivityLog.vue'
import SettingsModal from './components/SettingsModal.vue'
import ConflictModal from './components/ConflictModal.vue'
import AppTooltip from './components/AppTooltip.vue'
import { useElectron } from './composables/useElectron'
import { useAppState } from './composables/useAppState'
import { LOCALE_FLAG_ICONS, LOCALE_LABELS, SUPPORTED_LOCALES, setLocale, getInitialLocale, type SupportedLocale } from './i18n'
import type { CheckUpdateResult, ConflictChoice, ConflictRequest } from '../shared/api-types'
import appIcon from './assets/icon.svg'

const { t, locale } = useI18n()
const electron = useElectron()
const { state, updateAppProgress, refreshLists } = useAppState()

const settingsOpen = ref(false)
const updateInfo = ref<CheckUpdateResult | null>(null)
const updateChecking = ref(false)
const currentLocale = ref<SupportedLocale>(getInitialLocale())
const langOpen = ref(false)
const langPicker = ref<HTMLElement | null>(null)
const conflictRequest = ref<ConflictRequest | null>(null)
// Remembered "all" answer for the current action, applied to later folders too.
const conflictAuto = ref<'skip-all' | 'overwrite-all' | null>(null)

watch(
  () => state.actionRunning,
  (running) => {
    if (running) conflictAuto.value = null
  },
)

function onConflict(request: ConflictRequest): void {
  if (conflictAuto.value) {
    void electron.resolveConflict({ requestId: request.requestId, choice: conflictAuto.value })
    return
  }
  conflictRequest.value = request
}

async function chooseConflict(choice: ConflictChoice): Promise<void> {
  const request = conflictRequest.value
  conflictRequest.value = null
  if (!request) return
  if (choice === 'skip-all' || choice === 'overwrite-all') conflictAuto.value = choice
  try {
    await electron.resolveConflict({ requestId: request.requestId, choice })
  } catch {
    // ignore — the backend falls back to cancel if the answer never arrives
  }
}

const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''
const appCommit = typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : ''
const appVersionLabel = appVersion ? `v${appVersion}` : ''

function toggleLang(): void {
  langOpen.value = !langOpen.value
}

function closeLang(): void {
  langOpen.value = false
}

function selectLocale(value: SupportedLocale): void {
  currentLocale.value = value
  setLocale(value)
  ;(locale as unknown as { value: SupportedLocale }).value = value
  langOpen.value = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!langOpen.value) return
  const el = langPicker.value
  if (el && !el.contains(event.target as Node)) closeLang()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') langOpen.value = false
}

async function runUpdateCheck(force = false): Promise<void> {
  if (updateChecking.value) return
  updateChecking.value = true
  try {
    const result = await electron.checkUpdate(force)
    updateInfo.value = result
  } catch {
    // keep previous info — background check must never break the UI
  } finally {
    updateChecking.value = false
  }
}

onMounted(() => {
  ;(locale as unknown as { value: SupportedLocale }).value = currentLocale.value
  electron.onProgress((progress) => {
    // Cancelling (Stop) while a conflict prompt is open must dismiss the modal.
    if (progress.stage === 'canceled') conflictRequest.value = null
    updateAppProgress(progress)
  })
  electron.onConflict(onConflict)
  refreshLists()
  void runUpdateCheck()
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="box-border flex h-full w-full min-h-0 flex-col gap-4 px-5 pb-5 pt-3">
    <header class="flex min-h-[44px] flex-none flex-wrap items-center justify-between gap-3 max-[640px]:min-h-[38px]">
      <div class="flex min-h-[44px] min-w-0 flex-row items-center gap-2.5 max-[640px]:min-h-[38px]">
        <img
          class="block h-[44px] w-[44px] flex-none object-contain select-none [-webkit-user-drag:none] max-[640px]:h-[38px] max-[640px]:w-[38px]"
          :src="appIcon"
          :alt="t('app.title')"
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-col items-start">
          <h1 class="m-0 text-lg text-bright max-[640px]:text-base">{{ t('app.title') }}</h1>
          <span class="mt-0.5 self-start text-xs text-dim">{{ appVersionLabel }} ({{ appCommit }})</span>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2.5">
        <button
          class="inline-flex h-9 w-9 min-w-9 items-center justify-center rounded-lg border border-border bg-hover p-0 text-base leading-none text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="state.actionRunning || state.listsRefreshing"
          v-app-title="t('app.refreshListsHint')"
          @click="refreshLists"
        >
          <span v-if="state.listsRefreshing" class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>
          <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 1.5v3h-3"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          class="relative inline-flex h-9 w-9 min-w-9 items-center justify-center rounded-lg border border-border bg-hover p-0 text-base leading-none text-text cursor-pointer transition duration-150 enabled:hover:bg-border"
          v-app-title="t('app.settings')"
          @click="settingsOpen = true"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span
            v-if="updateInfo?.updateAvailable"
            class="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border bg-accent px-1 text-center text-[9px] font-bold leading-none text-white"
            v-app-title="t('settings.availableBadge')"
          >1</span>
        </button>
        <div ref="langPicker" class="relative inline-flex flex-none">
          <button
            type="button"
            class="inline-flex h-9 w-9 min-w-9 items-center justify-center rounded-lg border border-border bg-hover p-0 text-base leading-none text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
            :aria-expanded="langOpen"
            aria-haspopup="listbox"
            :aria-label="t('app.language')"
            v-app-title="t('app.language')"
            @click="toggleLang"
          >
            <img
              class="pointer-events-none block h-3.5 w-5 flex-none rounded-[3px] object-cover shadow-[0_0_0_1px_rgba(255,255,255,0.14)]"
              :src="LOCALE_FLAG_ICONS[currentLocale]"
              alt=""
              aria-hidden="true"
              width="20"
              height="14"
            />
          </button>
          <ul
            v-if="langOpen"
            class="absolute right-0 top-[calc(100%+6px)] z-[1200] m-0 min-w-[200px] list-none rounded-lg border border-border bg-card p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
            role="listbox"
            :aria-label="t('app.language')"
          >
            <li
              v-for="loc in SUPPORTED_LOCALES"
              :key="loc"
              class="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none hover:bg-hover focus-visible:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
              :class="loc === currentLocale ? 'bg-accent/15 text-bright' : 'text-text'"
              role="option"
              :aria-selected="loc === currentLocale"
              tabindex="0"
              @click="selectLocale(loc)"
              @keydown.enter.prevent="selectLocale(loc)"
              @keydown.space.prevent="selectLocale(loc)"
            >
              <img
                class="pointer-events-none block h-3.5 w-5 flex-none rounded-[3px] object-cover shadow-[0_0_0_1px_rgba(255,255,255,0.14)]"
                :src="LOCALE_FLAG_ICONS[loc]"
                alt=""
                aria-hidden="true"
                width="20"
                height="14"
              />
              <span class="whitespace-nowrap">{{ LOCALE_LABELS[loc] }}</span>
            </li>
          </ul>
        </div>
      </div>
    </header>

    <div class="grid flex-1 grid-cols-2 items-stretch gap-4 min-h-0">
      <PakSection />
      <UnpakedSection />
    </div>

    <div class="grid flex-none grid-cols-2 items-stretch gap-4">
      <ProgressSection />
      <div class="relative min-h-0">
        <ActivityLog class="absolute inset-0" />
      </div>
    </div>

    <SettingsModal
      :open="settingsOpen"
      :update-info="updateInfo"
      :checking="updateChecking"
      @close="settingsOpen = false"
      @verify="runUpdateCheck(true)"
    />
    <ConflictModal :request="conflictRequest" @choose="chooseConflict" />
    <AppTooltip />
  </div>
</template>
