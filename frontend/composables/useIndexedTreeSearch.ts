import { computed, onBeforeUnmount, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import {
  orderedChildren,
  searchFileTree,
  type FileTreeIndex,
  type TreeBranch,
} from '../lib/file-tree-index'

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Procura na árvore sem recriar a lista inteira a cada tecla.
 * Sem pasta aberta nos resultados, só as linhas visíveis são montadas.
 */
export function useIndexedTreeSearch<T extends TreeBranch<T>, Row>(options: {
  treeRoot: ShallowRef<T>
  expanded: Ref<Set<string>>
  searchQuery: Ref<string>
  isDir: (node: T) => boolean
  toRow: (node: T, depth: number, isOpen: boolean, mode: 'browse' | 'search') => Row
}): {
  searchBusy: Ref<boolean>
  listCount: ComputedRef<number>
  rowsForWindow: (start: number, end: number) => { row: Row; index: number }[]
  setIndex: (index: FileTreeIndex<T> | null) => void
  cancelSearch: () => void
} {
  const { treeRoot, expanded, searchQuery, isDir, toRow } = options
  const searchBusy = shallowRef(false)
  const searchHits = shallowRef<T[]>([])
  const rows = shallowRef<Row[]>([])
  const hitsExpanded = shallowRef(false)
  let index: FileTreeIndex<T> | null = null
  let generation = 0

  function projectInto(out: Row[], nodes: readonly T[], depth: number, mode: 'browse' | 'search'): void {
    const open = expanded.value
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i] as T
      const isOpen = node.children.size > 0 && open.has(node.key)
      out.push(toRow(node, depth, isOpen, mode))
      if (isOpen) projectInto(out, orderedChildren(index, node), depth + 1, mode)
    }
  }

  function buildBrowse(): Row[] {
    if (!index) return []
    const out: Row[] = []
    projectInto(out, orderedChildren(index, treeRoot.value), 0, 'browse')
    return out
  }

  function syncHitsExpanded(): void {
    if (!searchQuery.value.trim() || expanded.value.size === 0) {
      hitsExpanded.value = false
      return
    }
    const open = expanded.value
    const hits = searchHits.value
    for (let i = 0; i < hits.length; i += 1) {
      const node = hits[i] as T
      if (node.children.size > 0 && open.has(node.key)) {
        hitsExpanded.value = true
        return
      }
    }
    hitsExpanded.value = false
  }

  function showHits(): void {
    syncHitsExpanded()
    if (!hitsExpanded.value) {
      rows.value = []
      return
    }
    const out: Row[] = []
    projectInto(out, searchHits.value, 0, 'search')
    rows.value = out
  }

  function setIndex(next: FileTreeIndex<T> | null): void {
    index = next
  }

  function cancelSearch(): void {
    generation += 1
  }

  watch([searchQuery, treeRoot], async () => {
    const id = ++generation
    const query = searchQuery.value.trim().toLowerCase()
    if (!query || !index) {
      searchHits.value = []
      hitsExpanded.value = false
      rows.value = buildBrowse()
      searchBusy.value = false
      return
    }
    searchBusy.value = true
    searchHits.value = []
    hitsExpanded.value = false
    rows.value = []
    const hits = await searchFileTree(index, query, {
      isDir,
      isCancelled: () => id !== generation,
      onYield: yieldToUi,
    })
    if (hits == null || id !== generation) return
    searchHits.value = hits
    showHits()
    searchBusy.value = false
  })

  watch(expanded, () => {
    if (searchBusy.value) return
    if (searchQuery.value.trim()) {
      showHits()
      return
    }
    rows.value = buildBrowse()
  })

  const flatSearch = computed(() => searchQuery.value.trim().length > 0 && !hitsExpanded.value)
  const listCount = computed(() => (flatSearch.value ? searchHits.value.length : rows.value.length))

  function rowsForWindow(start: number, end: number): { row: Row; index: number }[] {
    const items: { row: Row; index: number }[] = []
    if (flatSearch.value) {
      const hits = searchHits.value
      for (let i = start; i < end; i += 1) {
        const node = hits[i]
        if (!node) continue
        items.push({ row: toRow(node, 0, false, 'search'), index: i })
      }
      return items
    }
    const list = rows.value
    for (let i = start; i < end; i += 1) {
      const row = list[i]
      if (row) items.push({ row, index: i })
    }
    return items
  }

  onBeforeUnmount(() => {
    generation += 1
    index = null
  })

  return { searchBusy, listCount, rowsForWindow, setIndex, cancelSearch }
}
