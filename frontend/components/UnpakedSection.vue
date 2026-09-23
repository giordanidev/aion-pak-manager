<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PakEntry } from '../../shared/api-types'
import { getShowFileNames, useElectron } from '../composables/useElectron'
import { useAppState, basename, truncateMiddle } from '../composables/useAppState'
import PakContentsModal from './PakContentsModal.vue'
import DbModal from './DbModal.vue'

const { t } = useI18n()
const electron = useElectron()
const { state, log, clearLog, setProgress, setSummary, setActionRunning, refreshLists, setCustomDir, dirLabel } = useAppState()

const selectedFolderPaths = ref<string[]>([])
const activeTab = ref<'unpaked' | 'repaked'>('unpaked')
const repakedModalOpen = ref(false)
const repakedModalPath = ref<string | null>(null)
const repakedModalIsFolder = ref(false)
const unpakedModalOpen = ref(false)
const unpakedModalPath = ref<string | null>(null)
const dbOpen = ref(false)
const dbInitialPath = ref<string | null>(null)

function openFolderDb(dbPath: string): void {
  if (state.actionRunning) return
  dbInitialPath.value = dbPath
  dbOpen.value = true
}

function openRepakedContents(pak: PakEntry): void {
  if (state.actionRunning) return
  repakedModalPath.value = pak.fullPath
  repakedModalIsFolder.value = !isPakFile(pak)
  repakedModalOpen.value = true
}

function openUnpakedContents(folder: PakEntry): void {
  if (state.actionRunning) return
  unpakedModalPath.value = folder.fullPath
  unpakedModalOpen.value = true
}

function isPakFile(entry: PakEntry): boolean {
  return entry.fullPath.toLowerCase().endsWith('.pak')
}

async function onRepakedChanged(): Promise<void> {
  await refreshLists()
}

async function onRepakedDone(): Promise<void> {
  repakedModalOpen.value = false
  repakedModalPath.value = null
  repakedModalIsFolder.value = false
  await refreshLists()
}

interface FailureEntry {
  folderPath?: string
  folderName?: string
  pak?: string
  error: string
}

async function decryptSelectedUnpaked(): Promise<void> {
  const selected = Array.from(selectedFolderPaths.value)
  if (selected.length === 0) {
    log(t('unpaked.selectFirstDecrypt'), 'error')
    return
  }
  setActionRunning(true)
  clearLog()
  setSummary(t('unpaked.decryptingN', { n: selected.length }), 'info')
  log(t('unpaked.decryptingNLog', { n: selected.length }))
  try {
    const result = await electron.decryptUnpaked(selected, { showFileProgress: getShowFileNames() })
    if (result.success) {
      const successCount = result.results?.success.length ?? 0
      const failedCount = result.results?.failed.length ?? 0
      log(t('unpaked.decryptDone', { ok: successCount, fail: failedCount }), 'success')
      if (failedCount > 0) {
        result.results?.failed.forEach((fail) => {
          const entry = fail as FailureEntry
          log(t('unpaked.decryptFailItem', { path: entry.folderPath, error: entry.error }), 'error')
        })
        setSummary(t('unpaked.decryptFailSummary', { ok: successCount, fail: failedCount }), 'error')
      } else {
        setSummary(t('unpaked.decryptAllOk', { n: successCount }), 'success')
      }
    } else {
      log(t('pak.actionFailedOp', { error: result.error }), 'error')
      setSummary(t('unpaked.decryptFailTitle'), 'error')
    }
  } catch (err) {
    log(t('pak.unexpectedLog', { error: err instanceof Error ? err.message : String(err) }), 'error')
    setSummary(t('pak.unexpected'), 'error')
  } finally {
    setActionRunning(false)
    setProgress(0, t('progress.idle'))
    await refreshLists()
  }
}

