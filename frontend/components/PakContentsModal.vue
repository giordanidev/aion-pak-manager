<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { OperationFailure } from '../../shared/api-types'
import { getShowFileNames, useElectron } from '../composables/useElectron'
import { useAppState, basename } from '../composables/useAppState'
import { useVirtualWindow, VIRTUAL_ROW_HEIGHT } from '../composables/useVirtualWindow'

const props = withDefaults(
  defineProps<{
    open: boolean
    pakPath: string | null
    source?: 'pak' | 'repaked' | 'unpaked'
    /** Folder (RePAKEDS/UnPAKEDS): browse the folder. RePAK folders can drop onto a .pak and open it. */
    structureOnly?: boolean
  }>(),
  {
    source: 'pak',
    structureOnly: false,
  },
)
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void; (e: 'changed'): void }>()

const { t } = useI18n()
const electron = useElectron()
const { state, logI18n, clearLog, setProgress, setSummary, setActionRunning } = useAppState()

const loading = ref(false)
const treeBuilding = ref(false)
const error = ref('')
const files = ref<string[]>([])
const selected = ref<string[]>([])
const decrypt = ref(false)
const searchInput = ref('')
const searchQuery = ref('')
const searchBusy = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined
const requestId = ref(0)
const dropActive = ref(false)
const dropTargetFolder = ref('')
const dropPakPath = ref<string | null>(null)
const expandingKey = ref<string | null>(null)
const repakedSelected = ref<{ key: string; name: string; isDir: boolean } | null>(null)
const confirmTarget = ref<{ key: string; name: string; isDir: boolean } | null>(null)
const deleteRootConfirmOpen = ref(false)
const deletingRoot = ref(false)
const pendingDrop = ref<{ paths: string[]; targetFolder: string; conflicts: string[]; pakPath: string } | null>(null)
const drilledPakPath = ref<string | null>(null)

const isRepaked = computed(() => props.source === 'repaked')
const isUnpaked = computed(() => props.source === 'unpaked')
const activePath = computed(() => drilledPakPath.value ?? props.pakPath)
/** Folder listing (not the inside of a drilled-in .pak). */
const listingFolder = computed(() => props.structureOnly && !drilledPakPath.value)
const fullTree = computed(() => listingFolder.value)
const repakEditable = computed(() => isRepaked.value && !listingFolder.value)
const contentBase = computed(() => {
  if (isRepaked.value) return state.customDirs.repaked || undefined
  if (isUnpaked.value) return state.customDirs.unpaked || undefined
  return state.customDirs.pak || undefined
})

interface FileWithPath extends File {
  path?: string
}

interface TreeNode {
  name: string
  key: string
  children: Map<string, TreeNode>
  isFile: boolean
  count: number
}

interface LeftRow {
  key: string
  name: string
  depth: number
  isDir: boolean
  expanded: boolean
  node: TreeNode
}

interface RightRow {
  key: string
  name: string
  depth: number
  isDir: boolean
  node: TreeNode
}

function emptyRoot(): TreeNode {
  return { name: '', key: '', children: new Map(), isFile: false, count: 0 }
}

const treeRoot = ref<TreeNode>(emptyRoot())
const expanded = ref<Set<string>>(new Set())
const selectedExpanded = ref<Set<string>>(new Set())

function sortChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0
    const bDir = b.children.size > 0
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

const pakName = computed(() => (activePath.value ? basename(activePath.value) : ''))
const isRootFolder = computed(() => listingFolder.value || !isPakName(pakName.value))
const isSelected = (file: string): boolean => selected.value.includes(file)
const searchActive = computed(() => searchQuery.value.trim().length > 0)
const searchPending = computed(() => searchInput.value.trim() !== searchQuery.value.trim())

function collectMatches(node: TreeNode, query: string, out: TreeNode[]): void {
  for (const child of node.children.values()) {
    if (child.name.toLowerCase().includes(query)) out.push(child)
    else collectMatches(child, query, out)
  }
}

function buildLeftRows(query: string): LeftRow[] {
  const rows: LeftRow[] = []
  if (query) {
    function emit(node: TreeNode, depth: number): void {
      const isDir = node.children.size > 0
      const isExpanded = expanded.value.has(node.key)
      rows.push({ key: node.key, name: node.key, depth, isDir, expanded: isExpanded, node })
      if (isDir && isExpanded) {
        for (const child of sortChildren(node)) emit(child, depth + 1)
      }
    }
    const matches: TreeNode[] = []
    collectMatches(treeRoot.value, query, matches)
    matches.sort((a, b) => {
      const aDir = a.children.size > 0
      const bDir = b.children.size > 0
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.key.localeCompare(b.key)
    })
    for (const match of matches) emit(match, 0)
    return rows
  }
  function walk(node: TreeNode, depth: number): void {
    for (const child of sortChildren(node)) {
      const isDir = child.children.size > 0
      const isExpanded = expanded.value.has(child.key)
      rows.push({ key: child.key, name: child.name, depth, isDir, expanded: isExpanded, node: child })
      if (isDir && isExpanded) walk(child, depth + 1)
    }
  }
  walk(treeRoot.value, 0)
  return rows
}

const leftRows = ref<LeftRow[]>([])
let rowsGen = 0
watch([searchQuery, treeRoot, expanded], async () => {
  const id = ++rowsGen
  const query = searchQuery.value.trim().toLowerCase()
  if (query) {
    searchBusy.value = true
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (id !== rowsGen) return
  }
  leftRows.value = buildLeftRows(query)
  if (id === rowsGen) searchBusy.value = false
})

watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!value.trim()) {
    searchQuery.value = ''
    return
  }
  searchTimer = setTimeout(() => {
    searchQuery.value = value
  }, 400)
})

const leftCount = computed(() => leftRows.value.length)
const {
  start: leftStart,
  end: leftEnd,
  totalHeight: leftTotalHeight,
  onScroll: onLeftScroll,
  bind: bindLeftScroll,
} = useVirtualWindow(leftCount)
const visibleLeftRows = computed(() => {
  const rows = leftRows.value
  const items: { row: LeftRow; index: number }[] = []
  for (let i = leftStart.value; i < leftEnd.value; i += 1) {
    const row = rows[i]
    if (row) items.push({ row, index: i })
  }
  return items
})

const selectedTree = computed<TreeNode>(() => {
  const root = emptyRoot()
  for (const file of selected.value) {
    const parts = file.split('/').filter((part) => part.length > 0)
    let node = root
    let currentKey = ''
    for (let j = 0; j < parts.length; j += 1) {
      const part = parts[j] as string
      const last = j === parts.length - 1
      currentKey = currentKey ? `${currentKey}/${part}` : part
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, key: currentKey, children: new Map(), isFile: last, count: 0 }
        node.children.set(part, child)
      } else if (last) {
        child.isFile = true
      }
      if (!last) child.count += 1
      node = child
    }
  }
  return root
})

const selectedRows = computed<RightRow[]>(() => {
  const rows: RightRow[] = []
  function visit(node: TreeNode, depth: number): void {
    for (const child of sortChildren(node)) {
      const isDir = child.children.size > 0
      rows.push({ key: child.key, name: child.name, depth, isDir, node: child })
      if (isDir && selectedExpanded.value.has(child.key)) visit(child, depth + 1)
    }
  }
  visit(selectedTree.value, 0)
  return rows
})

const selectedCount = computed(() => selectedRows.value.length)
const {
  start: selectedStart,
  end: selectedEnd,
  totalHeight: selectedTotalHeight,
  onScroll: onSelectedScroll,
  bind: bindSelectedScroll,
} = useVirtualWindow(selectedCount)
const visibleSelectedRows = computed(() => {
  const rows = selectedRows.value
  const items: { row: RightRow; index: number }[] = []
  for (let i = selectedStart.value; i < selectedEnd.value; i += 1) {
    const row = rows[i]
    if (row) items.push({ row, index: i })
  }
  return items
})

function collectFiles(node: TreeNode, out: string[] = []): string[] {
  if (node.isFile) out.push(node.key)
  for (const child of node.children.values()) collectFiles(child, out)
  return out
}

function rowFileCount(row: LeftRow | RightRow): number {
  return row.node.count
}

function isPakName(name: string): boolean {
  return name.toLowerCase().endsWith('.pak')
}

// Counts are only shown for folders and .pak files (never for plain files).
function showRowCount(row: LeftRow | RightRow): boolean {
  if (!row.isDir && !isPakName(row.name)) return false
  return rowFileCount(row) > 0
}

function fileExt(name: string): string {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return 'FILE'
  const ext = base.slice(dot + 1).toUpperCase()
  return ext.length > 4 ? ext.slice(0, 4) : ext
}

function toggleNode(key: string): void {
  if (state.actionRunning || expandingKey.value) return
  if (expanded.value.has(key)) {
    const next = new Set(expanded.value)
    next.delete(key)
    expanded.value = next
    return
  }
  // Show a spinner on the toggle while the (possibly large) folder renders.
  expandingKey.value = key
  setTimeout(() => {
    const next = new Set(expanded.value)
    next.add(key)
    expanded.value = next
    setTimeout(() => {
      if (expandingKey.value === key) expandingKey.value = null
    }, 0)
  }, 0)
}

