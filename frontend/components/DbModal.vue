<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PakDatabaseInfo } from '../../shared/api-types'
import { getShowFileNames, useElectron } from '../composables/useElectron'
import { useAppState } from '../composables/useAppState'
import { useIndexedTreeSearch } from '../composables/useIndexedTreeSearch'
import { useVirtualWindow } from '../composables/useVirtualWindow'
import { emptyDbRoot, isDbSearchDir, type DbTreeNode } from '../lib/pak-database-tree'
import { warmDatabaseCache } from '../lib/warm-database-cache'

const props = defineProps<{ open: boolean; initialDbPath?: string | null; folderPath?: string | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const { t } = useI18n()
const electron = useElectron()
const { state, logI18n, clearLog, setProgress, setSummary, setActionRunning, dirLabel } = useAppState()

const loading = ref(false)
const building = ref(false)
const dbInfo = ref<PakDatabaseInfo | null>(null)
const error = ref('')
const requestId = ref(0)
const selected = ref<string[]>([])
const searchInput = ref('')
const searchQuery = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined
const expandingKey = ref<string | null>(null)

type TreeNode = DbTreeNode

interface VisibleRow {
  key: string
  name: string
  depth: number
  isDir: boolean
  expandable: boolean
  expanded: boolean
  count: number
  node: TreeNode
}

interface SelectedRow {
  key: string
  name: string
  depth: number
  isDir: boolean
  count: number
  node: TreeNode
}

const treeRoot = shallowRef<TreeNode>(emptyDbRoot())
const expanded = ref<Set<string>>(new Set())
const selectedExpanded = ref<Set<string>>(new Set())

function toVisibleRow(node: TreeNode, depth: number, isOpen: boolean, _mode: 'browse' | 'search'): VisibleRow {
  const expandable = node.children.size > 0
  return {
    key: node.key,
    name: node.name,
    depth,
    isDir: node.kind === 'dir',
    expandable,
    expanded: isOpen,
    count: node.count,
    node,
  }
}

const {
  searchBusy,
  listCount: leftCount,
  rowsForWindow,
  setIndex,
  cancelSearch,
} = useIndexedTreeSearch<TreeNode, VisibleRow>({
  treeRoot,
  expanded,
  searchQuery,
  isDir: isDbSearchDir,
  toRow: toVisibleRow,
})

function sortChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0 || a.kind === 'dir'
    const bDir = b.children.size > 0 || b.kind === 'dir'
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function splitRel(value: string): string[] {
  return value.replace(/\\/g, '/').split('/').filter((part) => part.length > 0)
}

const searchActive = computed(() => searchQuery.value.trim().length > 0)
const searchPending = computed(() => searchInput.value.trim() !== searchQuery.value.trim())
const isSelected = (file: string): boolean => selected.value.includes(file)

watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!value.trim()) {
    searchQuery.value = ''
    return
  }
  searchTimer = setTimeout(() => {
    searchQuery.value = value
  }, 200)
})

const {
  start: leftStart,
  end: leftEnd,
  totalHeight: leftTotalHeight,
  onScroll: onLeftScroll,
  bind: bindLeftScroll,
  rowTop: leftRowTop,
  scrollToTop: scrollLeftToTop,
} = useVirtualWindow(leftCount)
const windowedRows = computed(() => rowsForWindow(leftStart.value, leftEnd.value))

watch(searchQuery, () => {
  scrollLeftToTop()
})

const selectedTree = computed<TreeNode>(() => {
  const root = emptyDbRoot()
  for (const file of selected.value) {
    const parts = splitRel(file)
    let node = root
    let currentKey = ''
    for (let j = 0; j < parts.length; j += 1) {
      const part = parts[j] as string
      const last = j === parts.length - 1
      currentKey = currentKey ? `${currentKey}/${part}` : part
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, key: currentKey, children: new Map(), kind: last ? 'file' : 'dir', count: 0 }
        node.children.set(part, child)
      } else if (last) {
        child.kind = 'file'
      }
      if (!last) child.count += 1
      node = child
    }
  }
  return root
})

