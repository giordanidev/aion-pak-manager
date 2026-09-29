import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PakEntry, ProgressPayload } from '../../shared/api-types'
import { getShowFileNames, useElectron } from './useElectron'

export type LogType = 'info' | 'success' | 'warning' | 'error'

export interface LogEntry {
  id: number
  type: LogType
  message: string
}

let logId = 0

// Per-list generation token: a refresh that starts a newer count request
// invalidates any still in-flight response for that list.
const countGenerations: Record<'pakFiles' | 'rootFolders' | 'unpakedFolders' | 'repakedFiles', number> = {
  pakFiles: 0,
  rootFolders: 0,
  unpakedFolders: 0,
  repakedFiles: 0,
}

export type ListKey = 'pak' | 'unpaked' | 'repaked'

export const DEFAULT_DIR_LABELS: Record<ListKey, string> = {
  pak: '/PAKS/pak',
  unpaked: '/PAKS/unpaked',
  repaked: '/PAKS/repaked',
}

const DIR_STORAGE_KEYS: Record<ListKey, string> = {
  pak: 'aion-dir-pak',
  unpaked: 'aion-dir-unpaked',
  repaked: 'aion-dir-repaked',
}

function readStoredDir(key: ListKey): string {
  try {
    return localStorage.getItem(DIR_STORAGE_KEYS[key]) ?? ''
  } catch {
    return ''
  }
}

const state = reactive({
  progressPercent: 0,
  progressText: '',
  summaryText: '',
  summaryType: 'info' as LogType,
  actionRunning: false,
  listsRefreshing: false,
  pakFiles: [] as PakEntry[],
  rootFolders: [] as PakEntry[],
  unpakedFolders: [] as PakEntry[],
  repakedFiles: [] as PakEntry[],
  repakedCount: 0,
  customDirs: {
    pak: readStoredDir('pak'),
    unpaked: readStoredDir('unpaked'),
    repaked: readStoredDir('repaked'),
  } as Record<ListKey, string>,
  pakScanFailed: false,
  trScanFailed: false,
  pakLoaded: false,
  trLoaded: false,
  logEntries: [] as LogEntry[],
  progressStartedAt: null as number | null,
  progressElapsedSeconds: 0,
  progressRemainingSeconds: null as number | null,
  progressSpeedMBs: null as number | null,
  progressBytesTotal: 0,
  /** Outer multi-selection context (e.g. folder 2 of 3) for progress text. */
  progressBatch: null as { index: number; total: number; label?: string } | null,
})

let progressTimer: ReturnType<typeof setInterval> | null = null
let wasCanceled = false
// Accumulated bytes read during the current action (sum of ProgressPayload.bytesDelta).
let progressBytesRead = 0
/** Recent byte samples for a live MB/s window (not lifetime average). */
let speedSamples: { t: number; bytes: number }[] = []
const SPEED_WINDOW_MS = 2000
// Single monotonic high-water for the whole action: the bar must never regress
// and must not reset on stage boundaries (unpack -> decrypt -> repak).
let actionHighWater = 0

function clampProgress(percent: number): number {
  const clamped = Math.max(0, Math.min(percent, 100))
  if (clamped > actionHighWater) actionHighWater = clamped
  return Math.round(actionHighWater * 10) / 10
}

// Fallback for backends that emit a per-task percent (0-100 within one task):
// folds it into a global percent using the task index/total.
function unpakGlobalPercent(packageIndex: number, packageTotal: number, pakPercent: number): number {
  const total = packageTotal > 0 ? packageTotal : 1
  if (total <= 1) {
    return Math.max(0, Math.min(pakPercent, 100))
  }
  const idx = Math.max(1, Math.min(packageIndex, total))
  const pak = Math.max(0, Math.min(pakPercent, 100))
  return ((idx - 1 + pak / 100) / total) * 100
}