function toggleSelectedNode(key: string): void {
  if (state.actionRunning) return
  const next = new Set(selectedExpanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedExpanded.value = next
}

function joinUnder(base: string, relPosix: string): string {
  const sep = base.includes('\\') ? '\\' : '/'
  const rel = relPosix.split('/').join(sep)
  return `${base.replace(/[\\/]+$/, '')}${sep}${rel}`
}

function parentDir(full: string): string {
  const normalized = full.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? full.slice(0, index) : full
}

function pakFilePath(row: LeftRow): string | null {
  if (!listingFolder.value || !isRepaked.value || row.isDir || !isPakName(row.name) || !props.pakPath) return null
  return joinUnder(props.pakPath, row.key)
}

function rowDropHighlight(row: LeftRow): boolean {
  if (!dropActive.value) return false
  const pakFile = pakFilePath(row)
  if (pakFile) return dropPakPath.value === pakFile
  return repakEditable.value && row.isDir && dropTargetFolder.value === row.key
}

function onRowClick(row: LeftRow): void {
  if (state.actionRunning) return
  if (listingFolder.value) {
    if (isRepaked.value && !row.isDir && isPakName(row.name) && props.pakPath) {
      drilledPakPath.value = joinUnder(props.pakPath, row.key)
      selected.value = []
      repakedSelected.value = null
      searchInput.value = ''
      searchQuery.value = ''
      void loadContents()
      return
    }
    if (row.isDir) toggleNode(row.key)
    return
  }
  if (repakEditable.value) {
    repakedSelected.value = { key: row.key, name: row.name, isDir: row.isDir }
    if (row.isDir) toggleNode(row.key)
    else addFile(row.key)
    return
  }
  if (row.isDir) toggleNode(row.key)
  else addFile(row.key)
}

function parentFolder(key: string): string {
  const index = key.lastIndexOf('/')
  return index >= 0 ? key.slice(0, index) : ''
}

function onRowDragOver(row: LeftRow, event: DragEvent): void {
  if (state.actionRunning) return
  const pakFile = pakFilePath(row)
  if (pakFile) {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    dropActive.value = true
    dropPakPath.value = pakFile
    dropTargetFolder.value = ''
    return
  }
  if (!repakEditable.value) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  dropActive.value = true
  dropPakPath.value = activePath.value
  dropTargetFolder.value = row.isDir ? row.key : parentFolder(row.key)
}

function requestDelete(): void {
  if (!repakEditable.value || state.actionRunning) return
  const current = repakedSelected.value
  if (!current) return
  confirmTarget.value = { key: current.key, name: current.name, isDir: current.isDir }
}

async function confirmDelete(): Promise<void> {
  const target = confirmTarget.value
  const pakPath = activePath.value
  if (!target || !pakPath || state.actionRunning) return
  confirmTarget.value = null
  const entries = target.isDir ? [`${target.key}/`] : [target.key]
  setActionRunning(true)
  clearLog()
  setSummary(t('pak.deletingEntries', { name: target.name }), 'info')
  logI18n('pak.deletingEntriesLog', { name: target.name })
  try {
    const result = await electron.deletePakEntries({ pakPath, entries, base: contentBase.value, showFileProgress: getShowFileNames() })
    if (result.success) {
      logI18n('pak.deleteDone', { name: target.name }, 'success')
      setSummary(t('pak.deleteDone', { name: target.name }), 'success')
      repakedSelected.value = null
      await loadContents()
      emit('changed')
    } else {
      const failed = (result.results?.failed?.[0] ?? null) as OperationFailure | null
      const message = failed?.error || result.error || ''
      logI18n('pak.deleteFailed', { error: message }, 'error')
      setSummary(t('pak.deleteFailed', { error: message }), 'error')
    }
  } catch (err) {
    logI18n('pak.deleteFailed', { error: err instanceof Error ? err.message : String(err) }, 'error')
    setSummary(t('pak.deleteFailed', { error: err instanceof Error ? err.message : String(err) }), 'error')
  } finally {
    setActionRunning(false)
    setProgress(0, 'progress.idle')
  }
}

function cancelDelete(): void {
  confirmTarget.value = null
}

function requestDeleteRoot(): void {
  if (!activePath.value || state.actionRunning || deletingRoot.value || deleteRootConfirmOpen.value || confirmTarget.value) return
  deleteRootConfirmOpen.value = true
}

async function confirmDeleteRoot(): Promise<void> {
  const targetPath = activePath.value
  if (!targetPath || state.actionRunning || deletingRoot.value) return
  const name = basename(targetPath)
  deletingRoot.value = true
  setActionRunning(true)
  clearLog()
  setSummary(t('pak.deletingRoot', { name }), 'info')
  logI18n('pak.deletingRootLog', { name })
  try {
    const result = await electron.deleteManagedPath(targetPath, contentBase.value)
    if (result.success) {
      logI18n('pak.deleteRootDone', { name }, 'success')
      setSummary(t('pak.deleteRootDone', { name }), 'success')
      deleteRootConfirmOpen.value = false
      emit('done')
      emit('close')
    } else {
      deleteRootConfirmOpen.value = false
      logI18n('pak.deleteRootFailed', { error: result.error || '' }, 'error')
      setSummary(t('pak.deleteRootFailed', { error: result.error || '' }), 'error')
    }
  } catch (err) {
    deleteRootConfirmOpen.value = false
    const message = err instanceof Error ? err.message : String(err)
    logI18n('pak.deleteRootFailed', { error: message }, 'error')
    setSummary(t('pak.deleteRootFailed', { error: message }), 'error')
  } finally {
    deletingRoot.value = false
    setActionRunning(false)
    setProgress(0, 'progress.idle')
  }
}

function cancelDeleteRoot(): void {
  if (deletingRoot.value) return
  deleteRootConfirmOpen.value = false
}

function onDragOver(event: DragEvent): void {
  if (listingFolder.value || !repakEditable.value || state.actionRunning) {
    if (listingFolder.value) {
      dropActive.value = false
      dropPakPath.value = null
      dropTargetFolder.value = ''
    }
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  dropActive.value = true
  dropPakPath.value = activePath.value
  dropTargetFolder.value = ''
}

function onDragLeave(event: DragEvent): void {
  const el = event.currentTarget as HTMLElement | null
  if (el && event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) return
  dropActive.value = false
  dropPakPath.value = null
}

async function onDrop(event: DragEvent): Promise<void> {
  const target = dropTargetFolder.value
  const pakPath = dropPakPath.value
  dropActive.value = false
  dropTargetFolder.value = ''
  dropPakPath.value = null
  if (!pakPath || state.actionRunning) return
  if (!repakEditable.value && !listingFolder.value) return
  event.preventDefault()
  const dropped = Array.from(event.dataTransfer?.files ?? [])
    .map((file) => (file as FileWithPath).path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  if (dropped.length === 0) return
  await addDroppedFiles(dropped, target, false, pakPath)
}

async function addDroppedFiles(paths: string[], targetFolder: string, overwrite: boolean, pakPath: string): Promise<void> {
  if (!pakPath) return
  // Build plain (non-reactive) values: `paths` may come from a ref and would
  // otherwise be a Vue Proxy, which cannot be structured-cloned over IPC.
  const sourcePaths = Array.from(paths, (path) => String(path))
  setActionRunning(true)
  clearLog()
  setSummary(t('pak.addingFiles', { n: sourcePaths.length }), 'info')
  logI18n('pak.addingFilesLog', { n: sourcePaths.length, folder: targetFolder || '/' })
  try {
    const result = await electron.addFilesToPak({
      pakPath: String(pakPath),
      sourcePaths,
      targetFolder: String(targetFolder ?? ''),
      overwrite: overwrite === true,
      base: contentBase.value,
      showFileProgress: getShowFileNames(),
    })
    if (result.success) {
      const entry = (result.results?.success?.[0] ?? {}) as {
        added?: number
        replaced?: number
        skipped?: number
        conflicts?: string[]
      }
      const conflicts = entry.conflicts ?? []
      if (conflicts.length > 0) {
        // Ask once for every conflicting file.
        pendingDrop.value = { paths, targetFolder, conflicts, pakPath }
        setSummary(t('pak.overwritePromptSummary', { n: conflicts.length }), 'warning')
        return
      }
      const added = entry.added ?? 0
      const replaced = entry.replaced ?? 0
      const skipped = entry.skipped ?? 0
      logI18n('pak.addDone', { added, replaced, skipped }, 'success')
      setSummary(t('pak.addDone', { added, replaced, skipped }), 'success')
      await loadContents()
      emit('changed')
    } else {
      const failed = (result.results?.failed?.[0] ?? null) as OperationFailure | null
      const message = failed?.error || result.error || ''
      logI18n('pak.addFailed', { error: message }, 'error')
      setSummary(t('pak.addFailed', { error: message }), 'error')
    }
  } catch (err) {
    logI18n('pak.addFailed', { error: err instanceof Error ? err.message : String(err) }, 'error')
    setSummary(t('pak.addFailed', { error: err instanceof Error ? err.message : String(err) }), 'error')
  } finally {
    setActionRunning(false)
    setProgress(0, 'progress.idle')
  }
}

function cancelOverwrite(): void {
  pendingDrop.value = null
  setSummary(t('pak.overwriteCanceled'), 'info')
}

async function confirmOverwrite(): Promise<void> {
  const pending = pendingDrop.value
  if (!pending) return
  pendingDrop.value = null
  await addDroppedFiles(pending.paths, pending.targetFolder, true, pending.pakPath)
}

function addFile(file: string): void {
  if (state.actionRunning) return
  if (!isSelected(file)) selected.value = [...selected.value, file]
}

function removeFile(file: string): void {
  if (state.actionRunning) return
  selected.value = selected.value.filter((entry) => entry !== file)
}

function addFolder(node: TreeNode): void {
  if (state.actionRunning) return
  const additions = collectFiles(node).filter((file) => !isSelected(file))
  if (additions.length === 0) return
  selected.value = [...selected.value, ...additions]
}

function removeFolder(node: TreeNode): void {
  if (state.actionRunning) return
  const toRemove = new Set(collectFiles(node))
  selected.value = selected.value.filter((file) => !toRemove.has(file))
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function buildTreeChunked(source: string[]): Promise<TreeNode> {
  const root = emptyRoot()
  for (let i = 0; i < source.length; i += 1) {
    const file = source[i] as string
    const parts = file.split('/').filter((part) => part.length > 0)
    let node = root
    let currentKey = ''
    for (let j = 0; j < parts.length; j += 1) {
      const part = parts[j] as string
      const last = j === parts.length - 1
      currentKey = currentKey ? `${currentKey}/${part}` : part
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, key: currentKey, children: new Map(), isFile: last, count: 0 }
        node.children.set(part, child)
      } else if (last) {
        child.isFile = true
      }
      if (!last) child.count += 1
      node = child
    }
    if (i % 400 === 399) {
      await yieldToUi()
    }
  }
  return root
}

async function loadContents(): Promise<void> {
  const pakPath = activePath.value
  if (!pakPath) return
  const id = ++requestId.value
  loading.value = true
  treeBuilding.value = false
  error.value = ''
  files.value = []
  treeRoot.value = emptyRoot()
  expanded.value = new Set()
  try {
    const result = await electron.listPakContents(pakPath, contentBase.value)
    if (id !== requestId.value) return
    if (!result.success) {
      error.value = t('pak.contentsFailed', { error: result.error })
      return
    }
    files.value = result.files ?? []
    loading.value = false
    treeBuilding.value = true
    const root = await buildTreeChunked(files.value)
    if (id !== requestId.value) return
    treeRoot.value = root
  } catch (err) {
    if (id !== requestId.value) return
    error.value = t('pak.contentsFailed', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (id === requestId.value) {
      loading.value = false
      treeBuilding.value = false
    }
  }
}

async function unpakSelectedEntries(): Promise<void> {
  const pakPath = activePath.value
  if (!pakPath || selected.value.length === 0 || state.actionRunning) return
  const entries = [...selected.value]
  const shouldDecrypt = decrypt.value
  let succeeded = false
  setActionRunning(true)
  clearLog()
  setSummary(
    shouldDecrypt
      ? t('pak.extractingDecryptingN', { n: entries.length })
      : t('pak.extractingN', { n: entries.length }),
    'info',
  )
  logI18n(shouldDecrypt ? 'pak.extractingDecryptingNLog' : 'pak.extractingNLog', { n: entries.length })
  try {
    const result = shouldDecrypt
      ? await electron.unpakDecryptPakEntries(pakPath, entries, {
          showFileProgress: getShowFileNames(),
          unpakedDir: state.customDirs.unpaked || undefined,
          pakDir: isRepaked.value ? parentDir(pakPath) : state.customDirs.pak || undefined,
        })
      : await electron.unpakPakEntries(pakPath, entries, {
          showFileProgress: getShowFileNames(),
          unpakedDir: state.customDirs.unpaked || undefined,
          pakDir: isRepaked.value ? parentDir(pakPath) : state.customDirs.pak || undefined,
        })
    if (result.success) {
      const successCount = result.results?.success.length ?? 0
      const failedCount = result.results?.failed.length ?? 0
      logI18n(
        'pak.actionDone',
        {
          action: { i18n: shouldDecrypt ? 'pak.extractingDecrypting' : 'pak.extracting' },
          ok: successCount,
          fail: failedCount,
        },
        'success',
      )
      if (failedCount > 0) {
        result.results?.failed.forEach((fail) => {
          const entry = fail as OperationFailure
          logI18n('pak.failedItem', { name: entry.packageName, error: entry.error }, 'error')
        })
        setSummary(t('pak.partialSummary', { ok: successCount, fail: failedCount }), 'error')
      } else {
        setSummary(t('pak.allOk', { n: successCount }), 'success')
        succeeded = true
      }
    } else {
      logI18n('pak.actionFailedOp', { error: result.error }, 'error')
      setSummary(t('pak.extractFailed'), 'error')
    }
  } catch (err) {
    logI18n('pak.unexpectedLog', { error: err instanceof Error ? err.message : String(err) }, 'error')
    setSummary(t('pak.unexpected'), 'error')
  } finally {
    setActionRunning(false)
    setProgress(0, 'progress.idle')
    if (succeeded) emit('done')
  }
}

function leaveDrilledPak(): void {
  if (state.actionRunning || !drilledPakPath.value) return
  drilledPakPath.value = null
  selected.value = []
  repakedSelected.value = null
  searchInput.value = ''
  searchQuery.value = ''
  void loadContents()
}

function close(): void {
  if (state.actionRunning) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (deleteRootConfirmOpen.value) {
      if (deletingRoot.value) return
      deleteRootConfirmOpen.value = false
      return
    }
    if (confirmTarget.value) {
      confirmTarget.value = null
      return
    }
    if (searchInput.value.length > 0 || searchQuery.value.length > 0) {
      searchInput.value = ''
      searchQuery.value = ''
      return
    }
    if (drilledPakPath.value) {
      leaveDrilledPak()
      return
    }
    close()
    return
  }
  const target = event.target as HTMLElement | null
  const isTextInput =
    !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  if (event.key === 'Delete' && !isTextInput && repakEditable.value && repakedSelected.value && !confirmTarget.value && !deleteRootConfirmOpen.value) {
    event.preventDefault()
    requestDelete()
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      requestId.value += 1
      selected.value = []
      decrypt.value = false
      searchInput.value = ''
      searchQuery.value = ''
      error.value = ''
      files.value = []
      treeRoot.value = emptyRoot()
      expanded.value = new Set()
      selectedExpanded.value = new Set()
      dropActive.value = false
      dropTargetFolder.value = ''
      dropPakPath.value = null
      expandingKey.value = null
      repakedSelected.value = null
      confirmTarget.value = null
      deleteRootConfirmOpen.value = false
      deletingRoot.value = false
      pendingDrop.value = null
      drilledPakPath.value = null
      void loadContents()
      window.addEventListener('keydown', onKeydown)
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
  },
)

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 p-5">
    <div
      class="relative flex h-[80vh] w-[90vw] max-h-none max-w-none flex-col rounded-xl border border-border bg-card shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
      role="dialog"
      aria-modal="true"
    >
      <div class="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div class="flex min-w-0 items-center gap-2">
          <button
            v-if="drilledPakPath"
            type="button"
            class="box-border inline-flex h-7 items-center rounded-lg border border-border bg-hover px-2 text-xs text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="state.actionRunning"
            @click="leaveDrilledPak"
          >{{ t('pak.backToFolder') }}</button>
          <h3 class="m-0 min-w-0 truncate text-bright">{{ t('pak.contentsTitle', { name: pakName }) }}</h3>
          <button
            v-if="pakPath"
            type="button"
            class="box-border inline-flex h-7 w-7 min-w-7 flex-none items-center justify-center rounded-lg border border-border bg-hover p-0 text-dim cursor-pointer transition duration-150 enabled:hover:border-red enabled:hover:bg-red/15 enabled:hover:text-red disabled:cursor-not-allowed disabled:opacity-50"
            v-app-title="isRootFolder ? t('pak.deleteRootHint') : t('pak.deleteRootFileHint')"
            :disabled="state.actionRunning || deletingRoot"
            @click="requestDeleteRoot"
          >
            <span v-if="deletingRoot" class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>
            <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2.5 4.5h11" />
              <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
              <path d="M12.5 4.5V13a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3.5 13V4.5" />
              <path d="M6.5 7v5M9.5 7v5" />
            </svg>
          </button>
        </div>
        <button
          class="inline-flex h-8 w-8 min-w-8 items-center justify-center rounded-lg border border-red bg-transparent p-0 text-[15px] font-bold leading-none text-red cursor-pointer transition duration-150 enabled:hover:bg-red/15"
          :disabled="state.actionRunning"
          aria-label="Close"
          @click="close"
        >X</button>
      </div>
      <div class="flex min-h-0 flex-1 gap-4 overflow-hidden px-5 py-4">
        <div
          class="relative flex min-h-0 min-w-0 flex-none flex-col gap-2"
          :class="[fullTree ? 'w-full' : 'w-[calc(50%-8px)]', dropActive ? 'rounded-lg outline-dashed outline-1 outline-accent outline-offset-2' : '']"
          @dragover="onDragOver"
          @dragleave="onDragLeave"
          @drop="onDrop"
        >
          <div class="flex flex-none items-center justify-between gap-2 text-[13px] font-semibold text-bright">
            <span>{{ t('pak.allFiles') }}</span>
            <span
              v-if="!loading && !treeBuilding && !error"
              class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-deepest px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums whitespace-nowrap text-bright"
            >{{ files.length }}</span>
          </div>
          <div class="relative min-w-0 flex-none">
            <input
              v-model="searchInput"
              class="w-full min-w-0 rounded-[10px] border border-border bg-deepest py-1.5 pl-2.5 pr-8 text-xs text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(79,143,255,0.15)]"
              type="text"
              :placeholder="t('pak.searchPlaceholder')"
            />
            <span
              v-if="searchPending || searchBusy"
              class="pointer-events-none absolute right-2 top-1/2 inline-block h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-white/35 border-t-white"
            ></span>
          </div>
          <div
            :ref="bindLeftScroll"
            class="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-deepest font-mono text-xs"
            @scroll="onLeftScroll"
          >
            <div v-if="loading || treeBuilding" class="flex h-full items-center justify-center gap-2 text-[13px] text-dim">
              <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>{{ t('pak.loadingContents') }}
            </div>
            <div v-else-if="error" class="flex h-full items-center justify-center gap-2 text-[13px] text-red">{{ error }}</div>
            <div v-else-if="files.length === 0" class="flex h-full items-center justify-center gap-2 text-[13px] text-dim">{{ t('pak.noFiles') }}</div>
            <div v-else-if="searchActive && leftRows.length === 0" class="flex h-full items-center justify-center gap-2 text-[13px] text-dim">{{ t('pak.searchEmpty') }}</div>
            <div v-else class="relative w-full" :style="{ height: `${leftTotalHeight}px` }">
            <div
              v-for="item in visibleLeftRows"
              :key="item.row.key"
              class="absolute inset-x-0 flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap px-1.5 hover:bg-hover"
              :class="{
                'bg-accent/[0.18]': !listingFolder && !item.row.isDir && isSelected(item.row.key),
                'bg-accent/30': repakEditable && repakedSelected?.key === item.row.key,
                'bg-green/[0.22] outline-dashed outline-1 -outline-offset-1 outline-green': rowDropHighlight(item.row),
              }"
              :style="{ top: `${item.index * VIRTUAL_ROW_HEIGHT}px`, paddingLeft: `${4 + item.row.depth * 14}px` }"
              @click="onRowClick(item.row)"
              @dragover.stop="onRowDragOver(item.row, $event)"
            >
              <button
                v-if="item.row.isDir"
                type="button"
                class="inline-flex h-[18px] w-[18px] min-w-[18px] flex-none items-center justify-center rounded border border-border bg-transparent p-0 text-[15px] font-bold leading-none text-text cursor-pointer transition duration-150 enabled:hover:bg-hover"
                :title="t('pak.toggleFolderHint')"
                :disabled="state.actionRunning || expandingKey !== null"
                @click.stop="toggleNode(item.row.key)"
              >
                <span v-if="expandingKey === item.row.key" class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>
                <template v-else>{{ item.row.expanded ? '−' : '+' }}</template>
              </button>
              <span v-else class="w-[18px] flex-none"></span>
              <svg v-if="item.row.isDir" class="h-[18px] w-7 flex-none text-accent" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M1.4 3.6a1.2 1.2 0 0 1 1.2-1.2h3l1.4 1.6h6.4a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H2.6a1.2 1.2 0 0 1-1.2-1.2z" />
              </svg>
              <span v-else class="inline-flex h-[18px] w-7 flex-none items-center justify-center rounded border border-accent/55 bg-accent/[0.16] px-0.5 font-sans text-[7px] font-bold uppercase leading-none tracking-[0.2px] text-accent">{{ fileExt(item.row.name) }}</span>
              <span class="min-w-0 flex-1 truncate" :class="item.row.isDir ? 'text-bright' : 'text-text'" :title="listingFolder && isRepaked && !item.row.isDir && isPakName(item.row.name) ? t('pak.openPakHint') : item.row.key">{{ item.row.name }}</span>
              <span v-if="showRowCount(item.row)" class="ml-2 min-w-10 flex-none text-right text-[11px] tabular-nums text-dim">{{ rowFileCount(item.row) }}</span>
              <button
                v-if="!listingFolder && item.row.isDir"
                type="button"
                class="ml-1 inline-flex h-[18px] w-[18px] min-w-[18px] flex-none items-center justify-center rounded border-none bg-transparent p-0 text-[13px] leading-none text-dim cursor-pointer enabled:hover:bg-accent/20 enabled:hover:text-bright"
                :title="t('pak.addFolderHint')"
                :disabled="state.actionRunning"
                @click.stop="addFolder(item.row.node)"
              >&#8594;</button>
              <span v-else class="w-[18px] flex-none"></span>
            </div>
            </div>
          </div>
          <div v-if="isRepaked" class="flex flex-none items-center justify-between gap-3 text-xs text-dim">
            <span class="truncate">{{ dropActive ? t('pak.dropOverlay') : (listingFolder ? t('pak.dropOnPakHint') : t('pak.dropHint')) }}</span>
          </div>
          <div v-if="repakEditable && dropActive" class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border border-accent bg-accent/12 p-4 text-center text-sm font-semibold text-bright">
            <span>{{ t('pak.dropOverlay') }}</span>
          </div>
        </div>
        <div v-if="!fullTree" class="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div class="flex flex-none items-center justify-between gap-2 text-[13px] font-semibold text-bright">
            <span>{{ t('pak.selectedFiles') }}</span>
            <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-deepest px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums whitespace-nowrap text-bright">{{ selected.length }}</span>
          </div>
          <div
            :ref="bindSelectedScroll"
            class="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-deepest font-mono text-xs"
            @scroll="onSelectedScroll"
          >
            <div v-if="selected.length === 0" class="flex h-full items-center justify-center p-4 text-center font-sans text-[13px] text-dim">{{ t('pak.selectFilesFirst') }}</div>
            <div v-else class="relative w-full" :style="{ height: `${selectedTotalHeight}px` }">
            <div
              v-for="item in visibleSelectedRows"
              :key="item.row.key"
              class="absolute inset-x-0 flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap px-1.5 hover:bg-hover"
              :style="{ top: `${item.index * VIRTUAL_ROW_HEIGHT}px`, paddingLeft: `${4 + item.row.depth * 14}px` }"
              @click="!item.row.isDir && removeFile(item.row.key)"
            >
              <button
                v-if="item.row.isDir"
                type="button"
                class="inline-flex h-[18px] w-[18px] min-w-[18px] flex-none items-center justify-center rounded border border-border bg-transparent p-0 text-[15px] font-bold leading-none text-text cursor-pointer transition duration-150 enabled:hover:bg-hover"
                :title="t('pak.toggleFolderHint')"
                :disabled="state.actionRunning"
                @click.stop="toggleSelectedNode(item.row.key)"
              >{{ selectedExpanded.has(item.row.key) ? '−' : '+' }}</button>
              <span v-else class="w-[18px] flex-none"></span>
              <svg v-if="item.row.isDir" class="h-[18px] w-7 flex-none text-accent" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M1.4 3.6a1.2 1.2 0 0 1 1.2-1.2h3l1.4 1.6h6.4a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H2.6a1.2 1.2 0 0 1-1.2-1.2z" />
              </svg>
              <span v-else class="inline-flex h-[18px] w-7 flex-none items-center justify-center rounded border border-accent/55 bg-accent/[0.16] px-0.5 font-sans text-[7px] font-bold uppercase leading-none tracking-[0.2px] text-accent">{{ fileExt(item.row.name) }}</span>
              <span
                class="min-w-0 flex-1 truncate"
                :class="item.row.isDir ? 'text-bright' : 'text-text'"
                :title="item.row.isDir ? t('pak.toggleFolderHint') : item.row.key"
                @click="item.row.isDir ? toggleSelectedNode(item.row.key) : removeFile(item.row.key)"
              >{{ item.row.name }}</span>
              <span v-if="showRowCount(item.row)" class="ml-2 min-w-10 flex-none text-right text-[11px] tabular-nums text-dim">{{ rowFileCount(item.row) }}</span>
              <button
                type="button"
                class="ml-1 inline-flex h-[18px] w-[18px] min-w-[18px] flex-none items-center justify-center rounded border-none bg-transparent p-0 text-[14px] leading-none text-dim cursor-pointer enabled:hover:bg-red/[0.18] enabled:hover:text-red"
                :title="item.row.isDir ? t('pak.removeFolderHint') : t('pak.removeFileHint')"
                :disabled="state.actionRunning"
                @click.stop="item.row.isDir ? removeFolder(item.row.node) : removeFile(item.row.key)"
              >×</button>
            </div>
            </div>
          </div>
          <div class="flex flex-none items-center justify-between gap-3">
            <label
              class="relative inline-flex cursor-pointer select-none items-center gap-2 text-[13px] text-text has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50"
              v-app-title="t('pak.decryptAfterHint')"
            >
              <input type="checkbox" class="peer sr-only" v-model="decrypt" :disabled="state.actionRunning" />
              <span class="h-5 w-9 flex-none rounded-full border border-border bg-card transition-colors peer-checked:border-accent peer-checked:bg-accent/25"></span>
              <span class="pointer-events-none absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-[#e9e9ff] transition-all peer-checked:left-[18px] peer-checked:bg-accent"></span>
              <span>{{ t('pak.decryptAfter') }}</span>
            </label>
            <button
              class="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm text-white cursor-pointer transition duration-150 enabled:hover:-translate-y-px enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-[#555] disabled:opacity-50"
              :disabled="state.actionRunning || selected.length === 0"
              @click="unpakSelectedEntries"
            >
              <span v-if="state.actionRunning" class="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>{{ t('pak.unpak') }}
            </button>
          </div>
        </div>
      </div>
      <div v-if="deleteRootConfirmOpen" class="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/60 p-5" @click.self="cancelDeleteRoot">
        <div class="w-full max-w-[420px] rounded-[10px] border border-border bg-card px-5 py-[18px] shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
          <template v-if="deletingRoot">
            <div class="flex flex-col items-center gap-3 py-2 text-center">
              <span class="inline-block h-8 w-8 animate-spin rounded-full border-2 border-white/35 border-t-accent"></span>
              <h4 class="m-0 text-bright">{{ t('pak.deletingRoot', { name: pakName }) }}</h4>
              <p class="m-0 text-[13px] text-dim">{{ t('pak.deletingRootWait') }}</p>
            </div>
          </template>
          <template v-else>
            <h4 class="m-0 mb-2 text-bright">{{ t('pak.deleteConfirmTitle') }}</h4>
            <p class="m-0 mb-4 break-words text-[13px] text-text">
              {{
                isRootFolder
                  ? t('pak.deleteRootConfirmFolder', { name: pakName })
                  : t('pak.deleteRootConfirmFile', { name: pakName })
              }}
            </p>
            <div class="flex justify-end gap-2.5">
              <button
                class="inline-flex items-center justify-center rounded-lg border border-border bg-hover px-4 py-2 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
                @click="cancelDeleteRoot"
              >{{ t('common.cancel') }}</button>
              <button
                class="inline-flex items-center justify-center rounded-lg bg-red px-4 py-2 text-sm text-white cursor-pointer transition duration-150 enabled:hover:-translate-y-px enabled:hover:bg-[#f87171] disabled:cursor-not-allowed disabled:bg-[#555] disabled:opacity-50"
                @click="confirmDeleteRoot"
              >{{ t('pak.deleteConfirmAction') }}</button>
            </div>
          </template>
        </div>
      </div>
      <div v-if="confirmTarget" class="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/60 p-5" @click.self="cancelDelete">
        <div class="w-full max-w-[420px] rounded-[10px] border border-border bg-card px-5 py-[18px] shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
          <h4 class="m-0 mb-2 text-bright">{{ t('pak.deleteConfirmTitle') }}</h4>
          <p class="m-0 mb-4 break-words text-[13px] text-text">
            {{
              confirmTarget.isDir
                ? t('pak.deleteConfirmFolder', { name: confirmTarget.name })
                : t('pak.deleteConfirmFile', { name: confirmTarget.name })
            }}
          </p>
          <div class="flex justify-end gap-2.5">
            <button
              class="inline-flex items-center justify-center rounded-lg border border-border bg-hover px-4 py-2 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="state.actionRunning"
              @click="cancelDelete"
            >{{ t('common.cancel') }}</button>
            <button
              class="inline-flex items-center justify-center rounded-lg bg-red px-4 py-2 text-sm text-white cursor-pointer transition duration-150 enabled:hover:-translate-y-px enabled:hover:bg-[#f87171] disabled:cursor-not-allowed disabled:bg-[#555] disabled:opacity-50"
              :disabled="state.actionRunning"
              @click="confirmDelete"
            >
              <span v-if="state.actionRunning" class="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>{{ t('pak.deleteConfirmAction') }}
            </button>
          </div>
        </div>
      </div>
      <div v-if="pendingDrop" class="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/60 p-5" @click.self="cancelOverwrite">
        <div class="w-full max-w-[420px] rounded-[10px] border border-border bg-card px-5 py-[18px] shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
          <h4 class="m-0 mb-2 text-bright">{{ t('pak.overwriteConfirmTitle') }}</h4>
          <p class="m-0 mb-4 break-words text-[13px] text-text">{{ t('pak.overwriteConfirmBody', { n: pendingDrop.conflicts.length }) }}</p>
          <ul class="m-0 mb-4 max-h-40 list-disc overflow-y-auto pl-[18px] font-mono text-xs text-dim">
            <li v-for="name in pendingDrop.conflicts.slice(0, 20)" :key="name" class="[overflow-wrap:break-word] [word-break:break-all]">{{ name }}</li>
            <li v-if="pendingDrop.conflicts.length > 20">…</li>
          </ul>
          <div class="flex justify-end gap-2.5">
            <button
              class="inline-flex items-center justify-center rounded-lg border border-border bg-hover px-4 py-2 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="state.actionRunning"
              @click="cancelOverwrite"
            >{{ t('common.cancel') }}</button>
            <button
              class="inline-flex items-center justify-center rounded-lg bg-red px-4 py-2 text-sm text-white cursor-pointer transition duration-150 enabled:hover:-translate-y-px enabled:hover:bg-[#f87171] disabled:cursor-not-allowed disabled:bg-[#555] disabled:opacity-50"
              :disabled="state.actionRunning"
              @click="confirmOverwrite"
            >
              <span v-if="state.actionRunning" class="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>{{ t('pak.overwriteConfirmAction') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
