import { computed, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import type { DbOpenResult, DbTreeRow } from '../../shared/api-types'

export interface SqliteWindowItem {
  row: DbTreeRow
  depth: number
  expanded: boolean
  index: number
}

interface DbClient {
  dbChildren(dbPath: string, parentId: number, base?: string): Promise<{ success: boolean; rows?: DbTreeRow[]; error?: string }>
  dbSearch(dbPath: string, query: string, base?: string): Promise<{ success: boolean; ids?: number[]; error?: string }>
  dbRows(dbPath: string, ids: number[], base?: string): Promise<{ success: boolean; rows?: DbTreeRow[]; error?: string }>
}

/**
 * Left pane of the database modal backed by SQLite.
 * Browse and search ask the main process for the visible rows only.
 */
export function useSqliteDbTree(options: {
  client: DbClient
  dbPath: Ref<string>
  base: Ref<string | undefined>
  expanded: Ref<Set<string>>
  searchQuery: Ref<string>
  enabled: Ref<boolean>
}): {
  searchBusy: Ref<boolean>
  listCount: ComputedRef<number>
  rowsForWindow: (start: number, end: number) => SqliteWindowItem[]
  ensureWindow: (start: number, end: number) => void
  applyOpen: (opened: DbOpenResult) => void
  toggle: (row: DbTreeRow) => Promise<void>
  reset: () => void
  cancel: () => void
  revision: Ref<number>
} {
  const { client, dbPath, base, expanded, searchQuery, enabled } = options
  const rootRows = shallowRef<DbTreeRow[]>([])
  const browseRows = shallowRef<SqliteWindowItem[]>([])
  const projected = shallowRef<SqliteWindowItem[]>([])
  const searchIds = shallowRef<number[]>([])
  const searchExpanded = ref(false)
  const searchBusy = ref(false)
  const tick = ref(0)
  const childrenOf = new Map<number, DbTreeRow[]>()
  const rowById = new Map<number, DbTreeRow>()
  let generation = 0
  let fetchGeneration = 0

  function remember(rows: readonly DbTreeRow[]): void {
    for (const row of rows) rowById.set(row.id, row)
  }

  function project(rows: readonly DbTreeRow[], depth: number, out: SqliteWindowItem[]): void {
    const open = expanded.value
    for (const row of rows) {
      const isOpen = row.childCount > 0 && open.has(row.path)
      out.push({ row, depth, expanded: isOpen, index: out.length })
      if (!isOpen) continue
      const kids = childrenOf.get(row.id)
      if (kids) project(kids, depth + 1, out)
    }
  }

  function rebuildBrowse(): void {
    const out: SqliteWindowItem[] = []
    project(rootRows.value, 0, out)
    browseRows.value = out
  }

  function hitIsOpen(id: number): boolean {
    const row = rowById.get(id)
    return !!row && row.childCount > 0 && expanded.value.has(row.path)
  }

  function rebuildSearchProjection(): void {
    const open = expanded.value
    let any = false
    if (open.size > 0) {
      for (const id of searchIds.value) {
        if (hitIsOpen(id)) {
          any = true
          break
        }
      }
    }
    searchExpanded.value = any
    if (!any) {
      projected.value = []
      return
    }
    const out: SqliteWindowItem[] = []
    for (const id of searchIds.value) {
      const row = rowById.get(id)
      if (!row) continue
      const isOpen = row.childCount > 0 && open.has(row.path)
      out.push({ row, depth: 0, expanded: isOpen, index: out.length })
      if (!isOpen) continue
      const kids = childrenOf.get(row.id)
      if (kids) project(kids, 1, out)
    }
    projected.value = out
  }

  const flatSearch = computed(() => enabled.value && searchQuery.value.trim().length > 0 && !searchExpanded.value)
  const listCount = computed(() => {
    tick.value
    if (!enabled.value) return 0
    if (flatSearch.value) return searchIds.value.length
    if (searchQuery.value.trim().length > 0) return projected.value.length
    return browseRows.value.length
  })

  function rowsForWindow(start: number, end: number): SqliteWindowItem[] {
    tick.value
    const items: SqliteWindowItem[] = []
    if (!enabled.value) return items
    if (flatSearch.value) {
      const ids = searchIds.value
      for (let i = start; i < end; i += 1) {
        const id = ids[i]
        if (id === undefined) continue
        const row = rowById.get(id)
        if (!row) continue
        items.push({ row, depth: 0, expanded: false, index: i })
      }
      return items
    }
    const list = searchQuery.value.trim().length > 0 ? projected.value : browseRows.value
    for (let i = start; i < end; i += 1) {
      const item = list[i]
      if (item) items.push({ ...item, index: i })
    }
    return items
  }

  function ensureWindow(start: number, end: number): void {
    if (!enabled.value || !flatSearch.value) return
    const missing: number[] = []
    const ids = searchIds.value
    for (let i = start; i < end; i += 1) {
      const id = ids[i]
      if (id !== undefined && !rowById.has(id)) missing.push(id)
    }
    if (missing.length === 0) return
    const id = ++fetchGeneration
    const target = dbPath.value
    void client.dbRows(target, missing, base.value).then((result) => {
      if (id !== fetchGeneration || !result.success || !result.rows) return
      remember(result.rows)
      if (searchQuery.value.trim()) rebuildSearchProjection()
      tick.value += 1
    })
  }

  function applyOpen(opened: DbOpenResult): void {
    childrenOf.clear()
    rowById.clear()
    searchIds.value = []
    searchExpanded.value = false
    projected.value = []
    const root = opened.root ?? []
    remember(root)
    rootRows.value = root
    for (const batch of opened.prefetch ?? []) {
      remember(batch.rows)
      childrenOf.set(batch.parentId, batch.rows)
    }
    rebuildBrowse()
  }

  async function toggle(row: DbTreeRow): Promise<void> {
    if (row.childCount === 0) return
    if (expanded.value.has(row.path)) {
      const next = new Set(expanded.value)
      next.delete(row.path)
      expanded.value = next
      return
    }
    if (!childrenOf.has(row.id)) {
      const result = await client.dbChildren(dbPath.value, row.id, base.value)
      if (!result.success || !result.rows) return
      remember(result.rows)
      childrenOf.set(row.id, result.rows)
    }
    const next = new Set(expanded.value)
    next.add(row.path)
    expanded.value = next
  }

  function reset(): void {
    generation += 1
    fetchGeneration += 1
    childrenOf.clear()
    rowById.clear()
    rootRows.value = []
    browseRows.value = []
    projected.value = []
    searchIds.value = []
    searchExpanded.value = false
    searchBusy.value = false
  }

  function cancel(): void {
    generation += 1
    fetchGeneration += 1
    searchBusy.value = false
  }

  watch([searchQuery, enabled], async () => {
    const id = ++generation
    if (!enabled.value) return
    const query = searchQuery.value.trim()
    if (!query) {
      searchIds.value = []
      searchExpanded.value = false
      projected.value = []
      searchBusy.value = false
      rebuildBrowse()
      return
    }
    searchBusy.value = true
    searchIds.value = []
    searchExpanded.value = false
    projected.value = []
    const result = await client.dbSearch(dbPath.value, query, base.value)
    if (id !== generation) return
    searchIds.value = result.success && result.ids ? result.ids : []
    rebuildSearchProjection()
    searchBusy.value = false
    tick.value += 1
  })

  watch(expanded, () => {
    if (!enabled.value || searchBusy.value) return
    if (searchQuery.value.trim()) rebuildSearchProjection()
    else rebuildBrowse()
  })

  return { searchBusy, listCount, rowsForWindow, ensureWindow, applyOpen, toggle, reset, cancel, revision: tick }
}
