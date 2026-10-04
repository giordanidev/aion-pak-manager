import { markRaw } from 'vue'
import type { DbOpenResult, DbTreeRow, PakDatabaseInfo } from '../../shared/api-types'
import { buildFileTreeIndex, type FileTreeIndex } from './file-tree-index'
import { buildDatabaseTree, isDbSearchDir, slimDatabaseInfo, type DbTreeNode } from './pak-database-tree'
import { readStructureCache, structureCacheKey, structureStamp, writeStructureCache } from './structure-cache'

export type SqliteWarm = {
  kind: 'sqlite'
  info: PakDatabaseInfo
  rootRows: DbTreeRow[]
  prefetch: { parentId: number; rows: DbTreeRow[] }[]
}

export type LegacyWarm = {
  kind: 'legacy'
  root: DbTreeNode
  index: FileTreeIndex<DbTreeNode>
  info: PakDatabaseInfo
}

export type DatabaseCache = SqliteWarm | LegacyWarm

interface WarmApi {
  sourceStamp(targetPath: string, kind: 'pak' | 'database', base?: string): Promise<{ success: boolean; mtimeMs?: number; size?: number }>
  dbOpen(dbPath: string, base?: string): Promise<DbOpenResult>
  readPakDatabase(dbPath: string, base?: string): Promise<{ success: boolean; info?: PakDatabaseInfo; error?: string }>
}

const inflight = new Map<string, Promise<DatabaseCache | null>>()

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function stampOf(electron: WarmApi, dbPath: string, base: string | undefined): Promise<string> {
  try {
    const stampResult = await electron.sourceStamp(dbPath, 'database', base)
    if (stampResult.success && typeof stampResult.mtimeMs === 'number') {
      return structureStamp(stampResult.mtimeMs, stampResult.size ?? 0)
    }
  } catch {
    return ''
  }
  return ''
}

async function loadLegacy(dbPath: string, base: string | undefined, electron: WarmApi): Promise<LegacyWarm | null> {
  const result = await electron.readPakDatabase(dbPath, base)
  if (!result.success || !result.info) throw new Error(result.error || 'empty database')
  const root = markRaw(await buildDatabaseTree(result.info))
  const indexed = await buildFileTreeIndex(root, {
    isDir: isDbSearchDir,
    onYield: yieldToUi,
  })
  if (!indexed) return null
  return { kind: 'legacy', root, index: indexed, info: slimDatabaseInfo(result.info) }
}

async function loadDatabaseCache(dbPath: string, base: string | undefined, electron: WarmApi): Promise<DatabaseCache | null> {
  const key = structureCacheKey('db', dbPath)
  let stamp = await stampOf(electron, dbPath, base)
  const usable = stamp || 'session'
  const hit = readStructureCache<DatabaseCache, PakDatabaseInfo>(key, usable)
  if (hit) return hit.root
  const opened = await electron.dbOpen(dbPath, base)
  if (opened.success && opened.info && opened.root) {
    stamp = await stampOf(electron, dbPath, base)
    const slot: SqliteWarm = {
      kind: 'sqlite',
      info: opened.info,
      rootRows: opened.root,
      prefetch: opened.prefetch ?? [],
    }
    writeStructureCache(key, stamp || 'session', slot, null, opened.info)
    return slot
  }
  if (!opened.fallback) throw new Error(opened.error || 'empty database')
  const legacy = await loadLegacy(dbPath, base, electron)
  if (!legacy) return null
  writeStructureCache(key, usable, legacy, null, legacy.info)
  return legacy
}

/** Opens the database once per path and shares the in-flight job. Converts JSON to SQLite on first open. */
export function warmDatabaseCache(dbPath: string, base: string | undefined, electron: WarmApi): Promise<DatabaseCache | null> {
  const key = structureCacheKey('db', dbPath)
  const pending = inflight.get(key)
  if (pending) return pending
  const job = loadDatabaseCache(dbPath, base, electron).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, job)
  return job
}
