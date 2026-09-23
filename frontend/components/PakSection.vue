<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExtractFolderPayload, OperationFailure, PakEntry } from '../../shared/api-types'
import { getShowFileNames, useElectron } from '../composables/useElectron'
import { useAppState, basename, truncateMiddle, formatBytes } from '../composables/useAppState'
import PakContentsModal from './PakContentsModal.vue'

const { t } = useI18n()
const electron = useElectron()
const { state, log, clearLog, setProgress, resetProgressBar, setSummary, setActionRunning, refreshLists, setCustomDir, dirLabel } = useAppState()

interface PakListEntry extends PakEntry {
  isDir: boolean
}

const selectedPaths = ref<string[]>([])
const decryptAfterUnpak = ref(false)
const pakContentsOpen = ref(false)
const pakContentsPath = ref<string | null>(null)

// Single merged list: first-level folders of /PAKS/pak followed by loose .pak
// files, so the whole extraction target is visible without a mode toggle.
const entries = computed<PakListEntry[]>(() => [
  ...state.rootFolders.map((entry) => ({ ...entry, isDir: true })),
  ...state.pakFiles.map((entry) => ({ ...entry, isDir: false })),
])
const listCount = (): number => entries.value.length

function formatEntrySize(entry: PakListEntry): string {
  return entry.isDir ? formatBytes(entry.sizeBytes) : ''
}

function openPakContents(entry: { fullPath: string }): void {
  if (state.actionRunning) return
  pakContentsPath.value = entry.fullPath
  pakContentsOpen.value = true
}

async function onPakContentsDone(): Promise<void> {
  pakContentsOpen.value = false
  pakContentsPath.value = null
  await refreshLists()
}

