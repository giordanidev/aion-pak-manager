<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CheckUpdateResult, CpuEffort } from '../../shared/api-types'
import { useElectron } from '../composables/useElectron'

const props = defineProps<{
  open: boolean
  updateInfo: CheckUpdateResult | null
  checking: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'verify'): void
}>()

const { t } = useI18n()
const electron = useElectron()

const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

const rememberWindowBounds = ref(false)
const cpuEffort = ref<CpuEffort>('high')
const manualThreads = ref(1)
const totalThreads = ref(1)

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      window.addEventListener('keydown', onKeydown)
      try {
        const result = await electron.getSettings()
        if (result.success && result.settings) {
          rememberWindowBounds.value = result.settings.rememberWindowBounds === true
          cpuEffort.value = result.settings.cpuEffort ?? 'high'
          manualThreads.value =
            typeof result.settings.manualCpuThreads === 'number' && result.settings.manualCpuThreads >= 1
              ? Math.floor(result.settings.manualCpuThreads)
              : Math.max(1, Math.round((result.totalThreads ?? 1) * 0.9))
        }
        if (typeof result.totalThreads === 'number' && result.totalThreads >= 1) {
          totalThreads.value = Math.floor(result.totalThreads)
        }
        manualThreads.value = clampThreads(manualThreads.value)
      } catch {
        // ignore — keep current toggle state
      }
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
  }
)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

function onRememberChange(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  rememberWindowBounds.value = checked
  void electron.setSettings({ rememberWindowBounds: checked })
}

function clampThreads(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(1, Math.floor(value)), totalThreads.value)
}

const activeThreads = computed<number>(() => {
  const total = totalThreads.value
  switch (cpuEffort.value) {
    case 'low':
      return Math.max(1, Math.round(total * 0.3))
    case 'medium':
      return Math.max(1, Math.round(total * 0.6))
    case 'extreme':
      return total
    case 'manual':
      return clampThreads(manualThreads.value)
    default:
      return Math.max(1, Math.round(total * 0.9))
  }
})

function onEffortChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as CpuEffort
  cpuEffort.value = value
  void electron.setSettings({ cpuEffort: value })
}

function persistThreads(value: number): void {
  if (cpuEffort.value !== 'manual') return
  const clamped = clampThreads(value)
  manualThreads.value = clamped
  void electron.setSettings({ manualCpuThreads: clamped })
}

function onThreadsInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value)
  persistThreads(raw)
}

function incrementThreads(): void {
  persistThreads(manualThreads.value + 1)
}

function decrementThreads(): void {
  persistThreads(manualThreads.value - 1)
}

