<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PakDatabaseInfo } from '../../shared/api-types'
import { useElectron } from '../composables/useElectron'

const props = defineProps<{ open: boolean; initialDbPath?: string | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const electron = useElectron()

const loading = ref(false)
const building = ref(false)
const dbInfo = ref<PakDatabaseInfo | null>(null)
const error = ref('')
const requestId = ref(0)

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
}

function emptyRoot(): TreeNode {
  return { name: '', key: '', children: new Map(), kind: 'dir', count: 0 }
}

const treeRoot = ref<TreeNode>(emptyRoot())
const expanded = ref<Set<string>>(new Set())

function sortChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    const aDir = a.kind === 'dir'
    const bDir = b.kind === 'dir'
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

const visibleRows = computed<VisibleRow[]>(() => {
  const rows: VisibleRow[] = []
  function visit(node: TreeNode, depth: number): void {
    for (const child of sortChildren(node)) {
      const expandable = child.children.size > 0
      const isExpanded = expanded.value.has(child.key)
      rows.push({
        key: child.key,
        name: child.name,
        depth,
        isDir: child.kind === 'dir',
        expandable,
        expanded: isExpanded,
        count: child.count,
      })
      if (expandable && isExpanded) visit(child, depth + 1)
    }
  }
  visit(treeRoot.value, 0)
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

function toggleNode(key: string): void {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

function onRowClick(row: VisibleRow): void {
  if (row.expandable) toggleNode(row.key)
}

function fileExt(name: string): string {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return 'FILE'
  const ext = base.slice(dot + 1).toUpperCase()
  return ext.length > 4 ? ext.slice(0, 4) : ext
}

function isPakName(name: string): boolean {
  return name.toLowerCase().endsWith('.pak')
}

// Counts are only shown for folders and .pak files (never for plain files).
function showCount(row: VisibleRow): boolean {
  if (!row.isDir && !isPakName(row.name)) return false
  return row.count > 0
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
    const rel = (pak.relPakPath ?? '').trim()
    const relParts = rel.split('/').filter((p) => p.length > 0)
    if (relParts.length === 0) continue
    // The pak itself is a file node whose children are the files it originally held.
    const pakNode = ensureNode(root, '', relParts, 'file')
    await step()
    for (const file of pak.files ?? []) {
      const fileParts = file.split('/').filter((p) => p.length > 0)
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
    const result = await electron.readPakDatabase(dbPath)
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

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      requestId.value += 1
      if (props.initialDbPath) {
        void loadDatabase(props.initialDbPath)
      } else {
        error.value = t('db.emptyStructure')
      }
    }
  }
)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  }
)
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
          class="inline-flex h-8 w-8 min-w-8 items-center justify-center rounded-lg border border-red bg-transparent p-0 text-[15px] font-bold leading-none text-red cursor-pointer transition duration-150 enabled:hover:bg-red/15"
          aria-label="Close"
          @click="emit('close')"
        >X</button>
      </div>
      <div class="flex min-h-0 flex-1 overflow-hidden px-5 py-4">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-deepest p-1 font-mono text-xs">
          <div v-if="loading || building" class="flex flex-1 items-center justify-center gap-2 text-[13px] text-dim">
            <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white"></span>{{ t('db.loading') }}
          </div>
          <div v-else-if="error" class="flex flex-1 items-center justify-center gap-2 text-[13px] text-red">{{ error }}</div>
          <div v-else-if="visibleRows.length === 0" class="flex flex-1 items-center justify-center gap-2 text-[13px] text-dim">{{ t('db.emptyStructure') }}</div>
          <template v-else>
            <div
              v-for="row in visibleRows"
              :key="row.key"
              class="flex min-h-7 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded px-1.5 py-[3px] hover:bg-hover"
              :class="row.expandable ? 'cursor-pointer' : ''"
              :style="{ paddingLeft: `${4 + row.depth * 14}px` }"
              @click="onRowClick(row)"
            >
              <button
                v-if="row.expandable"
                type="button"
                class="inline-flex h-[18px] w-[18px] min-w-[18px] flex-none items-center justify-center rounded border border-border bg-transparent p-0 text-[15px] font-bold leading-none text-text cursor-pointer transition duration-150 enabled:hover:bg-hover"
                @click.stop="toggleNode(row.key)"
              >{{ row.expanded ? '−' : '+' }}</button>
              <span v-else class="w-[18px] flex-none"></span>
              <svg v-if="row.isDir" class="h-[18px] w-7 flex-none text-accent" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M1.4 3.6a1.2 1.2 0 0 1 1.2-1.2h3l1.4 1.6h6.4a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H2.6a1.2 1.2 0 0 1-1.2-1.2z" />
              </svg>
              <span v-else class="inline-flex h-[18px] w-7 flex-none items-center justify-center rounded border border-accent/55 bg-accent/[0.16] px-0.5 font-sans text-[7px] font-bold uppercase leading-none tracking-[0.2px] text-accent">{{ fileExt(row.name) }}</span>
              <span class="min-w-0 flex-1 truncate" :class="row.isDir ? 'text-bright' : 'text-text'" :title="row.key">{{ row.name }}</span>
              <span v-if="showCount(row)" class="ml-2 min-w-10 flex-none text-right text-[11px] tabular-nums text-dim">{{ row.count }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