function updateRemainingEstimate(): void {
  if (!state.actionRunning || state.progressStartedAt == null) {
    if (state.progressStartedAt == null && state.actionRunning) {
      state.progressRemainingSeconds = null
    }
    return
  }
  const p = state.progressPercent
  const e = state.progressElapsedSeconds
  if (p > 0 && p < 100 && e > 0) {
    const total = (e * 100) / p
    const rem = Math.round(total - e)
    state.progressRemainingSeconds = rem >= 0 ? rem : null
  } else if (p >= 100) {
    state.progressRemainingSeconds = 0
  } else {
    state.progressRemainingSeconds = null
  }
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`
  return `${m}:${pad(sec)}`
}

function noteSpeedBytes(delta: number): void {
  if (!(delta > 0)) return
  const now = Date.now()
  speedSamples.push({ t: now, bytes: delta })
  const cutoff = now - SPEED_WINDOW_MS
  while (speedSamples.length > 0 && speedSamples[0]!.t < cutoff) speedSamples.shift()
}

function refreshLiveSpeed(): void {
  const now = Date.now()
  const cutoff = now - SPEED_WINDOW_MS
  while (speedSamples.length > 0 && speedSamples[0]!.t < cutoff) speedSamples.shift()
  state.progressBytesTotal = progressBytesRead
  if (speedSamples.length === 0) {
    if (progressBytesRead <= 0) state.progressSpeedMBs = null
    return
  }
  const bytes = speedSamples.reduce((sum, s) => sum + s.bytes, 0)
  const elapsedSec = Math.max(0.001, (now - speedSamples[0]!.t) / 1000)
  state.progressSpeedMBs = Math.round((bytes / elapsedSec / (1024 * 1024)) * 10) / 10
}

function startProgressTiming(): void {
  wasCanceled = false
  progressBytesRead = 0
  speedSamples = []
  actionHighWater = 0
  state.progressStartedAt = Date.now()
  state.progressElapsedSeconds = 0
  state.progressRemainingSeconds = null
  state.progressSpeedMBs = null
  state.progressBytesTotal = 0
  state.progressBatch = null
  if (progressTimer) clearInterval(progressTimer)
  progressTimer = setInterval(() => {
    if (state.progressStartedAt != null) {
      state.progressElapsedSeconds = Math.floor((Date.now() - state.progressStartedAt) / 1000)
      if (progressBytesRead > 0) refreshLiveSpeed()
      updateRemainingEstimate()
    }
  }, 500)
}

function stopProgressTiming(): void {
  const hadTimer = progressTimer != null
  if (progressTimer) {
    clearInterval(progressTimer)
    progressTimer = null
  }
  if (!hadTimer) return
  if (state.progressStartedAt != null) {
    state.progressElapsedSeconds = Math.floor((Date.now() - state.progressStartedAt) / 1000)
  }
  if (wasCanceled) {
    state.progressRemainingSeconds = null
  } else {
    state.progressRemainingSeconds = 0
  }
  state.progressSpeedMBs = null
}

export function basename(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? fullPath
}

/** Truncates a long path in the middle, keeping head and tail. */
export function truncateMiddle(text: string, max = 56): string {
  if (text.length <= max) return text
  const keep = Math.floor((max - 1) / 2)
  const tail = max - 1 - keep
  return `${text.slice(0, keep)}…${text.slice(text.length - tail)}`
}

/** Human-readable byte size (MB/GB and smaller units), empty for invalid input. */
export function formatBytes(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

export function useAppState() {
  let t: (key: string, params?: Record<string, unknown>) => string
  try {
    const { t: translate } = useI18n()
    t = (key: string, params?: Record<string, unknown>) => translate(key, params as never) as unknown as string
  } catch {
    t = (key: string) => key
  }

  if (!state.progressText || ['Ocioso', 'Pronto', 'Idle', 'Ready', 'Inactivo', 'Listo'].includes(state.progressText)) {
    state.progressText = t('progress.idle')
  }

  function log(message: string, type: LogType = 'info'): void {
    state.logEntries.push({ id: ++logId, type, message })
    // Cap DOM growth: keep last 2000 entries, but never drop error/warning.
    const MAX_LOG_ENTRIES = 2000
    if (state.logEntries.length > MAX_LOG_ENTRIES) {
      let excess = state.logEntries.length - MAX_LOG_ENTRIES
      for (let i = 0; i < state.logEntries.length && excess > 0; ) {
        const entry = state.logEntries[i]
        if (entry.type === 'error' || entry.type === 'warning') {
          i++
          continue
        }
        state.logEntries.splice(i, 1)
        excess--
      }
    }
  }

  function clearLog(): void {
    state.logEntries = []
  }

  function setProgress(percent: number, text: string): void {
    state.progressPercent = Math.max(0, Math.min(percent, 100))
    state.progressText = text
    if (state.progressStartedAt != null && state.actionRunning) {
      state.progressElapsedSeconds = Math.floor((Date.now() - state.progressStartedAt) / 1000)
    }
    updateRemainingEstimate()
  }

  /** Clears the monotonic high-water so a new sub-operation restarts at 0%. */
  function resetProgressBar(): void {
    actionHighWater = 0
    state.progressPercent = 0
    state.progressRemainingSeconds = null
  }

  function setSummary(text: string, type: LogType = 'info'): void {
    state.summaryText = text
    state.summaryType = type
  }

  function setActionRunning(running: boolean): void {
    const wasRunning = state.actionRunning
    state.actionRunning = running
    if (running) {
      startProgressTiming()
    } else {
      if (wasRunning) {
        const elapsedSec =
          state.progressStartedAt != null
            ? Math.max(0, Math.floor((Date.now() - state.progressStartedAt) / 1000))
            : state.progressElapsedSeconds
        const speed =
          progressBytesRead > 0 && elapsedSec > 0
            ? `${(progressBytesRead / elapsedSec / (1024 * 1024)).toFixed(1)} MB/s`
            : '--'
        const size = progressBytesRead > 0 ? formatBytes(progressBytesRead) : '--'
        log(t('progress.actionSummary', { elapsed: formatDuration(elapsedSec), speed, size }), 'info')
      }
      stopProgressTiming()
      progressBytesRead = 0
      speedSamples = []
    }
  }

  function setListsRefreshing(refreshing: boolean): void {
    state.listsRefreshing = refreshing
  }

  function reconcileList(previous: PakEntry[], incoming: PakEntry[]): PakEntry[] {
    const prevByPath = new Map(previous.map((entry) => [entry.fullPath, entry]))
    return incoming.map((entry) => {
      const prev = prevByPath.get(entry.fullPath)
      if (!prev) {
        return { ...entry, fileCountLoading: true }
      }
      // Same fullPath: keep the previous entry data (label may change) but
      // preserve the resolved count/size/loading state so it is not re-fetched.
      return {
        ...entry,
        fileCount: prev.fileCount,
        sizeBytes: prev.sizeBytes,
        fileCountLoading: prev.fileCountLoading ?? false,
      }
    })
  }

  function countLoadingPaths(entries: PakEntry[]): string[] {
    return entries.filter((entry) => entry.fileCountLoading).map((entry) => entry.fullPath)
  }

  async function loadEntryCounts(
    paths: string[],
    kind: 'pak' | 'pakFolder' | 'folder' | 'repaked',
    target: 'pakFiles' | 'rootFolders' | 'unpakedFolders' | 'repakedFiles',
    generation: number,
    base?: string,
    force = false,
  ): Promise<void> {
    if (paths.length === 0) return
    const electron = useElectron()
    // One IPC per path so a huge folder never holds up the rest of the list.
    await Promise.all(
      paths.map(async (entryPath) => {
        let result
        try {
          result = await electron.countEntries([entryPath], kind, base, { force })
        } catch {
          result = null
        }
        if (generation !== countGenerations[target]) return
        const count = result?.success ? result.counts?.[entryPath] : null
        const size = result?.success ? result.sizes?.[entryPath] : undefined
        state[target] = state[target].map((entry) => {
          if (entry.fullPath !== entryPath) return entry
          return count == null
            ? { ...entry, fileCountLoading: false }
            : {
                ...entry,
                fileCount: count,
                sizeBytes: typeof size === 'number' ? size : undefined,
                fileCountLoading: false,
              }
        })
      }),
    )
  }

  async function recountAllCounts(): Promise<void> {
    const electron = useElectron()
    try {
      await electron.clearEntryCountCache()
    } catch {
      // continue — still force a filesystem walk via force:true
    }
    const markLoading = (entries: PakEntry[]): PakEntry[] =>
      entries.map((entry) => ({ ...entry, fileCount: undefined, sizeBytes: undefined, fileCountLoading: true }))
    state.pakFiles = markLoading(state.pakFiles)
    state.rootFolders = markLoading(state.rootFolders)
    state.unpakedFolders = markLoading(state.unpakedFolders)
    state.repakedFiles = markLoading(state.repakedFiles)
    void loadEntryCounts(
      state.pakFiles.map((e) => e.fullPath),
      'pak',
      'pakFiles',
      ++countGenerations.pakFiles,
      state.customDirs.pak || undefined,
      true,
    )
    void loadEntryCounts(
      state.rootFolders.map((e) => e.fullPath),
      'pakFolder',
      'rootFolders',
      ++countGenerations.rootFolders,
      state.customDirs.pak || undefined,
      true,
    )
    void loadEntryCounts(
      state.unpakedFolders.map((e) => e.fullPath),
      'folder',
      'unpakedFolders',
      ++countGenerations.unpakedFolders,
      state.customDirs.unpaked || undefined,
      true,
    )
    void loadEntryCounts(
      state.repakedFiles.map((e) => e.fullPath),
      'repaked',
      'repakedFiles',
      ++countGenerations.repakedFiles,
      state.customDirs.repaked || undefined,
      true,
    )
  }

  function flushFileNamesToLog(fileNames: unknown): void {
    if (!getShowFileNames()) return
    if (!Array.isArray(fileNames) || fileNames.length === 0) return
    const names = (fileNames as unknown[]).filter((n): n is string => typeof n === 'string' && n.length > 0)
    // One file per line; the backend already batches at ~1s. No cap is applied
    // here — the activity log keeps the last 2000 entries by itself.
    for (const name of names) {
      log(name, 'info')
    }
  }

  function setProgressBatch(batch: { index: number; total: number; label?: string } | null): void {
    state.progressBatch = batch
  }

  /**
   * Progress label:
   * - Multi-folder batch: `Pasta (folderI/folderN) - folderName (pakI/pakN)`
   * - Multi-pak (no batch): `Pasta (pakI/pakN) - pakName (fileI/fileN)`
   * - Single: `pakName (fileI/fileN)`
   */
  function formatItemProgressText(
    pkg: string,
    packageIndex: number,
    packageTotal: number,
    current?: number,
    files?: number,
  ): string {
    const batch = state.progressBatch
    const useBatch = batch != null && batch.total > 1
    if (useBatch) {
      const folderName = batch.label || pkg
      const pakCurrent = packageTotal > 0 ? Math.max(1, Math.min(packageIndex || 1, packageTotal)) : undefined
      const pakTotal = packageTotal > 0 ? packageTotal : undefined
      if (typeof pakCurrent === 'number' && typeof pakTotal === 'number') {
        return t('progress.unpackingMulti', {
          i: batch.index,
          total: batch.total,
          pkg: folderName,
          current: pakCurrent,
          files: pakTotal,
        })
      }
      return t('progress.unpackingMultiPlain', {
        i: batch.index,
        total: batch.total,
        pkg: folderName,
      })
    }

    const i = packageIndex
    const total = packageTotal > 0 ? packageTotal : 1
    const isMulti = total > 1
    const hasCounts = typeof files === 'number' && files > 0 && typeof current === 'number'
    if (isMulti && hasCounts) {
      return t('progress.unpackingMulti', {
        i: Math.max(1, Math.min(i, total)),
        total,
        pkg,
        current,
        files,
      })
    }
    if (isMulti) {
      return t('progress.unpackingMultiPlain', {
        i: Math.max(1, Math.min(i, total)),
        total,
        pkg,
      })
    }
    if (hasCounts) {
      return t('progress.unpackingSingle', { pkg, current, files })
    }
    return t('progress.unpackingSinglePlain', { pkg })
  }

  function updateAppProgress(progress: ProgressPayload): void {
    let message = ''
    let logMessage: string | null = null
    let percent = progress.percent ?? 0
    const pkg = progress.packageName ?? ''
    const base = basename(pkg)
    const packageIndex = progress.packageIndex ?? 0
    const packageTotal = progress.packageTotal ?? 0
    const totalForText = packageTotal > 0 ? packageTotal : 1
    const fileCurrent = typeof progress.current === 'number' ? progress.current : undefined
    const fileTotal = typeof progress.total === 'number' ? progress.total : undefined
    // Global percent from the backend, or folded from the task index when the
    // backend only reports a per-task percent.
    const globalPercent = (): number => {
      const raw = progress.percent ?? 0
      return progress.globalPercent
        ? clampProgress(raw)
        : clampProgress(unpakGlobalPercent(packageIndex, totalForText, raw))
    }

    switch (progress.stage) {
      case 'extract-folder-start':
        message = t('progress.preparingExtract')
        percent = clampProgress(progress.percent ?? actionHighWater)
        break
      case 'extract-folder': {
        // Prep phase (scan/classify) stays below VERIFY_SHARE (10%); real extract uses `unpack`.
        const prepPercent = progress.percent ?? 0
        if (prepPercent < 10 && (packageTotal <= 0 || packageIndex <= 0)) {
          message = t('progress.preparingExtract')
        } else {
          message = formatItemProgressText(
            state.progressBatch?.label || base || basename(progress.fileName ?? '') || t('progress.extractingFolder'),
            packageIndex,
            totalForText,
            fileCurrent,
            fileTotal,
          )
        }
        percent = clampProgress(progress.percent ?? 0)
        break
      }
      case 'extract-folder-check':
        message = t('progress.preparingExtract')
        percent = clampProgress(progress.percent ?? 0)
        break
      case 'extract-folder-done':
        message = t('progress.ready')
        percent = 100
        break
      case 'unpack-start':
        message = formatItemProgressText(
          state.progressBatch?.label || base || pkg,
          packageIndex,
          totalForText,
          fileCurrent,
          fileTotal,
        )
        logMessage = t('progress.unpackingStart', { pkg: base, i: packageIndex, total: totalForText })
        percent = globalPercent()
        break
      case 'unpack':
        message = formatItemProgressText(
          state.progressBatch?.label || base || pkg,
          packageIndex,
          totalForText,
          fileCurrent,
          fileTotal,
        )
        percent = globalPercent()
        break
      case 'unpack-done':
        message = formatItemProgressText(
          state.progressBatch?.label || base || pkg,
          packageIndex,
          totalForText,
          fileCurrent,
          fileTotal,
        )
        logMessage = t('progress.unpacked', { pkg: base })
        percent = clampProgress(progress.percent ?? actionHighWater)
        break
      case 'decrypt-start':
        message = t('progress.decryptingStart', { pkg })
        percent = clampProgress(progress.percent ?? actionHighWater)
        break
      case 'decrypt':
        message = formatItemProgressText(pkg || base, packageIndex, totalForText, fileCurrent, fileTotal)
        percent = globalPercent()
        break
      case 'decrypt-done':
        message = t('progress.decrypted', { pkg })
        percent = clampProgress(progress.percent ?? actionHighWater)
        break
      case 'repak-start':
        message = t('progress.repakingStart', { pkg })
        percent = clampProgress(progress.percent ?? actionHighWater)
        break
      case 'repak':
        message = formatItemProgressText(pkg || base, packageIndex, totalForText, fileCurrent, fileTotal)
        percent = globalPercent()
        break
      case 'repak-done':
        message = t('progress.repaked', { pkg })
        percent = clampProgress(progress.percent ?? actionHighWater)
        break
      case 'canceled':
        wasCanceled = true
        message = progress.packageName ? t('progress.canceledPkg', { pkg }) : t('progress.canceled')
        percent = clampProgress(progress.percent ?? actionHighWater)
        break
      case 'unpaked-repak-done':
        message = t('progress.ready')
        percent = clampProgress(progress.percent ?? actionHighWater)
        break
      default:
        message = t('progress.working')
    }

    if (typeof progress.bytesDelta === 'number' && progress.bytesDelta > 0) {
      progressBytesRead += progress.bytesDelta
      noteSpeedBytes(progress.bytesDelta)
      state.progressBytesTotal = progressBytesRead
    }

    // Prefer the sender's short window when present; otherwise derive from recent samples.
    if (typeof progress.speedMBs === 'number' && progress.speedMBs > 0) {
      state.progressSpeedMBs = progress.speedMBs
    } else if (progressBytesRead > 0) {
      refreshLiveSpeed()
    }

    setProgress(percent, message)
    // File names only go to the log (when toggle ON), from the batched fileNames[].
    // extract-folder is throttled like unpack/decrypt (never logged per event).
    if (progress.stage === 'extract-folder' || progress.stage === 'unpack' || progress.stage === 'decrypt' || progress.stage === 'repak') {
      flushFileNamesToLog((progress as Record<string, unknown>).fileNames)
    }
    if (
      ['unpack-start', 'unpack-done', 'decrypt-start', 'decrypt-done', 'repak-start', 'repak-done', 'canceled'].includes(
        progress.stage
      )
    ) {
      log(logMessage ?? message, 'info')
      // Boundary flushes may also carry a name batch.
      flushFileNamesToLog((progress as Record<string, unknown>).fileNames)
    }
  }

  function setCustomDir(key: ListKey, dir: string): void {
    const value = dir.trim()
    state.customDirs[key] = value
    try {
      if (value) localStorage.setItem(DIR_STORAGE_KEYS[key], value)
      else localStorage.removeItem(DIR_STORAGE_KEYS[key])
    } catch {
      // ignore persistence errors
    }
    try {
      const customDirs = key === 'pak' ? { pak: value } : key === 'unpaked' ? { unpaked: value } : { repaked: value }
      void window.electronAPI?.setSettings({ customDirs })
    } catch {
      // ignore persistence errors
    }
  }

  function dirLabel(key: ListKey): string {
    return state.customDirs[key] || DEFAULT_DIR_LABELS[key]
  }

  async function refreshLists(): Promise<void> {
    const electron = useElectron()
    if (state.listsRefreshing) return
    setListsRefreshing(true)
    const pakDir = dirLabel('pak')
    const unpakedDir = dirLabel('unpaked')
    try {
      setProgress(0, t('progress.refreshing', { pakDir, unpakedDir }))
      const [paksResp, unpakedResp] = await Promise.all([
        electron.scanPaks(state.customDirs.pak || undefined),
        electron.scanUnpaked(state.customDirs.unpaked || undefined, state.customDirs.repaked || undefined),
      ])

      const paksOk = paksResp?.success
      const pakFiles = paksResp?.pakFiles
      const rootFolders = paksResp?.rootFolders ?? []
      const paksError = paksResp?.error
      const unpakedOk = unpakedResp?.success
      const unpakedFolders = unpakedResp?.unpakedFolders
      const repakedFiles = unpakedResp?.repakedFiles ?? []
      const unpakedError = unpakedResp?.error

      const prevPakFiles = state.pakFiles
      const prevRootFolders = state.rootFolders
      const prevUnpakedFolders = state.unpakedFolders
      const prevRepakedFiles = state.repakedFiles

      state.pakLoaded = true
      state.trLoaded = true

      if (!paksOk) {
        state.pakScanFailed = true
        state.pakFiles = []
        state.rootFolders = []
        log(t('common.scanPakFail', { error: paksError, dir: pakDir }), 'error')
        setSummary(t('common.scanPakFailSummary', { dir: pakDir }), 'error')
      } else {
        state.pakScanFailed = false
        state.pakFiles = reconcileList(prevPakFiles, pakFiles ?? [])
        state.rootFolders = reconcileList(prevRootFolders, rootFolders)
        if (!pakFiles || pakFiles.length === 0) {
          if (rootFolders.length > 0) {
            log(t('common.foundRootFolders', { n: rootFolders.length, dir: pakDir }), 'info')
          }
        } else {
          log(t('common.foundPaks', { n: pakFiles.length, dir: pakDir }), 'success')
        }
      }

      if (!unpakedOk) {
        state.trScanFailed = true
        state.unpakedFolders = []
        state.repakedFiles = []
        state.repakedCount = 0
        log(t('common.scanUnpakedFail', { error: unpakedError, dir: unpakedDir }), 'error')
      } else {
        state.trScanFailed = false
        state.unpakedFolders = reconcileList(prevUnpakedFolders, unpakedFolders ?? [])
        state.repakedFiles = reconcileList(prevRepakedFiles, repakedFiles)
        state.repakedCount = state.repakedFiles.length
        if (unpakedFolders && unpakedFolders.length > 0) {
          log(t('common.foundUnpaked', { n: unpakedFolders.length, dir: unpakedDir }), 'success')
        }
      }

      if (paksOk) {
        void loadEntryCounts(countLoadingPaths(state.pakFiles), 'pak', 'pakFiles', ++countGenerations.pakFiles, state.customDirs.pak || undefined)
        void loadEntryCounts(countLoadingPaths(state.rootFolders), 'pakFolder', 'rootFolders', ++countGenerations.rootFolders, state.customDirs.pak || undefined)
      }
      if (unpakedOk) {
        void loadEntryCounts(
          countLoadingPaths(state.unpakedFolders),
          'folder',
          'unpakedFolders',
          ++countGenerations.unpakedFolders,
          state.customDirs.unpaked || undefined,
        )
        void loadEntryCounts(
          countLoadingPaths(state.repakedFiles),
          'repaked',
          'repakedFiles',
          ++countGenerations.repakedFiles,
          state.customDirs.repaked || undefined,
        )
      }

      const pakCount = pakFiles?.length ?? 0
      const unpakedCount = unpakedFolders?.length ?? 0
      setSummary(t('common.summaryCounts', { paks: pakCount, unpaked: unpakedCount, dir: unpakedDir }), 'success')
      setProgress(0, t('progress.idle'))
    } catch (err) {
      log(t('common.scanError', { error: err instanceof Error ? err.message : String(err) }), 'error')
      setSummary(t('common.scanErrorSummary'), 'error')
      setProgress(0, t('common.scanFailProgress'))
    } finally {
      setListsRefreshing(false)
    }
  }

  return { state, log, clearLog, setProgress, resetProgressBar, setProgressBatch, setSummary, setActionRunning, setListsRefreshing, updateAppProgress, refreshLists, recountAllCounts, setCustomDir, dirLabel }
}