async function repackSelectedUnpaked(): Promise<void> {
  const selected = Array.from(selectedFolderPaths.value)
  if (selected.length === 0) {
    log(t('unpaked.selectFirstRepak'), 'error')
    return
  }
  setActionRunning(true)
  clearLog()
  setSummary(t('unpaked.repakingN', { n: selected.length }), 'info')
  log(t('unpaked.repakingNLog', { n: selected.length }))
  try {
    const result = await electron.repackUnpaked({
      selectedFolderPaths: selected,
      showFileProgress: getShowFileNames(),
    })
    if (result.success) {
      const successCount = result.results?.success.length ?? 0
      const failedCount = result.results?.failed.length ?? 0
      log(t('unpaked.repakDone', { ok: successCount, fail: failedCount }), 'success')
      if (failedCount > 0) {
        result.results?.failed.forEach((fail) => {
          const entry = fail as FailureEntry
          log(t('unpaked.repakFailItem', { folder: entry.folderName || '', pak: entry.pak || '', error: entry.error }), 'error')
        })
        setSummary(t('pak.partialSummary', { ok: successCount, fail: failedCount }), 'error')
      } else {
        setSummary(t('unpaked.repakAllOk', { n: successCount }), 'success')
      }
    } else {
      log(t('pak.actionFailedOp', { error: result.error }), 'error')
      setSummary(t('unpaked.repakFailTitle'), 'error')
    }
  } catch (err) {
    log(t('pak.unexpectedLog', { error: err instanceof Error ? err.message : String(err) }), 'error')
    setSummary(t('pak.unexpected'), 'error')
  } finally {
    setActionRunning(false)
    setProgress(0, t('progress.idle'))
    await refreshLists()
  }
}

async function openUnpakedFolder(): Promise<void> {
  try {
    const custom = state.customDirs.unpaked
    const result = custom ? await electron.openFolder(custom) : await electron.openUnpakedFolder()
    if (!result.success) {
      log(t('unpaked.openRepaksFail', { error: result.error ?? 'error' }), 'error')
    }
  } catch (err) {
    log(t('unpaked.openRepaksFail', { error: err instanceof Error ? err.message : String(err) }), 'error')
  }
}

async function openRepakedFolder(): Promise<void> {
  try {
    const custom = state.customDirs.repaked
    const result = custom ? await electron.openFolder(custom) : await electron.openRepakedFolder()
    if (!result.success) {
      log(t('unpaked.openRepaksFail', { error: result.error ?? 'error' }), 'error')
    }
  } catch (err) {
    log(t('unpaked.openRepaksFail', { error: err instanceof Error ? err.message : String(err) }), 'error')
  }
}

const activeDirKey = computed<'unpaked' | 'repaked'>(() => (activeTab.value === 'repaked' ? 'repaked' : 'unpaked'))
const activeDir = computed(() => dirLabel(activeDirKey.value))
const activeDirShown = computed(() => truncateMiddle(activeDir.value))

async function changeActiveFolder(): Promise<void> {
  if (state.actionRunning || state.listsRefreshing) return
  try {
    const result = await electron.selectFolder()
    if (!result.success || !result.folderPath) return
    setCustomDir(activeDirKey.value, result.folderPath)
    await refreshLists()
  } catch (err) {
    log(t('unpaked.openRepaksFail', { error: err instanceof Error ? err.message : String(err) }), 'error')
  }
}

async function resetActiveFolder(): Promise<void> {
  if (state.actionRunning || state.listsRefreshing) return
  setCustomDir(activeDirKey.value, '')
  await refreshLists()
}
</script>