const selectedRows = computed<SelectedRow[]>(() => {
  const rows: SelectedRow[] = []
  function visit(node: TreeNode, depth: number): void {
    for (const child of sortChildren(node)) {
      const isDir = child.children.size > 0
      rows.push({ key: child.key, name: child.name, depth, isDir, count: child.count, node: child })
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
  rowTop: selectedRowTop,
} = useVirtualWindow(selectedCount)
const windowedSelected = computed(() => {
  const rows = selectedRows.value
  const items: { row: SelectedRow; index: number }[] = []
  for (let i = selectedStart.value; i < selectedEnd.value; i += 1) {
    const row = rows[i]
    if (row) items.push({ row, index: i })
  }
  return items
})

const rootLabel = computed(() => dbInfo.value?.folderName ?? dbInfo.value?.relPakPath ?? '')
const fileTotal = computed(() => {
  const info = dbInfo.value
  if (!info) return 0
  if (info.paks && info.paks.length > 0) {
    return info.paks.reduce((n, pak) => n + (pak.fileCount ?? pak.files.length), 0)
  }
  return info.files?.length ?? 0
})

const selectedPakCount = computed(() => {
  const info = dbInfo.value
  if (!info || selected.value.length === 0) return 0
  const rels = info.paks && info.paks.length > 0
    ? info.paks.map((pak) => splitRel(pak.relPakPath).join('/')).filter((rel) => rel.length > 0)
    : info.relPakPath
      ? [splitRel(info.relPakPath).join('/')]
      : []
  if (rels.length === 0) return 0
  const hit = new Set<string>()
  for (const file of selected.value) {
    let best = ''
    for (const rel of rels) {
      if ((file === rel || file.startsWith(`${rel}/`)) && rel.length > best.length) best = rel
    }
    if (best) hit.add(best)
  }
  return hit.size
})

function isPakName(name: string): boolean {
  return name.toLowerCase().endsWith('.pak')
}

function showCount(row: { isDir: boolean; name: string; count: number }): boolean {
  if (!row.isDir && !isPakName(row.name)) return false
  return row.count > 0
}

function showAsFolder(row: { isDir: boolean; name: string }): boolean {
  return row.isDir && !isPakName(row.name)
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

function collectLeafFiles(node: TreeNode, out: string[] = []): string[] {
  if (node.kind === 'file' && node.children.size === 0 && node.key) out.push(node.key)
  for (const child of node.children.values()) collectLeafFiles(child, out)
  return out
}

function addFile(file: string): void {
  if (state.actionRunning || !file) return
  if (!isSelected(file)) selected.value = [...selected.value, file]
}

function removeFile(file: string): void {
  if (state.actionRunning) return
  selected.value = selected.value.filter((entry) => entry !== file)
}

function addFolder(node: TreeNode): void {
  if (state.actionRunning) return
  const additions = collectLeafFiles(node).filter((file) => !isSelected(file))
  if (additions.length === 0) return
  selected.value = [...selected.value, ...additions]
}

function removeFolder(node: TreeNode): void {
  if (state.actionRunning) return
  const toRemove = new Set(collectLeafFiles(node))
  selected.value = selected.value.filter((file) => !toRemove.has(file))
}

function onRowClick(row: VisibleRow): void {
  if (state.actionRunning) return
  if (row.expandable) toggleNode(row.key)
  else addFile(row.key)
}

function defaultExpanded(root: TreeNode): Set<string> {
  const next = new Set<string>()
  for (const child of sortChildren(root)) {
    if (child.children.size > 0) next.add(child.key)
  }
  return next
}

async function loadDatabase(dbPath: string): Promise<void> {
  const id = ++requestId.value
  loading.value = true
  building.value = true
  error.value = ''
  dbInfo.value = null
  cancelSearch()
  setIndex(null)
  treeRoot.value = emptyDbRoot()
  expanded.value = new Set()
  try {
    const cached = await warmDatabaseCache(dbPath, state.customDirs.unpaked || undefined, electron)
    if (id !== requestId.value) return
    if (!cached) return
    dbInfo.value = cached.meta
    setIndex(cached.index)
    treeRoot.value = cached.root
    expanded.value = defaultExpanded(cached.root)
  } catch (err) {
    if (id !== requestId.value) return
    error.value = t('db.readFail', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (id === requestId.value) {
      loading.value = false
      building.value = false
    }
  }
}

async function repakSelected(): Promise<void> {
  const folderPath = props.folderPath
  if (!folderPath || selected.value.length === 0 || state.actionRunning) return
  const entries = [...selected.value]
  const pakCount = Math.max(selectedPakCount.value, 1)
  let succeeded = false
  setActionRunning(true)
  clearLog()
  setSummary(t('db.repakingN', { n: entries.length, paks: pakCount }), 'info')
  logI18n('db.repakingNLog', { n: entries.length })
  try {
    const result = await electron.repackUnpakedSelection({
      folderPath,
      entries,
      showFileProgress: getShowFileNames(),
      repakedDir: state.customDirs.repaked || undefined,
      unpakedDir: state.customDirs.unpaked || undefined,
    })
    if (result.canceled) {
      logI18n('progress.canceled', undefined, 'warning')
      setSummary(t('progress.canceled'), 'info')
      return
    }
    if (result.success) {
      const successCount = result.results?.success.length ?? 0
      const failedCount = result.results?.failed.length ?? 0
      logI18n('db.repakDone', { ok: successCount, fail: failedCount }, failedCount > 0 ? 'error' : 'success')
      if (failedCount > 0) {
        result.results?.failed.forEach((fail) => {
          const entry = fail as { pak?: string; error?: string }
          logI18n('db.repakFailItem', { pak: entry.pak ?? '', error: entry.error ?? '' }, 'error')
        })
        setSummary(t('db.repakPartial', { ok: successCount, fail: failedCount }), 'error')
      } else {
        setSummary(t('db.repakAllOk', { n: successCount, dir: dirLabel('repaked') }), 'success')
        succeeded = true
      }
    } else {
      logI18n('pak.actionFailedOp', { error: result.error }, 'error')
      setSummary(t('db.repakFailTitle'), 'error')
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

function close(): void {
  if (state.actionRunning) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (searchInput.value.length > 0 || searchQuery.value.length > 0) {
    searchInput.value = ''
    searchQuery.value = ''
    return
  }
  close()
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      requestId.value += 1
      selected.value = []
      searchInput.value = ''
      searchQuery.value = ''
      error.value = ''
      dbInfo.value = null
      cancelSearch()
      setIndex(null)
      treeRoot.value = emptyDbRoot()
      expanded.value = new Set()
      selectedExpanded.value = new Set()
      expandingKey.value = null
      if (props.initialDbPath) {
        void loadDatabase(props.initialDbPath)
      } else {
        error.value = t('db.emptyStructure')
      }
      window.addEventListener('keydown', onKeydown)
    } else {
      cancelSearch()
      setIndex(null)
      treeRoot.value = emptyDbRoot()
      expanded.value = new Set()
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
        <div class="min-w-0">
          <h3 class="m-0 truncate text-bright">{{ t('db.title') }}</h3>
          <div v-if="rootLabel" class="mt-0.5 truncate text-[13px] text-dim">
            {{ rootLabel }}<span v-if="fileTotal > 0"> • {{ t('db.files', { n: fileTotal }) }}</span>
          </div>
        </div>
        <button
          class="inline-flex h-8 w-8 min-w-8 items-center justify-center rounded-lg border border-red bg-transparent p-0 text-[15px] font-bold leading-none text-red cursor-pointer transition duration-150 enabled:hover:bg-red/15 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="state.actionRunning"
          aria-label="Close"
          @click="close"
        >X</button>
      </div>
      <div class="flex min-h-0 flex-1 gap-4 overflow-hidden px-5 py-4">
        <div class="flex min-h-0 min-w-0 w-[calc(50%-8px)] flex-none flex-col gap-2">
          <div class="flex flex-none items-center justify-between gap-2 text-[13px] font-semibold text-bright">
            <span>{{ t('pak.allFiles') }}</span>
            <span
              v-if="!loading && !building && !error"
              class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-deepest px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums whitespace-nowrap text-bright"
            >{{ fileTotal }}</span>
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
            <div v-if="loading || building" class="flex h-full items-center justify-center gap-2 text-[13px] text-dim">
              <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>{{ t('db.loading') }}
            </div>
            <div v-else-if="error" class="flex h-full items-center justify-center gap-2 text-[13px] text-red">{{ error }}</div>
            <div v-else-if="searchBusy" class="flex h-full items-center justify-center gap-2 text-[13px] text-dim">
              <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>
            </div>
            <div v-else-if="searchActive && leftCount === 0" class="flex h-full items-center justify-center gap-2 text-[13px] text-dim">{{ t('pak.searchEmpty') }}</div>
            <div v-else-if="leftCount === 0" class="flex h-full items-center justify-center gap-2 text-[13px] text-dim">{{ t('db.emptyStructure') }}</div>
            <div v-else class="relative w-full" :style="{ height: `${leftTotalHeight}px` }">
              <div
                v-for="item in windowedRows"
                :key="item.row.key"
                class="absolute inset-x-0 flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap px-1.5 hover:bg-hover"
                :class="{ 'bg-accent/[0.18]': !item.row.expandable && isSelected(item.row.key) }"
                :style="{ top: `${leftRowTop(item.index)}px`, paddingLeft: `${4 + item.row.depth * 14}px` }"
                @click="onRowClick(item.row)"
              >
                <button
                  v-if="item.row.expandable"
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
                <svg v-if="showAsFolder(item.row)" class="h-[18px] w-7 flex-none text-accent" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M1.4 3.6a1.2 1.2 0 0 1 1.2-1.2h3l1.4 1.6h6.4a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H2.6a1.2 1.2 0 0 1-1.2-1.2z" />
                </svg>
                <span v-else class="inline-flex h-[18px] w-7 flex-none items-center justify-center rounded border border-accent/55 bg-accent/[0.16] px-0.5 font-sans text-[7px] font-bold uppercase leading-none tracking-[0.2px] text-accent">{{ fileExt(item.row.name) }}</span>
                <span class="min-w-0 flex-1 truncate" :class="item.row.isDir || item.row.expandable ? 'text-bright' : 'text-text'" :title="item.row.key">{{ item.row.name }}</span>
                <span v-if="showCount(item.row)" class="ml-2 min-w-10 flex-none text-right text-[11px] tabular-nums text-dim">{{ item.row.count }}</span>
                <button
                  v-if="item.row.expandable"
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
        </div>
        <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
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
              v-for="item in windowedSelected"
              :key="item.row.key"
              class="absolute inset-x-0 flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap px-1.5 hover:bg-hover"
              :style="{ top: `${selectedRowTop(item.index)}px`, paddingLeft: `${4 + item.row.depth * 14}px` }"
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
              <svg v-if="showAsFolder(item.row)" class="h-[18px] w-7 flex-none text-accent" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M1.4 3.6a1.2 1.2 0 0 1 1.2-1.2h3l1.4 1.6h6.4a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H2.6a1.2 1.2 0 0 1-1.2-1.2z" />
              </svg>
              <span v-else class="inline-flex h-[18px] w-7 flex-none items-center justify-center rounded border border-accent/55 bg-accent/[0.16] px-0.5 font-sans text-[7px] font-bold uppercase leading-none tracking-[0.2px] text-accent">{{ fileExt(item.row.name) }}</span>
              <span
                class="min-w-0 flex-1 truncate"
                :class="item.row.isDir ? 'text-bright' : 'text-text'"
                :title="item.row.isDir ? t('pak.toggleFolderHint') : item.row.key"
                @click="item.row.isDir ? toggleSelectedNode(item.row.key) : removeFile(item.row.key)"
              >{{ item.row.name }}</span>
              <span v-if="showCount(item.row)" class="ml-2 min-w-10 flex-none text-right text-[11px] tabular-nums text-dim">{{ item.row.count }}</span>
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
          <div class="flex flex-none items-center justify-end gap-3">
            <button
              class="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm text-white cursor-pointer transition duration-150 enabled:hover:-translate-y-px enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-[#555] disabled:opacity-50"
              :disabled="state.actionRunning || selected.length === 0"
              v-app-title="t('db.repakHint')"
              @click="repakSelected"
            >
              <span v-if="state.actionRunning" class="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>{{ t('unpaked.repak') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
