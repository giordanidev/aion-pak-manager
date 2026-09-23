<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElectron } from '../composables/useElectron'
import { useAppState, formatBytes } from '../composables/useAppState'

const { t } = useI18n()
const electron = useElectron()
const { state, log, setSummary } = useAppState()

const stopping = ref(false)

function formatSeconds(value: number | null): string {
  if (value == null || value < 0) return '--'
  const s = Math.max(0, Math.floor(value))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`
  return `${m}:${pad(sec)}`
}

const elapsedText = computed(() => {
  if (state.progressStartedAt == null && !state.actionRunning) return '--'
  if (state.progressStartedAt == null) return '--'
  return formatSeconds(state.progressElapsedSeconds)
})

const remainingText = computed(() => {
  const v = state.progressRemainingSeconds
  if (v == null) return '--'
  return formatSeconds(v)
})

const speedText = computed(() => {
  const v = state.progressSpeedMBs
  if (v == null || v <= 0) return '--'
  return `${v.toFixed(1)} MB/s`
})

const totalText = computed(() => {
  const v = state.progressBytesTotal
  if (v == null || v <= 0) return '--'
  return formatBytes(v)
})

const percentText = computed(() => {
  const v = state.progressPercent
  if (v == null || Number.isNaN(v)) return '0%'
  const rounded = Math.round(v * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
})

async function cancelCurrentAction(): Promise<void> {
  if (stopping.value || !state.actionRunning) {
    return
  }
  stopping.value = true
  setSummary(t('progress.canceling'), 'info')
  log(t('progress.stopRequested'), 'info')
  try {
    const result = await electron.cancelAction()
    if (!result.success) {
      log(t('progress.cancelFailed', { error: result.error }), 'error')
      setSummary(result.error || t('progress.cancelFailSummary'), 'error')
    }
  } catch (err) {
    log(t('progress.cancelError', { error: err instanceof Error ? err.message : String(err) }), 'error')
    setSummary(t('progress.cancelFailSummary'), 'error')
  } finally {
    stopping.value = false
  }
}
</script>

<template>
  <div class="flex h-auto flex-none flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-3.5 shadow-[0_2px_18px_rgba(0,0,0,0.25)]">
    <h2 class="m-0 text-[17px] font-bold text-bright">{{ t('progress.title') }}</h2>
    <div class="relative h-8 w-full flex-none overflow-hidden rounded-2xl border border-border bg-deepest">
      <div class="h-full bg-accent transition-[width] duration-[250ms]" :style="{ width: `${state.progressPercent}%` }"></div>
      <div class="pointer-events-none absolute inset-0 z-[1] flex items-center justify-between gap-3 px-3">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <span
            v-if="state.actionRunning || state.listsRefreshing"
            class="inline-block h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-border border-t-accent"
          ></span>
          <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-bold text-bright [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">{{ state.progressText }}</span>
        </div>
        <span class="flex-none whitespace-nowrap text-[13px] font-bold tabular-nums text-bright [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">{{ percentText }}</span>
      </div>
    </div>
    <div class="flex flex-none flex-wrap items-center justify-between gap-3">
      <div class="flex flex-none items-center gap-1.5 whitespace-nowrap text-xs text-dim">
        <span>{{ t('progress.elapsed', { value: elapsedText }) }}</span>
        <span class="opacity-60">·</span>
        <span>{{ t('progress.remaining', { value: remainingText }) }}</span>
        <span class="opacity-60">·</span>
        <span>{{ t('progress.speed', { value: speedText }) }}</span>
        <span class="opacity-60">·</span>
        <span>{{ t('progress.total', { value: totalText }) }}</span>
      </div>
      <button
        class="box-border inline-flex h-9 items-center justify-center rounded-lg bg-red px-4 py-2 text-sm text-white cursor-pointer transition duration-150 enabled:hover:bg-[#f87171] disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!state.actionRunning || stopping"
        @click="cancelCurrentAction"
      >
        {{ t('progress.stop') }}
      </button>
    </div>
  </div>
</template>