<template>
  <div class="flex min-h-0 flex-col overflow-hidden">
    <div class="relative z-[1] -mb-px flex items-end justify-between gap-3">
      <div class="inline-flex items-end gap-1">
        <button
          type="button"
          class="box-border inline-flex cursor-pointer items-center gap-2 rounded-t-[9px] border border-b-0 border-border px-3.5 pb-2 text-[13px] font-semibold transition duration-150 enabled:hover:bg-hover"
          :class="activeTab === 'unpaked' ? 'h-9 bg-card pt-2 text-bright' : 'h-8 bg-deepest pt-1 text-dim enabled:hover:text-text'"
          @click="activeTab = 'unpaked'"
        >
          <span>{{ t('unpaked.openUnpakeds') }}</span>
          <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-deepest px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums whitespace-nowrap text-bright">{{ state.unpakedFolders.length }}</span>
        </button>
        <button
          type="button"
          class="box-border inline-flex cursor-pointer items-center gap-2 rounded-t-[9px] border border-b-0 border-border px-3.5 pb-2 text-[13px] font-semibold transition duration-150 enabled:hover:bg-hover"
          :class="activeTab === 'repaked' ? 'h-9 bg-card pt-2 text-bright' : 'h-8 bg-deepest pt-1 text-dim enabled:hover:text-text'"
          @click="activeTab = 'repaked'"
        >
          <span>{{ t('unpaked.repaks') }}</span>
          <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-deepest px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums whitespace-nowrap text-bright">{{ state.repakedFiles.length }}</span>
        </button>
      </div>
      <div class="inline-flex items-center gap-2 self-start">
        <button
          class="box-border inline-flex h-[30px] w-[30px] min-w-[30px] items-center justify-center rounded-lg border border-border bg-hover p-0 text-dim cursor-pointer transition duration-150 enabled:hover:bg-border enabled:hover:text-bright disabled:cursor-not-allowed disabled:opacity-50"
          v-app-title="t('common.changeFolderFor', { target: activeTab === 'repaked' ? t('unpaked.repaks') : t('unpaked.openUnpakeds') })"
          @click="changeActiveFolder"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M1.6 4.1a1.1 1.1 0 0 1 1.1-1.1h2.9l1.3 1.5h6.4a1.1 1.1 0 0 1 1.1 1.1v1.6" />
            <path d="M1.6 4.1v7.6a1.1 1.1 0 0 0 1.1 1.1h5.1" />
            <path d="m12.4 8.6 2 2-3.9 3.9-2.2.4.4-2.2z" />
          </svg>
        </button>
        <button
          v-if="activeTab === 'unpaked'"
          class="box-border inline-flex h-[30px] items-center gap-2 rounded-lg border border-border bg-hover px-3 text-xs uppercase tracking-[0.3px] text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
          v-app-title="t('unpaked.openUnpakedsHint')"
          @click="openUnpakedFolder"
        >
          <span>{{ t('common.viewFiles') }}</span>
          <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-deepest px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums whitespace-nowrap text-bright">{{ state.unpakedFolders.length }}</span>
        </button>
        <button
          v-else
          class="box-border inline-flex h-[30px] items-center gap-2 rounded-lg border border-border bg-hover px-3 text-xs uppercase tracking-[0.3px] text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
          v-app-title="t('unpaked.repaksHint')"
          @click="openRepakedFolder"
        >
          <span>{{ t('common.viewFiles') }}</span>
          <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-deepest px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums whitespace-nowrap text-bright">{{ state.repakedFiles.length }}</span>
        </button>
      </div>
    </div>
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-tr-xl rounded-b-xl border border-border bg-card p-3.5 shadow-[0_2px_18px_rgba(0,0,0,0.25)]">
      <div class="mt-1 mb-3 flex items-center gap-2">
        <div class="min-w-0 flex-1 truncate text-sm text-dim" :title="activeDir">{{ t('pak.folderPath', { path: activeDirShown }) }}</div>
        <button
          v-if="state.customDirs[activeDirKey]"
          class="box-border inline-flex h-[26px] w-[26px] min-w-[26px] flex-none items-center justify-center rounded-lg border border-border bg-hover p-0 text-dim cursor-pointer transition duration-150 enabled:hover:bg-border enabled:hover:text-bright disabled:cursor-not-allowed disabled:opacity-50"
          v-app-title="t('common.restoreFolder')"
          @click="resetActiveFolder"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13 8a5 5 0 1 1-1.5-3.5" />
            <path d="M13 2.5V6H9.5" />
          </svg>
        </button>
      </div>
      <div v-if="activeTab === 'unpaked'" class="mb-2.5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-deepest">
        <div v-if="state.trScanFailed"></div>
        <div v-else-if="state.trLoaded && state.unpakedFolders.length === 0" class="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 text-orange">
          {{ t('unpaked.empty') }}
        </div>
        <TransitionGroup v-else-if="state.trLoaded" name="list" tag="div" class="relative">
          <div v-for="folder in state.unpakedFolders" :key="folder.fullPath" class="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 last:border-b-0 hover:bg-hover">
            <label class="relative flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2.5 text-text">
              <input
                type="checkbox"
                class="peer sr-only"
                :value="folder.fullPath"
                v-model="selectedFolderPaths"
                :disabled="state.actionRunning"
              />
              <span class="h-5 w-9 flex-none rounded-full border border-border bg-card transition-colors peer-checked:border-accent peer-checked:bg-accent/25 peer-disabled:opacity-50"></span>
              <span class="pointer-events-none absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-[#e9e9ff] transition-all peer-checked:left-[18px] peer-checked:bg-accent"></span>
              <span class="min-w-0 flex-1 truncate" :title="folder.fullPath">{{ basename(folder.fullPath) }}</span>
            </label>
            <span v-if="folder.fileCountLoading" class="whitespace-nowrap text-xs text-dim"><span class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span></span>
            <span v-else-if="folder.fileCount != null" class="whitespace-nowrap text-xs text-dim">{{ t('common.filesSuffix', { n: folder.fileCount }) }}</span>
            <button
              v-if="folder.dbPath"
              type="button"
              class="inline-flex h-6 w-6 min-w-6 flex-none items-center justify-center rounded-md border border-border bg-card p-0 text-text cursor-pointer transition duration-150 enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="state.actionRunning"
              v-app-title="t('unpaked.dbStructureHint')"
              @click.stop="openFolderDb(folder.dbPath)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <ellipse cx="8" cy="3.5" rx="5" ry="2" stroke="currentColor" stroke-width="1.6" />
                <path d="M3 5.5v7c0 1.1 2.24 2 5 2s5-.9 5-2v-7" stroke="currentColor" stroke-width="1.6" />
                <path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" stroke="currentColor" stroke-width="1.6" />
              </svg>
            </button>
            <button
              v-if="!folder.dbPath"
              type="button"
              class="inline-flex h-6 w-6 min-w-6 flex-none items-center justify-center rounded-md border border-border bg-card p-0 text-text cursor-pointer transition duration-150 enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="state.actionRunning"
              v-app-title="t('app.openDbStructure')"
              @click.stop="openUnpakedContents(folder)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M1.6 4.1a1.1 1.1 0 0 1 1.1-1.1h2.9l1.3 1.5h6.4a1.1 1.1 0 0 1 1.1 1.1v6.6a1.1 1.1 0 0 1-1.1 1.1H2.7a1.1 1.1 0 0 1-1.1-1.1z" />
              </svg>
            </button>
          </div>
        </TransitionGroup>
      </div>

      <div v-else class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-deepest">
        <div v-if="state.trScanFailed"></div>
        <div v-else-if="state.trLoaded && state.repakedFiles.length === 0" class="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 text-orange">
          {{ t('unpaked.emptyRepaked') }}
        </div>
        <TransitionGroup v-else-if="state.trLoaded" name="list" tag="div" class="relative">
          <div v-for="pak in state.repakedFiles" :key="pak.fullPath" class="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 last:border-b-0 hover:bg-hover">
            <span class="min-w-0 flex-1 truncate text-text" :title="pak.fullPath">{{ basename(pak.fullPath) }}</span>
            <div class="flex flex-none items-center gap-2">
              <span v-if="pak.fileCountLoading" class="whitespace-nowrap text-xs text-dim"><span class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span></span>
              <span v-else-if="pak.fileCount != null" class="whitespace-nowrap text-xs text-dim">{{ t('common.filesSuffix', { n: pak.fileCount }) }}</span>
              <button
                v-if="pak.fileCount != null && !pak.fileCountLoading"
                type="button"
                class="inline-flex h-6 w-6 min-w-6 items-center justify-center rounded-md border border-border bg-card p-0 text-text cursor-pointer transition duration-150 enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="state.actionRunning"
                v-app-title="t('pak.viewRepakedContentsHint')"
                @click.stop="openRepakedContents(pak)"
              >
                <svg v-if="!isPakFile(pak)" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M1.6 4.1a1.1 1.1 0 0 1 1.1-1.1h2.9l1.3 1.5h6.4a1.1 1.1 0 0 1 1.1 1.1v6.6a1.1 1.1 0 0 1-1.1 1.1H2.7a1.1 1.1 0 0 1-1.1-1.1z" />
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.4" />
                  <path d="M10.4 10.4 14 14" />
                </svg>
              </button>
            </div>
          </div>
        </TransitionGroup>
      </div>

      <div v-if="activeTab === 'unpaked'" class="flex-none">
        <div class="flex items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-3">
            <button
              class="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm text-white cursor-pointer transition duration-150 enabled:hover:-translate-y-px enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-[#555] disabled:opacity-50"
              :disabled="state.actionRunning"
              @click="decryptSelectedUnpaked"
            >{{ t('unpaked.decrypt') }}</button>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <button
              class="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm text-white cursor-pointer transition duration-150 enabled:hover:-translate-y-px enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-[#555] disabled:opacity-50"
              :disabled="state.actionRunning"
              @click="repackSelectedUnpaked"
            >{{ t('unpaked.repak') }}</button>
          </div>
        </div>
      </div>
    </div>

    <PakContentsModal
      :open="repakedModalOpen"
      :pak-path="repakedModalPath"
      source="repaked"
      :structure-only="repakedModalIsFolder"
      @close="repakedModalOpen = false"
      @done="onRepakedDone"
      @changed="onRepakedChanged"
    />

    <PakContentsModal
      :open="unpakedModalOpen"
      :pak-path="unpakedModalPath"
      source="unpaked"
      structure-only
      @close="unpakedModalOpen = false"
    />

    <DbModal :open="dbOpen" :initial-db-path="dbInitialPath" @close="dbOpen = false" />
  </div>
</template>
