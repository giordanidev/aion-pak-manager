<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppState } from '../composables/useAppState'
import { getShowFileNames, setShowFileNames } from '../composables/useElectron'

const { t } = useI18n()
const { state } = useAppState()
const logEl = ref<HTMLElement | null>(null)
const modalLogEl = ref<HTMLElement | null>(null)
const logModalOpen = ref(false)

const showFileNames = ref(getShowFileNames())

function logClass(type: string): string {
  switch (type) {
    case 'success':
      return 'text-green'
    case 'warning':
      return 'text-orange'
    case 'error':
      return 'text-red'
    default:
      return 'text-accent-hover'
  }
}

function onShowFileNamesChange(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  showFileNames.value = checked
  setShowFileNames(checked)
}

function scrollLogIntoView(el: HTMLElement | null): void {
  if (el) {
    el.scrollTop = el.scrollHeight
  }
}

watch(
  () => state.logEntries.length,
  () => {
    scrollLogIntoView(logEl.value)
    if (logModalOpen.value) {
      scrollLogIntoView(modalLogEl.value)
    }
  }
)

watch(
  () => logModalOpen.value,
  (isOpen) => {
    if (isOpen) {
      window.addEventListener('keydown', onModalKeydown)
      requestAnimationFrame(() => scrollLogIntoView(modalLogEl.value))
    } else {
      window.removeEventListener('keydown', onModalKeydown)
    }
  }
)

function onModalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') logModalOpen.value = false
}
</script>

<template>
  <div class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card p-3.5 shadow-[0_2px_18px_rgba(0,0,0,0.25)]">
    <div class="mb-2 flex flex-none items-center justify-between gap-3">
      <h2 class="m-0 text-[17px] font-bold text-bright">{{ t('log.title') }}</h2>
      <div class="flex items-center gap-3">
        <label
          class="relative inline-flex cursor-pointer select-none items-center gap-2 text-[13px] text-text"
          v-app-title="t('log.showNamesHint')"
        >
          <input type="checkbox" class="peer sr-only" :checked="showFileNames" @change="onShowFileNamesChange" />
          <span class="h-5 w-9 flex-none rounded-full border border-border bg-card transition-colors peer-checked:border-accent peer-checked:bg-accent/25"></span>
          <span class="pointer-events-none absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-[#e9e9ff] transition-all peer-checked:left-[18px] peer-checked:bg-accent"></span>
          <span>{{ t('log.showNames') }}</span>
        </label>
        <button
          class="inline-flex h-9 w-9 min-w-9 items-center justify-center rounded-lg border border-border bg-hover p-0 text-base leading-none text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
          v-app-title="t('log.openFullHint')"
          @click="logModalOpen = true"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M9.5 2h4.5v4.5M14 2 9 7M6.5 14H2V9.5M2 14l5-5"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
    <div
      class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-deepest p-4 font-mono text-[13px]"
      ref="logEl"
    >
      <p v-for="entry in state.logEntries" :key="entry.id" class="my-1 leading-[1.4]" :class="logClass(entry.type)">{{ entry.message }}</p>
    </div>

    <Teleport to="body">
      <div v-if="logModalOpen" class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 p-5">
        <div
          class="flex h-[80vh] w-[90vw] max-w-[90vw] min-h-0 flex-col rounded-xl border border-border bg-card shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
          role="dialog"
          aria-modal="true"
        >
          <div class="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-4">
            <h3 class="m-0 text-bright">{{ t('log.title') }}</h3>
            <button
              class="inline-flex h-8 w-8 min-w-8 items-center justify-center rounded-lg border border-red bg-transparent p-0 text-[15px] font-bold leading-none text-red cursor-pointer transition duration-150 enabled:hover:bg-red/15"
              aria-label="Close"
              @click="logModalOpen = false"
            >X</button>
          </div>
          <div class="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
            <div
              class="m-4 min-h-0 flex-1 overflow-auto rounded-xl border border-border bg-deepest p-4 font-mono text-[13px]"
              ref="modalLogEl"
            >
              <p v-for="entry in state.logEntries" :key="entry.id" class="my-1 leading-[1.4]" :class="logClass(entry.type)">{{ entry.message }}</p>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
