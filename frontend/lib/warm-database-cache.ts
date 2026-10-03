import { markRaw } from 'vue'
import type { PakDatabaseInfo, SourceStampResult } from '../../shared/api-types'
import { buildFileTreeIndex } from './file-tree-index'
import { buildDatabaseTree, isDbSearchDir, slimDatabaseInfo, type DbTreeNode } from './pak-database-tree'
import { readStructureCache, structureCacheKey, structureStamp, writeStructureCache, type CachedStructure } from './structure-cache'

export type DatabaseCache = CachedStructure<DbTreeNode, PakDatabaseInfo>

interface StampApi {
  sourceStamp(targetPath: string, kind: 'pak' | 'database', base?: string): Promise<SourceStampResult>
  readPakDatabase(dbPath: string, base?: string): Promise<{ success: boolean; info?: PakDatabaseInfo; error?: string }>
}

const inflight = new Map<string, Promise<DatabaseCache | null>>()

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function loadDatabaseCache(dbPath: string, base: string | undefined, electron: StampApi): Promise<DatabaseCache | null> {
  const key = structureCacheKey('db', dbPath)
  let stamp = ''
  try {
    const stampResult = await electron.sourceStamp(dbPath, 'database', base)
    if (stampResult.success && typeof stampResult.mtimeMs === 'number') {
      stamp = structureStamp(stampResult.mtimeMs, stampResult.size ?? 0)
    }
  } catch {
    stamp = ''
  }
  const usableStamp = stamp || 'session'
  const hit = readStructureCache<DbTreeNode, PakDatabaseInfo>(key, usableStamp)
  if (hit) return hit
  const result = await electron.readPakDatabase(dbPath, base)
  if (!result.success || !result.info) throw new Error(result.error || 'empty database')
  const root = markRaw(await buildDatabaseTree(result.info))
  const indexed = await buildFileTreeIndex(root, {
    isDir: isDbSearchDir,
    onYield: yieldToUi,
  })
  if (!indexed) return null
  const slim = slimDatabaseInfo(result.info)
  writeStructureCache(key, usableStamp, root, indexed, slim)
  return { root, index: indexed, meta: slim }
}

/** Builds the structure index once per database and shares the in-flight job. */
export function warmDatabaseCache(dbPath: string, base: string | undefined, electron: StampApi): Promise<DatabaseCache | null> {
  const key = structureCacheKey('db', dbPath)
  const pending = inflight.get(key)
  if (pending) return pending
  const job = loadDatabaseCache(dbPath, base, electron).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, job)
  return job
}