async function openReleases(): Promise<void> {
  try {
    await electron.openReleases()
  } catch {
    // ignore — nothing to report in UI
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 p-5"
    @pointerdown.self="emit('close')"
  >
    <div
      class="flex w-full max-w-[440px] flex-col rounded-xl border border-border bg-card shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
      role="dialog"
      aria-modal="true"
    >
      <div class="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h3 class="m-0 text-bright">{{ t('settings.title') }}</h3>
        <button
          class="inline-flex h-8 w-8 min-w-8 items-center justify-center rounded-lg border border-red bg-transparent p-0 text-[15px] font-bold leading-none text-red cursor-pointer transition duration-150 enabled:hover:bg-red/15"
          aria-label="Close"
          @click="emit('close')"
        >X</button>
      </div>

      <div class="flex flex-col gap-4 px-5 py-4">
        <label
          class="flex cursor-pointer select-none items-center justify-between gap-3 text-sm text-text"
          v-app-title="t('settings.rememberBoundsHint')"
        >
          <span>{{ t('settings.rememberBounds') }}</span>
          <span class="relative inline-flex flex-none">
            <input
              type="checkbox"
              class="peer sr-only"
              :checked="rememberWindowBounds"
              @change="onRememberChange"
            />
            <span class="h-5 w-9 flex-none rounded-full border border-border bg-card transition-colors peer-checked:border-accent peer-checked:bg-accent/25"></span>
            <span class="pointer-events-none absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-[#e9e9ff] transition-all peer-checked:left-[18px] peer-checked:bg-accent"></span>
          </span>
        </label>

        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-3">
            <label for="cpu-effort-select" class="text-sm text-text">{{ t('settings.cpuEffort') }}</label>
            <select
              id="cpu-effort-select"
              class="h-8 min-w-[200px] max-w-[240px] flex-1 cursor-pointer rounded-lg border border-border bg-card px-2.5 text-sm text-text outline-none transition duration-150 hover:bg-hover focus-visible:border-accent"
              :value="cpuEffort"
              @change="onEffortChange"
            >
              <option value="low">{{ t('settings.effortLow') }}</option>
              <option value="medium">{{ t('settings.effortMedium') }}</option>
              <option value="high">{{ t('settings.effortHigh') }}</option>
              <option value="extreme">{{ t('settings.effortExtreme') }}</option>
              <option value="manual">{{ t('settings.effortManual') }}</option>
            </select>
          </div>
          <div class="flex items-center justify-end">
            <div
              class="inline-flex h-8 flex-none items-stretch overflow-hidden rounded-lg border border-border bg-card text-sm"
              role="group"
              :aria-label="t('settings.threadsLabel')"
            >
              <span class="pointer-events-none flex select-none items-center px-2.5 text-dim">
                {{ t('settings.threadsLabel') }}
              </span>
              <input
                type="number"
                class="h-full w-14 border-0 border-l border-border bg-transparent px-1 text-center text-bright tabular-nums outline-none [appearance:textfield] focus-visible:bg-hover disabled:cursor-not-allowed disabled:text-dim disabled:focus-visible:bg-transparent [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                :min="1"
                :max="totalThreads"
                :value="activeThreads"
                :disabled="cpuEffort !== 'manual'"
                @change="onThreadsInput"
              />
              <span
                class="pointer-events-none flex select-none items-center border-l border-border px-2 text-dim tabular-nums"
              >/{{ totalThreads }}</span>
              <button
                type="button"
                class="w-8 flex-none cursor-pointer border-l border-border bg-transparent text-[15px] font-bold leading-none text-text transition duration-150 enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="cpuEffort !== 'manual' || manualThreads <= 1"
                aria-label="-"
                @click="decrementThreads"
              >-</button>
              <button
                type="button"
                class="w-8 flex-none cursor-pointer border-l border-border bg-transparent text-[15px] font-bold leading-none text-text transition duration-150 enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="cpuEffort !== 'manual' || manualThreads >= totalThreads"
                aria-label="+"
                @click="incrementThreads"
              >+</button>
            </div>
          </div>
          <p class="m-0 text-xs leading-relaxed text-dim">{{ t('settings.cpuEffortExplanation') }}</p>
        </div>

        <div class="mt-auto flex flex-col gap-3 rounded-lg border border-border bg-deepest px-3.5 py-3">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-semibold text-bright">{{ t('settings.update') }}</span>
            <span class="text-xs tabular-nums text-dim">v{{ appVersion }}</span>
          </div>
          <div
            class="text-[13px] break-all"
            :class="updateInfo?.updateAvailable ? 'text-accent-hover' : 'text-dim'"
          >
            <template v-if="checking">{{ t('settings.checking') }}</template>
            <template v-else-if="updateInfo?.updateAvailable">{{
              t('settings.updateAvailable', { version: updateInfo.latestVersion })
            }}</template>
            <template v-else-if="updateInfo && !updateInfo.success">{{
              t('settings.checkFailed', { error: updateInfo.error })
            }}</template>
            <template v-else-if="updateInfo?.latestVersion">{{
              t('settings.upToDate', { version: updateInfo.latestVersion })
            }}</template>
            <template v-else>{{ t('settings.checkIdle') }}</template>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2.5">
            <button
              class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-hover px-4 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-border"
              @click="openReleases"
            >
              {{ t('settings.openReleases') }}
            </button>
            <button
              class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white cursor-pointer transition duration-150 enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="checking"
              @click="emit('verify')"
            >
              <span
                v-if="checking"
                class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"
              ></span>
              {{ t('settings.verify') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
