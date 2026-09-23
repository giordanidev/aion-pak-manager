import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
import path from 'path'
import type { PakEntry } from '../../shared/api-types'
import { resolveProjectRoot } from '../bin/platform'

export const ROOT_DIR = resolveProjectRoot()
export const PAKS_DIR = path.join(ROOT_DIR, 'PAKS')
export const PAK_DIR = path.join(PAKS_DIR, 'pak')
export const UNPAKED_DIR = path.join(PAKS_DIR, 'unpaked')
export const REPAKED_DIR = path.join(PAKS_DIR, 'repaked')

function isDirEmpty(dir: string): boolean {
	try {
		return readdirSync(dir).length === 0
	} catch {
		return true
	}
}

function migrateDirOnce(oldDir: string, newDir: string): void {
	try {
		if (!existsSync(oldDir) || !statSync(oldDir).isDirectory()) return
		if (existsSync(newDir) && statSync(newDir).isDirectory() && !isDirEmpty(newDir)) return
		if (!existsSync(newDir)) {
			mkdirSync(newDir, { recursive: true })
		}
		for (const name of readdirSync(oldDir)) {
			const src = path.join(oldDir, name)
			const dest = path.join(newDir, name)
			if (existsSync(dest)) continue
			try {
				renameSync(src, dest)
			} catch {
				// ignore individual migration failures
			}
		}
	} catch {
		// ignore migration errors
	}
}

export function ensureDataDirs(): void {
	for (const dir of [PAKS_DIR, PAK_DIR, UNPAKED_DIR, REPAKED_DIR]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true })
		}
	}
	// One-shot migration from legacy root folders (only if destination is absent/empty).
	const root = ROOT_DIR
	migrateDirOnce(path.join(root, 'files'), PAK_DIR)
	migrateDirOnce(path.join(root, 'unpaked'), UNPAKED_DIR)
	migrateDirOnce(path.join(root, 'repaked'), REPAKED_DIR)
	migrateAggregateDbsIntoFolders()
}

/**
 * One-shot migration: move legacy sibling aggregate DBs
 * (`PAKS/unpaked/<name>.db`) inside their extracted folder
 * (`PAKS/unpaked/<name>/<name>.db`).
 */
function migrateAggregateDbsIntoFolders(): void {
	let entries: import('fs').Dirent[]
	try {
		entries = readdirSync(UNPAKED_DIR, { withFileTypes: true })
	} catch {
		return
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const legacyDb = path.join(UNPAKED_DIR, `${entry.name}.db`)
		const insideDb = path.join(UNPAKED_DIR, entry.name, `${entry.name}.db`)
		if (!existsSync(legacyDb) || existsSync(insideDb)) continue
		try {
			renameSync(legacyDb, insideDb)
		} catch {
			// ignore individual migration failures
		}
	}
}

export function ensureUnpakedDir(): void {
	if (!existsSync(UNPAKED_DIR)) {
		mkdirSync(UNPAKED_DIR, { recursive: true })
	}
}

export function findPakFiles(folderPath: string): PakEntry[] {
	if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
		return []
	}

	const pakPaths: PakEntry[] = []
	for (const name of readdirSync(folderPath)) {
		const fullPath = path.join(folderPath, name)
		let stat: ReturnType<typeof statSync>
		try {
			stat = statSync(fullPath)
		} catch {
			continue
		}
		if (stat.isFile() && path.extname(name).toLowerCase() === '.pak') {
			pakPaths.push({
				label: path.relative(ROOT_DIR, fullPath).split(path.sep).join('/'),
				fullPath,
			})
		}
	}

	pakPaths.sort((a, b) => a.label.localeCompare(b.label))
	return pakPaths
}

/** Subdiretórios de 1º nível em `dir` (padrão PAK_DIR; ignora ficheiros). */
export function findRootFoldersInFiles(dir: string = PAK_DIR): PakEntry[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		return []
	}
	const results: PakEntry[] = []
	for (const name of readdirSync(dir)) {
		const fullPath = path.join(dir, name)
		let stat: ReturnType<typeof statSync>
		try {
			stat = statSync(fullPath)
		} catch {
			continue
		}
		if (!stat.isDirectory()) continue
		results.push({
			label: path.relative(ROOT_DIR, fullPath).split(path.sep).join('/'),
			fullPath,
		})
	}
	results.sort((a, b) => a.label.localeCompare(b.label))
	return results
}

/**
 * List first-level entries under /PAKS/repaked (used by the RePAKEDS tab):
 * `*.pak` files and first-level directories (reconstructed folders).
 * No recursion into subfolders. Directories are listed first.
 */
