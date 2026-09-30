<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PakDatabaseInfo } from '../../shared/api-types'
import { getShowFileNames, useElectron } from '../composables/useElectron'
import { useAppState } from '../composables/useAppState'

const props = defineProps<{ open: boolean; initialDbPath?: string | null; folderPath?: string | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const { t } = useI18n()
const electron = useElectron()
const { state, log, clearLog, setProgress, setSummary, setActionRunning, dirLabel } = useAppState()

const loading = ref(false)
const building = ref(false)
const dbInfo = ref<PakDatabaseInfo | null>(null)
const error = ref('')
const requestId = ref(0)
const selected = ref<string[]>([])
const searchQuery = ref('')
const expandingKey = ref<string | null>(null)

type NodeKind = 'dir' | 'file'

interface TreeNode {
  name: string
  key: string
  children: Map<string, TreeNode>
  kind: NodeKind
  count: number
}

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

function emptyRoot(): TreeNode {
  return { name: '', key: '', children: new Map(), kind: 'dir', count: 0 }
}

const treeRoot = ref<TreeNode>(emptyRoot())
const expanded = ref<Set<string>>(new Set())
const selectedExpanded = ref<Set<string>>(new Set())

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
const isSelected = (file: string): boolean => selected.value.includes(file)

const visibleRows = computed<VisibleRow[]>(() => {
  const rows: VisibleRow[] = []
  const query = searchQuery.value.trim().toLowerCase()
  function push(node: TreeNode, depth: number): void {
    const expandable = node.children.size > 0
    const isExpanded = expanded.value.has(node.key)
    rows.push({
      key: node.key,
      name: node.name,
      depth,
      isDir: node.kind === 'dir',
      expandable,
      expanded: isExpanded,
      count: node.count,
      node,
    })
    if (expandable && isExpanded) {
      for (const child of sortChildren(node)) push(child, depth + 1)
    }
  }
  if (query) {
    function collectMatches(node: TreeNode): TreeNode[] {
      const matches: TreeNode[] = []
      for (const child of node.children.values()) {
        if (child.name.toLowerCase().includes(query)) matches.push(child)
        else matches.push(...collectMatches(child))
      }
      return matches
    }
    const matches = collectMatches(treeRoot.value)
    matches.sort((a, b) => {
      const aDir = a.children.size > 0 || a.kind === 'dir'
      const bDir = b.children.size > 0 || b.kind === 'dir'
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.key.localeCompare(b.key)
    })
    for (const match of matches) push(match, 0)
    return rows
  }
  for (const child of sortChildren(treeRoot.value)) push(child, 0)
  return rows
})

const selectedTree = computed<TreeNode>(() => {
  const root = emptyRoot()
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
  if (!info) return 0
  const paks = info.paks && info.paks.length > 0
    ? info.paks
    : info.relPakPath
      ? [{ relPakPath: info.relPakPath, files: info.files ?? [] }]
      : []
  const keys = new Set(selected.value)
  let count = 0
  for (const pak of paks) {
    const rel = splitRel(pak.relPakPath).join('/')
    const hit = pak.files.some((file) => {
      const relFile = splitRel(file).join('/')
      if (!relFile) return false
      return keys.has(rel ? `${rel}/${relFile}` : relFile)
    })
    if (hit) count += 1
  }
  return count
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

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function ensureNode(root: TreeNode, baseKey: string, parts: string[], leafKind: NodeKind): TreeNode {
  let node = root
  let currentKey = baseKey
  for (let j = 0; j < parts.length; j += 1) {
    const part = parts[j] as string
    const last = j === parts.length - 1
    currentKey = currentKey ? `${currentKey}/${part}` : part
    let child = node.children.get(part)
    if (!child) {
      child = { name: part, key: currentKey, children: new Map(), kind: last ? leafKind : 'dir', count: 0 }
      node.children.set(part, child)
    } else if (last) {
      child.kind = leafKind
    }
    node = child
  }
  return node
}

function computeCounts(node: TreeNode): number {
  if (node.children.size === 0) {
    node.count = node.kind === 'file' ? 1 : 0
    return node.count
  }
  let total = 0
  for (const child of node.children.values()) total += computeCounts(child)
  node.count = total
  return total
}

async function buildReconstructedTreeChunked(info: PakDatabaseInfo): Promise<TreeNode> {
  const root = emptyRoot()
  let ops = 0
  const step = async (): Promise<void> => {
    ops += 1
    if (ops % 500 === 0) await yieldToUi()
  }
  const entries = info.paks && info.paks.length > 0
    ? info.paks
    : [{ relPakPath: info.relPakPath ?? '', files: info.files ?? [] }]
  for (const pak of entries) {
    const rel = (pak.relPakPath ?? '').trim().replace(/\\/g, '/')
    const relParts = splitRel(rel)
    if (relParts.length === 0) continue
    const pakNode = ensureNode(root, '', relParts, 'file')
    await step()
    for (const file of pak.files ?? []) {
      const fileParts = splitRel(file)
      if (fileParts.length === 0) continue
      ensureNode(pakNode, rel, fileParts, 'file')
      await step()
    }
  }
  computeCounts(root)
  return root
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
  building.value = false
  error.value = ''
  dbInfo.value = null
  treeRoot.value = emptyRoot()
  expanded.value = new Set()
  try {
    const result = await electron.readPakDatabase(dbPath, state.customDirs.unpaked || undefined)
    if (id !== requestId.value) return
    if (!result.success || !result.info) {
      error.value = t('db.readFail', { error: result.error })
      return
    }
    dbInfo.value = result.info
    loading.value = false
    building.value = true
    const root = await buildReconstructedTreeChunked(result.info)
    if (id !== requestId.value) return
    treeRoot.value = root
    expanded.value = defaultExpanded(root)
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
  log(t('db.repakingNLog', { n: entries.length }))
  try {
    const result = await electron.repackUnpakedSelection({
      folderPath,
      entries,
      showFileProgress: getShowFileNames(),
      repakedDir: state.customDirs.repaked || undefined,
      unpakedDir: state.customDirs.unpaked || undefined,
    })
    if (result.canceled) {
      log(t('progress.canceled'), 'warning')
      setSummary(t('progress.canceled'), 'info')
      return
    }
    if (result.success) {
      const successCount = result.results?.success.length ?? 0
      const failedCount = result.results?.failed.length ?? 0
      log(t('db.repakDone', { ok: successCount, fail: failedCount }), failedCount > 0 ? 'error' : 'success')
      if (failedCount > 0) {
        result.results?.failed.forEach((fail) => {
          const entry = fail as { pak?: string; error?: string }
          log(t('db.repakFailItem', { pak: entry.pak ?? '', error: entry.error ?? '' }), 'error')
        })
        setSummary(t('db.repakPartial', { ok: successCount, fail: failedCount }), 'error')
      } else {
        setSummary(t('db.repakAllOk', { n: successCount, dir: dirLabel('repaked') }), 'success')
        succeeded = true
      }
    } else {
      log(t('pak.actionFailedOp', { error: result.error }), 'error')
      setSummary(t('db.repakFailTitle'), 'error')
    }
  } catch (err) {
    log(t('pak.unexpectedLog', { error: err instanceof Error ? err.message : String(err) }), 'error')
    setSummary(t('pak.unexpected'), 'error')
  } finally {
    setActionRunning(false)
    setProgress(0, t('progress.idle'))
    if (succeeded) emit('done')
  }
}

function close(): void {
  if (state.actionRunning) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (searchQuery.value.length > 0) {
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
      searchQuery.value = ''
      error.value = ''
      dbInfo.value = null
      treeRoot.value = emptyRoot()
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
      window.removeEventListener('keydown', onKeydown)
    }
  },
)

onBeforeUnmount(() => {
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
          <input
            v-model="searchQuery"
            class="min-w-0 flex-none rounded-[10px] border border-border bg-deepest px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(79,143,255,0.15)]"
            type="text"
            :placeholder="t('pak.searchPlaceholder')"
          />
          <div class="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-deepest p-1 font-mono text-xs">
            <div v-if="loading || building" class="flex flex-1 items-center justify-center gap-2 text-[13px] text-dim">
              <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>{{ t('db.loading') }}
            </div>
            <div v-else-if="error" class="flex flex-1 items-center justify-center gap-2 text-[13px] text-red">{{ error }}</div>
            <div v-else-if="searchActive && visibleRows.length === 0" class="flex flex-1 items-center justify-center gap-2 text-[13px] text-dim">{{ t('pak.searchEmpty') }}</div>
            <div v-else-if="visibleRows.length === 0" class="flex flex-1 items-center justify-center gap-2 text-[13px] text-dim">{{ t('db.emptyStructure') }}</div>
            <template v-else>
              <div
                v-for="row in visibleRows"
                :key="row.key"
                class="flex min-h-7 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded px-1.5 py-[3px] hover:bg-hover"
                :class="{ 'bg-accent/[0.18]': !row.expandable && isSelected(row.key) }"
                :style="{ paddingLeft: `${4 + row.depth * 14}px` }"
                @click="onRowClick(row)"
              >
                <button
                  v-if="row.expandable"
                  type="button"
                  class="inline-flex h-[18px] w-[18px] min-w-[18px] flex-none items-center justify-center rounded border border-border bg-transparent p-0 text-[15px] font-bold leading-none text-text cursor-pointer transition duration-150 enabled:hover:bg-hover"
                  :title="t('pak.toggleFolderHint')"
                  :disabled="state.actionRunning || expandingKey !== null"
                  @click.stop="toggleNode(row.key)"
                >
                  <span v-if="expandingKey === row.key" class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>
                  <template v-else>{{ row.expanded ? '−' : '+' }}</template>
                </button>
                <span v-else class="w-[18px] flex-none"></span>
                <svg v-if="showAsFolder(row)" class="h-[18px] w-7 flex-none text-accent" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M1.4 3.6a1.2 1.2 0 0 1 1.2-1.2h3l1.4 1.6h6.4a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H2.6a1.2 1.2 0 0 1-1.2-1.2z" />
                </svg>
                <span v-else class="inline-flex h-[18px] w-7 flex-none items-center justify-center rounded border border-accent/55 bg-accent/[0.16] px-0.5 font-sans text-[7px] font-bold uppercase leading-none tracking-[0.2px] text-accent">{{ fileExt(row.name) }}</span>
                <span class="min-w-0 flex-1 truncate" :class="row.isDir || row.expandable ? 'text-bright' : 'text-text'" :title="row.key">{{ row.name }}</span>
                <span v-if="showCount(row)" class="ml-2 min-w-10 flex-none text-right text-[11px] tabular-nums text-dim">{{ row.count }}</span>
                <button
                  v-if="row.expandable"
                  type="button"
                  class="ml-1 inline-flex h-[18px] w-[18px] min-w-[18px] flex-none items-center justify-center rounded border-none bg-transparent p-0 text-[13px] leading-none text-dim cursor-pointer enabled:hover:bg-accent/20 enabled:hover:text-bright"
                  :title="t('pak.addFolderHint')"
                  :disabled="state.actionRunning"
                  @click.stop="addFolder(row.node)"
                >&#8594;</button>
                <span v-else class="w-[18px] flex-none"></span>
              </div>
            </template>
          </div>
        </div>
        <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div class="flex flex-none items-center justify-between gap-2 text-[13px] font-semibold text-bright">
            <span>{{ t('pak.selectedFiles') }}</span>
            <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-deepest px-1.5 text-center text-[11px] font-semibold leading-none tabular-nums whitespace-nowrap text-bright">{{ selected.length }}</span>
          </div>
          <div class="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-deepest p-1 font-mono text-xs">
            <div v-if="selected.length === 0" class="flex h-full flex-1 items-center justify-center p-4 text-center font-sans text-[13px] text-dim">{{ t('pak.selectFilesFirst') }}</div>
            <div
              v-for="row in selectedRows"
              :key="row.key"
              class="flex min-h-7 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded px-1.5 py-[3px] hover:bg-hover"
              :style="{ paddingLeft: `${4 + row.depth * 14}px` }"
              @click="!row.isDir && removeFile(row.key)"
            >
              <button
                v-if="row.isDir"
                type="button"
                class="inline-flex h-[18px] w-[18px] min-w-[18px] flex-none items-center justify-center rounded border border-border bg-transparent p-0 text-[15px] font-bold leading-none text-text cursor-pointer transition duration-150 enabled:hover:bg-hover"
                :title="t('pak.toggleFolderHint')"
                :disabled="state.actionRunning"
                @click.stop="toggleSelectedNode(row.key)"
              >{{ selectedExpanded.has(row.key) ? '−' : '+' }}</button>
              <span v-else class="w-[18px] flex-none"></span>
              <svg v-if="showAsFolder(row)" class="h-[18px] w-7 flex-none text-accent" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M1.4 3.6a1.2 1.2 0 0 1 1.2-1.2h3l1.4 1.6h6.4a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H2.6a1.2 1.2 0 0 1-1.2-1.2z" />
              </svg>
              <span v-else class="inline-flex h-[18px] w-7 flex-none items-center justify-center rounded border border-accent/55 bg-accent/[0.16] px-0.5 font-sans text-[7px] font-bold uppercase leading-none tracking-[0.2px] text-accent">{{ fileExt(row.name) }}</span>
              <span
                class="min-w-0 flex-1 truncate"
                :class="row.isDir ? 'text-bright' : 'text-text'"
                :title="row.isDir ? t('pak.toggleFolderHint') : row.key"
                @click="row.isDir ? toggleSelectedNode(row.key) : removeFile(row.key)"
              >{{ row.name }}</span>
              <span v-if="showCount(row)" class="ml-2 min-w-10 flex-none text-right text-[11px] tabular-nums text-dim">{{ row.count }}</span>
              <button
                type="button"
                class="ml-1 inline-flex h-[18px] w-[18px] min-w-[18px] flex-none items-center justify-center rounded border-none bg-transparent p-0 text-[14px] leading-none text-dim cursor-pointer enabled:hover:bg-red/[0.18] enabled:hover:text-red"
                :title="row.isDir ? t('pak.removeFolderHint') : t('pak.removeFileHint')"
                :disabled="state.actionRunning"
                @click.stop="row.isDir ? removeFolder(row.node) : removeFile(row.key)"
              >×</button>
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