async function openPakFolder(): Promise<void> {
  try {
    const custom = state.customDirs.pak
    const result = custom ? await electron.openFolder(custom) : await electron.openPakFolder()
    if (!result.success) {
      log(`PAKS: ${result.error ?? 'error'}`, 'error')
    }
  } catch (err) {
    log(`PAKS: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

const pakDir = computed(() => dirLabel('pak'))
const pakDirShown = computed(() => truncateMiddle(pakDir.value))

async function changePakFolder(): Promise<void> {
  if (state.actionRunning || state.listsRefreshing) return
  try {
    const result = await electron.selectFolder()
    if (!result.success || !result.folderPath) return
    setCustomDir('pak', result.folderPath)
    await refreshLists()
  } catch (err) {
    log(`PAKS: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

async function resetPakFolder(): Promise<void> {
  if (state.actionRunning || state.listsRefreshing) return
  setCustomDir('pak', '')
  await refreshLists()
}

async function unpackSelected(): Promise<void> {
  const selected = new Set(selectedPaths.value)
  const folders = state.rootFolders.filter((entry) => selected.has(entry.fullPath)).map((entry) => entry.fullPath)
  const paks = state.pakFiles.filter((entry) => selected.has(entry.fullPath)).map((entry) => entry.fullPath)

  if (folders.length === 0 && paks.length === 0) {
    log(t('pak.selectFirst'), 'error')
    return
  }

  setActionRunning(true)
  clearLog()
  try {
    let totalExtracted = 0
    let canceled = false

    for (let i = 0; i < folders.length; i++) {
      const inputFolder = folders[i] as string
      const payload: ExtractFolderPayload = {
        inputFolder,
        includeNonPak: true,
        overwrite: false,
        showFileProgress: getShowFileNames(),
        unpakedDir: state.customDirs.unpaked || undefined,
        pakDir: state.customDirs.pak || undefined,
      }

      setSummary(t('pak.extractingFolder', { i: i + 1, total: folders.length }), 'info')
      log(t('pak.extractingFolderLog', { i: i + 1, total: folders.length, folder: inputFolder }))
      resetProgressBar()
      const result = await electron.extractFolder(payload)
      if (result.canceled) {
        canceled = true
        log(t('pak.extractionCanceled'), 'warning')
        setSummary(t('pak.extractionCanceled'), 'info')
        break
      }
      if (!result.success) {
        setSummary(result.error || t('pak.extractFailed'), 'error')
        log(t('pak.extractFailedLog', { error: result.error }), 'error')
        break
      }
      const extracted = result.results?.paksExtracted ?? 0
      const skipped = result.results?.skippedExisting ?? []
      totalExtracted += extracted
      const skippedNote = skipped.length > 0 ? ` ${t('pak.skippedIgnored', { n: skipped.length })}` : ''
      log(`${t('pak.extractDoneLog', { n: extracted, out: result.results?.outputFolder })}${skippedNote}`, 'success')
    }

    if (!canceled && paks.length > 0) {
      const shouldDecrypt = decryptAfterUnpak.value
      const actionText = shouldDecrypt ? t('pak.extractingDecrypting') : t('pak.extracting')
      resetProgressBar()
      setSummary(
        shouldDecrypt ? t('pak.extractingDecryptingN', { n: paks.length }) : t('pak.extractingN', { n: paks.length }),
        'info',
      )
      log(
        shouldDecrypt
          ? t('pak.extractingDecryptingNLog', { n: paks.length })
          : t('pak.extractingNLog', { n: paks.length }),
      )
      const result = shouldDecrypt
        ? await electron.unpakDecryptPackages(paks, {
            showFileProgress: getShowFileNames(),
            unpakedDir: state.customDirs.unpaked || undefined,
            pakDir: state.customDirs.pak || undefined,
          })
        : await electron.unpakPackages(paks, {
            showFileProgress: getShowFileNames(),
            unpakedDir: state.customDirs.unpaked || undefined,
            pakDir: state.customDirs.pak || undefined,
          })
      if (result.success) {
        const successCount = result.results?.success.length ?? 0
        const failedCount = result.results?.failed.length ?? 0
        log(t('pak.actionDone', { action: actionText, ok: successCount, fail: failedCount }), 'success')
        if (failedCount > 0) {
          result.results?.failed.forEach((fail) => {
            const entry = fail as OperationFailure
            log(t('pak.failedItem', { name: entry.packageName, error: entry.error }), 'error')
          })
          setSummary(t('pak.partialSummary', { ok: successCount, fail: failedCount }), 'error')
        } else {
          setSummary(t('pak.allOk', { n: successCount }), 'success')
        }
      } else if (result.canceled) {
        canceled = true
        log(t('pak.extractionCanceled'), 'warning')
        setSummary(t('pak.extractionCanceled'), 'info')
      } else {
        log(t('pak.actionFailedOp', { error: result.error }), 'error')
        setSummary(t('pak.extractFailed'), 'error')
      }
    }

    if (!canceled && folders.length > 0 && paks.length === 0) {
      setSummary(t('pak.extractedSummary', { n: totalExtracted, m: folders.length }), 'success')
    }
  } catch (err) {
    log(t('pak.unexpectedLog', { error: err instanceof Error ? err.message : String(err) }), 'error')
    setSummary(t('pak.unexpected'), 'error')
  } finally {
    setActionRunning(false)
    setProgress(0, t('progress.idle'))
    selectedPaths.value = []
    await refreshLists()
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card p-3.5 shadow-[0_2px_18px_rgba(0,0,0,0.25)]">
    <div class="mb-1 flex flex-none items-center justify-between gap-3">
      <h2 class="m-0 text-[17px] font-bold text-bright">{{ t('pak.title') }}</h2>
      <div class="flex items-center gap-3">
        <button
          class="box-border inline-flex h-[30px] w-[30px] min-w-[30px] items-center justify-center rounded-lg border border-border bg-hover p-0 text-dim cursor-pointer transition duration-150 enabled:hover:bg-border enabled:hover:text-bright disabled:cursor-not-allowed disabled:opacity-50"
          v-app-title="t('common.changeFolderFor', { target: t('pak.openPaks') })"
          @click="changePakFolder"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M1.6 4.1a1.1 1.1 0 0 1 1.1-1.1h2.9l1.3 1.5h6.4a1.1 1.1 0 0 1 1.1 1.1v1.6" />
            <path d="M1.6 4.1v7.6a1.1 1.1 0 0 0 1.1 1.1h5.1" />
            <path d="m12.4 8.6 2 2-3.9 3.9-2.2.4.4-2.2z" />
          </svg>
        </button>
        <button
          class="box-border inline-flex h-[30px] items-center gap-2 rounded-lg border border-border bg-hover px-3 text-xs uppercase tracking-[0.3px] text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
          v-app-title="t('pak.openPaksHint')"
          @click="openPakFolder"
        >
          <span>{{ t('common.viewFiles') }}</span>
          <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-deepest px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums whitespace-nowrap text-bright">{{ listCount() }}</span>
        </button>
      </div>
    </div>
    <div class="mt-1 mb-3 flex items-center gap-2">
      <div class="min-w-0 flex-1 truncate text-sm text-dim" :title="pakDir">{{ t('pak.folderPath', { path: pakDirShown }) }}</div>
      <button
        v-if="state.customDirs.pak"
        class="box-border inline-flex h-[26px] w-[26px] min-w-[26px] flex-none items-center justify-center rounded-lg border border-border bg-hover p-0 text-dim cursor-pointer transition duration-150 enabled:hover:bg-border enabled:hover:text-bright disabled:cursor-not-allowed disabled:opacity-50"
        v-app-title="t('common.restoreFolder')"
        @click="resetPakFolder"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.5-3.5" />
          <path d="M13 2.5V6H9.5" />
        </svg>
      </button>
    </div>

    <div class="mb-2.5 min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-deepest">
      <div v-if="state.pakScanFailed"></div>
      <div v-else-if="state.pakLoaded && entries.length === 0" class="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 text-orange">
        {{ t('pak.emptyEntries', { pakDir }) }}
      </div>
      <TransitionGroup v-else-if="state.pakLoaded" name="list" tag="div" class="relative">
        <div v-for="entry in entries" :key="entry.fullPath" class="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 last:border-b-0 hover:bg-hover">
          <label class="relative flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2.5 text-text">
            <input
              type="checkbox"
              class="peer sr-only"
              :value="entry.fullPath"
              v-model="selectedPaths"
              :disabled="state.actionRunning"
            />
            <span class="h-5 w-9 flex-none rounded-full border border-border bg-card transition-colors peer-checked:border-accent peer-checked:bg-accent/25 peer-disabled:opacity-50"></span>
            <span class="pointer-events-none absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-[#e9e9ff] transition-all peer-checked:left-[18px] peer-checked:bg-accent"></span>
            <span class="min-w-0 flex-1 truncate" :title="entry.fullPath">{{ basename(entry.fullPath) }}</span>
          </label>
          <div class="flex flex-none items-center gap-2">
            <span v-if="entry.fileCountLoading" class="whitespace-nowrap text-xs text-dim"><span class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span></span>
            <span v-else-if="entry.fileCount != null" class="whitespace-nowrap text-xs text-dim">
              <template v-if="formatEntrySize(entry)">{{ formatEntrySize(entry) }} • </template>{{ t('common.filesSuffix', { n: entry.fileCount }) }}
            </span>
            <button
              v-if="entry.fileCount != null && !entry.fileCountLoading"
              type="button"
              class="inline-flex h-6 w-6 min-w-6 items-center justify-center rounded-md border border-border bg-card p-0 text-text cursor-pointer transition duration-150 enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="state.actionRunning"
              v-app-title="entry.isDir ? t('pak.viewFolderContentsHint') : t('pak.viewContentsHint')"
              @click.stop="openPakContents(entry)"
            >
              <svg v-if="entry.isDir" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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

    <div class="flex flex-none items-center justify-end gap-3">
      <label
        class="relative inline-flex cursor-pointer select-none items-center gap-2 text-[13px] text-text has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50"
        v-app-title="t('pak.decryptAfterHint')"
      >
        <input type="checkbox" class="peer sr-only" v-model="decryptAfterUnpak" :disabled="state.actionRunning" />
        <span class="h-5 w-9 flex-none rounded-full border border-border bg-card transition-colors peer-checked:border-accent peer-checked:bg-accent/25"></span>
        <span class="pointer-events-none absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-[#e9e9ff] transition-all peer-checked:left-[18px] peer-checked:bg-accent"></span>
        <span>{{ t('pak.decryptAfter') }}</span>
      </label>
      <button
        class="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm text-white cursor-pointer transition duration-150 enabled:hover:-translate-y-px enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-[#555] disabled:opacity-50"
        :disabled="state.actionRunning"
        @click="unpackSelected"
      >{{ t('pak.unpak') }}</button>
    </div>
    <PakContentsModal
      :open="pakContentsOpen"
      :pak-path="pakContentsPath"
      @close="pakContentsOpen = false"
      @done="onPakContentsDone"
    />
  </div>
</template>