export function findRepakedPaks(dir: string = REPAKED_DIR): PakEntry[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		return []
	}
	const dirs: PakEntry[] = []
	const files: PakEntry[] = []
	let entries: import('fs').Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
	for (const entry of entries) {
		if (entry.name === '._tmp_repack' || entry.name.startsWith('._tmp_repack_')) continue
		const fullPath = path.join(dir, entry.name)
		const label = path.relative(ROOT_DIR, fullPath).split(path.sep).join('/')
		if (entry.isDirectory()) {
			dirs.push({ label, fullPath })
		} else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.pak') {
			files.push({ label, fullPath })
		}
	}
	dirs.sort((a, b) => a.label.localeCompare(b.label))
	files.sort((a, b) => a.label.localeCompare(b.label))
	return [...dirs, ...files]
}

/** Relative pak path mirrored under /PAKS/unpaked (posix separators), e.g. `data/data1/file1.pak`. */
export function pakRelPathFromFiles(pakAbs: string, pakRoot: string = PAK_DIR): string {
	const resolved = path.resolve(pakAbs)
	const rel = path.isAbsolute(pakAbs) ? path.relative(path.resolve(pakRoot), resolved) : pakAbs
	// Pak from a custom source folder (outside /PAKS/pak): collapse to its
	// basename so extract output stays under /PAKS/unpaked instead of escaping it.
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		return path.basename(resolved)
	}
	return rel.split(path.sep).join('/')
}

/** `PAKS/pak/.../name.pak` -> `<unpakedRoot>/.../name.pak` (folder keeps `.pak` name; folder-extract mode). */
export function unpakedFolderForPak(
	pakAbs: string,
	unpakedRoot: string = UNPAKED_DIR,
	pakRoot: string = PAK_DIR,
): string {
	const rel = pakRelPathFromFiles(pakAbs, pakRoot)
	return path.join(unpakedRoot, ...rel.split('/'))
}

/**
 * Individual UnPAK output: `PAKS/pak/.../name.pak` -> `<unpakedRoot>/.../name`
 * (no `.pak` suffix on the last segment; intermediate folders mirrored).
 */
export function unpakedSingleFolderForPak(
	pakAbs: string,
	unpakedRoot: string = UNPAKED_DIR,
	pakRoot: string = PAK_DIR,
): string {
	const rel = pakRelPathFromFiles(pakAbs, pakRoot)
	const parts = rel.split('/')
	const last = parts[parts.length - 1] ?? ''
	const base = last.toLowerCase().endsWith('.pak') ? last.slice(0, -4) : last
	const normalized = [...parts.slice(0, -1), base].filter((p) => p.length > 0)
	return path.join(unpakedRoot, ...normalized)
}

/**
 * Aggregate DB for a full-folder extract, stored **inside** the extracted
 * folder: `<unpakedRoot>/<folder-name>/<folder-name>.db`.
 */
export function unpakedRootDbForFolder(folderAbs: string, unpakedRoot: string = UNPAKED_DIR): string {
	const base = path.basename(path.resolve(folderAbs))
	return path.join(unpakedRoot, base, `${base}.db`)
}

/**
 * Legacy aggregate DB location, next to (outside) the extracted folder:
 * `<unpakedRoot>/<folder-name>.db`. Read-only fallback for extracts written by
 * older versions.
 */
export function unpakedLegacyRootDbForFolder(folderAbs: string, unpakedRoot: string = UNPAKED_DIR): string {
	return path.join(unpakedRoot, `${path.basename(path.resolve(folderAbs))}.db`)
}

/** Sibling DB of the extract folder: `.../name.pak` -> `.../name.pak.db` (legacy per-pak extracts). */
export function unpakedDbForPak(pakAbs: string): string {
	return `${unpakedFolderForPak(pakAbs)}.db`
}

/** Given an extract folder `.../name.pak`, return sibling DB `.../name.pak.db`. */
export function dbPathBesidePakFolder(folderAbs: string): string {
	return `${path.resolve(folderAbs)}.db`
}

/**
 * List folders under /PAKS/unpaked useful for Decrypt/RePAK:
 * only first-level directories directly under /PAKS/unpaked
 * (both `*.pak` extract folders and plain folders), no recursive walk.
 */
export function findUnpakedFolders(dir: string = UNPAKED_DIR): PakEntry[] {
	if (dir === UNPAKED_DIR) ensureUnpakedDir()
	const results: PakEntry[] = []
	let entries: import('fs').Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return results
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const fullPath = path.join(dir, entry.name)
		const label = path.relative(ROOT_DIR, fullPath).split(path.sep).join('/')
		// Aggregate DB inside the extracted folder (`<folder>/<folder>.db`), with a
		// fallback to the legacy sibling (`<folder>.db`) or per-pak DB (`name.pak.db`).
		const insideDb = path.join(fullPath, `${entry.name}.db`)
		const siblingDb = path.join(dir, `${entry.name}.db`)
		const dbPath = existsSync(insideDb) ? insideDb : existsSync(siblingDb) ? siblingDb : undefined
		results.push({ label, fullPath, ...(dbPath ? { dbPath } : {}) })
	}

	results.sort((a, b) => a.label.localeCompare(b.label))
	return results
}
