import { existsSync, readdirSync, statSync } from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import type { PakEntry } from '../../shared/api-types'
import { countFilesInPak } from '../core/unpak'
import { mapPool } from './parallel'
import { cpuThreadsForWork } from './threads'

interface FileMeasure {
	count: number;
	size: number;
}

function measureRegularFilesRecursive(root: string): FileMeasure {
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

function countRegularFilesRecursive(root: string): number {
	return measureRegularFilesRecursive(root).count
}

export async function fillPakFileCounts(entries: PakEntry[]): Promise<PakEntry[]> {
	const concurrency = cpuThreadsForWork()
	return mapPool(
		entries,
		concurrency,
		async (entry) => {
			try {
				const n = await countFilesInPak(entry.fullPath)
				return { ...entry, fileCount: n }
			} catch {
				return { ...entry }
			}
		},
	)
}

export async function fillFolderFileCounts(entries: PakEntry[]): Promise<PakEntry[]> {
	const concurrency = cpuThreadsForWork()
	return mapPool(
		entries,
		concurrency,
		async (entry) => {
			try {
				if (!existsSync(entry.fullPath) || !statSync(entry.fullPath).isDirectory()) {
					return { ...entry }
				}
				const n = countRegularFilesRecursive(entry.fullPath)
				return { ...entry, fileCount: n }
			} catch {
				return { ...entry }
			}
		},
	)
}

async function measureRegularFiles(root: string): Promise<FileMeasure> {
	let count = 0
	let size = 0
	let entries: import('fs').Dirent[]
	try {
		entries = await fsp.readdir(root, { withFileTypes: true })
	} catch {
		return { count, size }
	}
	for (const entry of entries) {
		if (entry.name === '.pak-metadata.json' || entry.name === '._tmp_repack') continue
		if (entry.name.toLowerCase().endsWith('.db')) continue
		const fullPath = path.join(root, entry.name)
		if (entry.isDirectory()) {
			const nested = await measureRegularFiles(fullPath)
			count += nested.count
			size += nested.size
		} else if (entry.isFile()) {
			count += 1
			const stat = await fsp.stat(fullPath).catch(() => null)
			if (stat) size += stat.size
		}
	}
	return { count, size }
}

export async function countEntries(
	paths: string[],
	kind: 'pak' | 'pakFolder' | 'folder' | 'repaked',
): Promise<Record<string, number>> {
	return (await countEntriesDetailed(paths, kind)).counts
}

/** Same traversal as `countEntries` but also returns total size (bytes) per path. */
export async function countEntriesDetailed(
	paths: string[],
	kind: 'pak' | 'pakFolder' | 'folder' | 'repaked',
): Promise<{ counts: Record<string, number>; sizes: Record<string, number> }> {
	const entries = await mapPool(paths, cpuThreadsForWork(), async (entryPath) => {
		try {
			if (kind === 'folder' || kind === 'pakFolder') {
				return [entryPath, await measureRegularFiles(entryPath)] as const
			}
			// Repaked first level can be a reconstructed folder or a .pak file.
			const stat = await fsp.stat(entryPath).catch(() => null)
			if (stat?.isDirectory()) {
				return [entryPath, await measureRegularFiles(entryPath)] as const
			}
			const count = await countFilesInPak(entryPath)
			return [entryPath, { count, size: stat?.size ?? 0 }] as const
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
	// First level only: reconstructed folders + .pak files (no recursion).
	let entries: import('fs').Dirent[]
	try {
		entries = await fsp.readdir(root, { withFileTypes: true })
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
		entries = await fsp.readdir(unpakedDir, { withFileTypes: true })
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
