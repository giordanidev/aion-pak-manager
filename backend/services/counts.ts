import { existsSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { Piscina } from 'piscina'
import type { EntryCountCacheEntry } from '../../shared/api-types'
import { loadSettings, saveSettings } from './settings'
import { resolveCountWorkerFile } from './decrypt-pool'
import { mapPool } from './parallel'
import { cpuThreadsForWork, workerResourceLimits } from './threads'
import type { CountTaskInput, CountTaskResult } from '../workers/count-task'
import { countFilesInPak } from '../core/unpak'
import type { PakEntry } from '../../shared/api-types'

export type CountKind = 'pak' | 'pakFolder' | 'folder' | 'repaked'

let countPool: Piscina<CountTaskInput, CountTaskResult> | null = null

function getCountPool(): Piscina<CountTaskInput, CountTaskResult> {
	if (!countPool) {
		countPool = new Piscina({
			filename: resolveCountWorkerFile(),
			maxThreads: cpuThreadsForWork(),
			resourceLimits: workerResourceLimits(),
		})
	}
	return countPool
}

function readMtimeMs(target: string): number {
	try {
		return statSync(target).mtimeMs
	} catch {
		return 0
	}
}

function cacheKey(target: string): string {
	return path.resolve(target)
}

function readCacheEntry(target: string): EntryCountCacheEntry | null {
	const cache = loadSettings().entryCountCache
	if (!cache) return null
	const hit = cache[cacheKey(target)]
	if (!hit || typeof hit.count !== 'number' || typeof hit.mtimeMs !== 'number') return null
	const mtimeMs = readMtimeMs(target)
	if (mtimeMs <= 0 || hit.mtimeMs !== mtimeMs) return null
	return hit
}

function writeCacheEntry(target: string, measure: CountTaskResult): void {
	const mtimeMs = readMtimeMs(target)
	if (mtimeMs <= 0) return
	const key = cacheKey(target)
	const current = loadSettings()
	if (!current.entryCountCache) current.entryCountCache = {}
	current.entryCountCache[key] = {
		count: measure.count,
		size: measure.size,
		mtimeMs,
	}
	saveSettings({ entryCountCache: current.entryCountCache })
}

export function clearEntryCountCache(): void {
	saveSettings({ entryCountCache: {} })
}

/** Drop the cache entry for a deleted path (and any nested keys under it). */
export function removeEntryCountCacheEntry(target: string): void {
	const current = loadSettings()
	const cache = current.entryCountCache
	if (!cache) return
	const resolved = cacheKey(target)
	const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep
	let changed = false
	const next: Record<string, EntryCountCacheEntry> = {}
	for (const [key, value] of Object.entries(cache)) {
		if (key === resolved || key.startsWith(prefix)) {
			changed = true
			continue
		}
		next[key] = value
	}
	if (changed) saveSettings({ entryCountCache: next })
}

async function runCountTask(target: string, mode: 'folder' | 'pak'): Promise<CountTaskResult> {
	try {
		return await getCountPool().run({ path: target, mode })
	} catch {
		// Worker unavailable (dev without bundled worker): fall back in-process.
		if (mode === 'pak') {
			try {
				const size = statSync(target).size
				const count = await countFilesInPak(target)
				return { count, size }
			} catch {
				return { count: 0, size: 0 }
			}
		}
		return measureFolderInProcess(target)
	}
}

function measureFolderInProcess(root: string): CountTaskResult {
	let count = 0
	let size = 0
	function walk(dir: string): void {
		let names: string[]
		try {
			names = readdirSync(dir)
		} catch {
			return
		}
		for (const name of names) {
			if (name === '.pak-metadata.json' || name === '._tmp_repack') continue
			if (name.startsWith('._tmp_repack_')) continue
			if (name.toLowerCase().endsWith('.db')) continue
			const full = path.join(dir, name)
			let stat: ReturnType<typeof statSync>
			try {
				stat = statSync(full)
			} catch {
				continue
			}
			if (stat.isDirectory()) walk(full)
			else if (stat.isFile()) {
				count += 1
				size += stat.size
			}
		}
	}
	walk(root)
	return { count, size }
}

/**
 * Count one folder by fanning first-level subdirectories across worker threads.
 * A single huge client tree (1M+ files) then uses several cores at once.
 */
async function measureFolderParallel(root: string): Promise<CountTaskResult> {
	let names: string[]
	try {
		names = readdirSync(root)
	} catch {
		return { count: 0, size: 0 }
	}

	let count = 0
	let size = 0
	const subdirs: string[] = []
	for (const name of names) {
		if (name === '.pak-metadata.json' || name === '._tmp_repack') continue
		if (name.startsWith('._tmp_repack_')) continue
		if (name.toLowerCase().endsWith('.db')) continue
		const full = path.join(root, name)
		let stat: ReturnType<typeof statSync>
		try {
			stat = statSync(full)
		} catch {
			continue
		}
		if (stat.isDirectory()) subdirs.push(full)
		else if (stat.isFile()) {
			count += 1
			size += stat.size
		}
	}

	if (subdirs.length === 0) return { count, size }

	const threads = Math.max(1, Math.min(cpuThreadsForWork(), subdirs.length))
	const nested = await mapPool(subdirs, threads, (dir) => runCountTask(dir, 'folder'))
	for (const part of nested) {
		count += part.count
		size += part.size
	}
	return { count, size }
}

async function measureOne(entryPath: string, kind: CountKind, force: boolean): Promise<CountTaskResult> {
	if (!force) {
		const cached = readCacheEntry(entryPath)
		if (cached) return { count: cached.count, size: cached.size }
	}

	let measure: CountTaskResult
	if (kind === 'folder' || kind === 'pakFolder') {
		measure = await measureFolderParallel(entryPath)
	} else if (kind === 'repaked') {
		const stat = await import('fs/promises').then((fsp) => fsp.stat(entryPath).catch(() => null))
		if (stat?.isDirectory()) measure = await measureFolderParallel(entryPath)
		else measure = await runCountTask(entryPath, 'pak')
	} else {
		measure = await runCountTask(entryPath, 'pak')
	}

	writeCacheEntry(entryPath, measure)
	return measure
}

export async function countEntries(
	paths: string[],
	kind: CountKind,
	opts: { force?: boolean } = {},
): Promise<Record<string, number>> {
	return (await countEntriesDetailed(paths, kind, opts)).counts
}

/** Same traversal as `countEntries` but also returns total size (bytes) per path. */
export async function countEntriesDetailed(
	paths: string[],
	kind: CountKind,
	opts: { force?: boolean } = {},
): Promise<{ counts: Record<string, number>; sizes: Record<string, number> }> {
	const force = opts.force === true
	// Each path is independent — mapPool so a huge folder never blocks siblings.
	const entries = await mapPool(paths, cpuThreadsForWork(), async (entryPath) => {
		try {
			const measure = await measureOne(entryPath, kind, force)
			return [entryPath, measure] as const
		} catch {
			return [entryPath, { count: 0, size: 0 }] as const
		}
	})
	return {
		counts: Object.fromEntries(entries.map(([entryPath, measure]) => [entryPath, measure.count])),
		sizes: Object.fromEntries(entries.map(([entryPath, measure]) => [entryPath, measure.size])),
	}
}

export async function countRepakedFiles(root: string): Promise<number> {
	let entries: import('fs').Dirent[]
	try {
		entries = await import('fs/promises').then((fsp) => fsp.readdir(root, { withFileTypes: true }))
	} catch {
		return 0
	}
	let count = 0
	for (const entry of entries) {
		if (entry.name === '._tmp_repack' || entry.name.startsWith('._tmp_repack_')) continue
		if (entry.isDirectory()) count += 1
		else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pak')) count += 1
	}
	return count
}

/**
 * Lists aggregate DBs: one root DB **inside** each extracted folder
 * (e.g. `Aion Brasil/Aion Brasil.db`). First-level sibling DBs
 * (`Aion Brasil.db`) are still listed as a legacy fallback.
 */
export async function listPakDatabases(unpakedDir: string, rootDir: string): Promise<PakEntry[]> {
	const results: PakEntry[] = []
	let entries: import('fs').Dirent[]
	try {
		entries = await import('fs/promises').then((fsp) => fsp.readdir(unpakedDir, { withFileTypes: true }))
	} catch {
		return results
	}
	const seen = new Set<string>()
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const db = path.join(unpakedDir, entry.name, `${entry.name}.db`)
			if (!existsSync(db)) continue
			results.push({
				label: path.relative(unpakedDir, db).split(path.sep).join('/'),
				fullPath: db,
			})
			seen.add(path.resolve(db))
			continue
		}
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.db')) continue
		const full = path.join(unpakedDir, entry.name)
		if (seen.has(path.resolve(full))) continue
		results.push({
			label: path.relative(unpakedDir, full).split(path.sep).join('/'),
			fullPath: full,
		})
	}
	void rootDir
	results.sort((a, b) => a.label.localeCompare(b.label))
	return results
}

/** Legacy helpers kept for callers that still fill counts onto scan lists. */
export async function fillPakFileCounts(entries: PakEntry[]): Promise<PakEntry[]> {
	const detailed = await countEntriesDetailed(
		entries.map((e) => e.fullPath),
		'pak',
	)
	return entries.map((entry) => ({
		...entry,
		fileCount: detailed.counts[entry.fullPath],
	}))
}

export async function fillFolderFileCounts(entries: PakEntry[]): Promise<PakEntry[]> {
	const detailed = await countEntriesDetailed(
		entries.map((e) => e.fullPath),
		'folder',
	)
	return entries.map((entry) => ({
		...entry,
		fileCount: detailed.counts[entry.fullPath],
	}))
}
