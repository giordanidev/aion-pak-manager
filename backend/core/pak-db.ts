/**
 * Aggregate extract database. Legacy files are JSON (versions 3 and 4).
 * New files are SQLite with the folder tree and an FTS5 trigram index on
 * each path segment, written in the same pass as the rows.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { DbOpenResult, DbPrefetch, DbTreeRow, PakDatabaseInfo, PakDatabasePakEntry } from '../../shared/api-types'

export interface PakDbFileEntry {
	relPakPath: string
	sourcePak?: string
	outputFolder?: string
	destDir?: string
	files: string[]
	fileCount?: number
}

export interface PakDbManifest {
	version?: number
	folderName?: string
	inputFolder?: string
	createdAt?: string
	relPakPath?: string
	sourcePak?: string
	outputFolder?: string
	destDir?: string
	files: string[]
	paks: PakDbFileEntry[]
	/** Non-pak files mirrored during extract, relative to the unpaked root. */
	movedFiles?: string[]
}

const SQLITE_MAGIC = 'SQLite format 3'
const AUTO_EXPAND_LIMIT = 8000

interface BuildNode {
	name: string
	nameFold: string
	path: string
	kind: 'dir' | 'file'
	children: Map<string, BuildNode>
	pakId: number | null
	relFile: string | null
	fileCount: number
	id: number
	subtreeEnd: number
	sortDir: number
	ord: number
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function splitParts(value: string): string[] {
	return value.replace(/\\/g, '/').split('/').filter((part) => part.length > 0)
}

function isBranch(node: BuildNode): boolean {
	return node.children.size > 0 || node.kind === 'dir'
}

function compareNodes(a: BuildNode, b: BuildNode): number {
	const aDir = isBranch(a)
	const bDir = isBranch(b)
	if (aDir !== bDir) return aDir ? -1 : 1
	if (a.name < b.name) return -1
	if (a.name > b.name) return 1
	return 0
}

export function sniffPakDb(filePath: string): 'sqlite' | 'json' | 'missing' {
	if (!existsSync(filePath)) return 'missing'
	const fd = openSync(filePath, 'r')
	try {
		const buf = Buffer.alloc(16)
		const n = readSync(fd, buf, 0, 16, 0)
		if (n >= SQLITE_MAGIC.length && buf.toString('utf8', 0, SQLITE_MAGIC.length) === SQLITE_MAGIC) return 'sqlite'
		return 'json'
	} finally {
		closeSync(fd)
	}
}

export function manifestFromUnknown(raw: Record<string, unknown>): PakDbManifest {
	const paks: PakDbFileEntry[] = []
	if (Array.isArray(raw['paks'])) {
		for (const entry of raw['paks'] as unknown[]) {
			if (!entry || typeof entry !== 'object') continue
			const value = entry as Record<string, unknown>
			const relPakPath = typeof value['relPakPath'] === 'string' ? value['relPakPath'] : ''
			if (relPakPath === '' || !Array.isArray(value['files'])) continue
			paks.push({
				relPakPath,
				sourcePak: asString(value['sourcePak']),
				outputFolder: asString(value['outputFolder']),
				destDir: asString(value['destDir']),
				files: (value['files'] as unknown[]).filter((file): file is string => typeof file === 'string'),
				fileCount: typeof value['fileCount'] === 'number' ? value['fileCount'] : undefined,
			})
		}
	}
	const files = Array.isArray(raw['files'])
		? (raw['files'] as unknown[]).filter((file): file is string => typeof file === 'string')
		: []
	const movedFiles = Array.isArray(raw['movedFiles'])
		? (raw['movedFiles'] as unknown[]).filter((file): file is string => typeof file === 'string')
		: []
	return {
		version: typeof raw['version'] === 'number' ? raw['version'] : undefined,
		folderName: asString(raw['folderName']),
		inputFolder: asString(raw['inputFolder']),
		createdAt: asString(raw['createdAt']),
		relPakPath: asString(raw['relPakPath']),
		sourcePak: asString(raw['sourcePak']),
		outputFolder: asString(raw['outputFolder']),
		destDir: asString(raw['destDir']),
		files,
		paks,
		movedFiles,
	}
}

function manifestRecord(manifest: PakDbManifest): Record<string, unknown> {
	const record: Record<string, unknown> = {}
	if (manifest.version !== undefined) record['version'] = manifest.version
	if (manifest.folderName !== undefined) record['folderName'] = manifest.folderName
	if (manifest.inputFolder !== undefined) record['inputFolder'] = manifest.inputFolder
	if (manifest.createdAt !== undefined) record['createdAt'] = manifest.createdAt
	if (manifest.relPakPath !== undefined) record['relPakPath'] = manifest.relPakPath
	if (manifest.sourcePak !== undefined) record['sourcePak'] = manifest.sourcePak
	if (manifest.outputFolder !== undefined) record['outputFolder'] = manifest.outputFolder
	if (manifest.destDir !== undefined) record['destDir'] = manifest.destDir
	if (manifest.paks.length > 0) record['paks'] = manifest.paks
	if (manifest.paks.length <= 1) record['files'] = manifest.paks.length === 1 ? manifest.paks[0]!.files : manifest.files
	if (manifest.movedFiles && manifest.movedFiles.length > 0) record['movedFiles'] = manifest.movedFiles
	return record
}

function emptyNode(name: string, nodePath: string, kind: 'dir' | 'file'): BuildNode {
	return {
		name,
		nameFold: name.toLowerCase(),
		path: nodePath,
		kind,
		children: new Map(),
		pakId: null,
		relFile: null,
		fileCount: 0,
		id: 0,
		subtreeEnd: 0,
		sortDir: 0,
		ord: 0,
	}
}

function ensureNode(parent: BuildNode, parts: string[], leafKind: 'dir' | 'file'): BuildNode {
	let node = parent
	let current = parent.path
	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i] as string
		const last = i === parts.length - 1
		current = current ? `${current}/${part}` : part
		let child = node.children.get(part)
		if (!child) {
			child = emptyNode(part, current, last ? leafKind : 'dir')
			node.children.set(part, child)
		} else if (last) {
			child.kind = leafKind
		}
		node = child
	}
	return node
}

function computeFileCounts(node: BuildNode): number {
	if (node.children.size === 0) {
		node.fileCount = node.kind === 'file' ? 1 : 0
		return node.fileCount
	}
	let total = 0
	for (const child of node.children.values()) total += computeFileCounts(child)
	node.fileCount = total
	return total
}

function replaceFile(tmpPath: string, destPath: string): void {
	const backup = `${destPath}.bak`
	rmSync(backup, { force: true })
	if (existsSync(destPath)) renameSync(destPath, backup)
	try {
		renameSync(tmpPath, destPath)
	} catch (error) {
		if (existsSync(backup) && !existsSync(destPath)) renameSync(backup, destPath)
		throw error
	}
	rmSync(backup, { force: true })
}

function writeManifestKeys(db: Database.Database, manifest: PakDbManifest): void {
	const insert = db.prepare('INSERT INTO manifest (key, value) VALUES (?, ?)')
	const entries: [string, string][] = []
	if (manifest.version !== undefined) entries.push(['version', String(manifest.version)])
	if (manifest.folderName !== undefined) entries.push(['folder_name', manifest.folderName])
	if (manifest.inputFolder !== undefined) entries.push(['input_folder', manifest.inputFolder])
	if (manifest.createdAt !== undefined) entries.push(['created_at', manifest.createdAt])
	if (manifest.relPakPath !== undefined) entries.push(['rel_pak_path', manifest.relPakPath])
	if (manifest.sourcePak !== undefined) entries.push(['source_pak', manifest.sourcePak])
	if (manifest.outputFolder !== undefined) entries.push(['output_folder', manifest.outputFolder])
	if (manifest.destDir !== undefined) entries.push(['dest_dir', manifest.destDir])
	for (const entry of entries) insert.run(entry[0], entry[1])
}

function createSchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE paks (
			id INTEGER PRIMARY KEY,
			rel_pak_path TEXT NOT NULL,
			source_pak TEXT,
			dest_dir TEXT,
			output_folder TEXT,
			file_count INTEGER NOT NULL
		);
		CREATE TABLE nodes (
			id INTEGER PRIMARY KEY,
			parent_id INTEGER NOT NULL,
			name TEXT NOT NULL,
			name_fold TEXT NOT NULL,
			path TEXT NOT NULL,
			kind TEXT NOT NULL,
			child_count INTEGER NOT NULL,
			file_count INTEGER NOT NULL,
			subtree_end INTEGER NOT NULL,
			sort_dir INTEGER NOT NULL,
			ord INTEGER NOT NULL,
			pak_id INTEGER,
			rel_file TEXT
		);
		CREATE TABLE moved_files (path TEXT PRIMARY KEY);
		CREATE VIRTUAL TABLE nodes_fts USING fts5(
			name_fold,
			content='nodes',
			content_rowid='id',
			tokenize='trigram'
		);
	`)
}

function sourceEntries(manifest: PakDbManifest): PakDbFileEntry[] {
	if (manifest.paks.length > 0) return manifest.paks
	if (manifest.relPakPath && manifest.files.length > 0) {
		return [{
			relPakPath: manifest.relPakPath,
			sourcePak: manifest.sourcePak,
			outputFolder: manifest.outputFolder,
			destDir: manifest.destDir,
			files: manifest.files,
		}]
	}
	return []
}

function buildTree(entries: PakDbFileEntry[], pakIds: Map<number, number>): BuildNode {
	const root = emptyNode('', '', 'dir')
	entries.forEach((entry, index) => {
		const relParts = splitParts(entry.relPakPath)
		if (relParts.length === 0) return
		const pakNode = ensureNode(root, relParts, 'file')
		const pakId = pakIds.get(index) ?? null
		pakNode.pakId = pakId
		for (const file of entry.files) {
			const fileParts = splitParts(file)
			if (fileParts.length === 0) continue
			const leaf = ensureNode(pakNode, fileParts, 'file')
			leaf.relFile = file.replace(/\\/g, '/')
			leaf.pakId = pakId
		}
	})
	computeFileCounts(root)
	return root
}

function assignIds(node: BuildNode, next: { id: number }): void {
	const kids = [...node.children.values()].sort(compareNodes)
	for (let i = 0; i < kids.length; i += 1) {
		const kid = kids[i] as BuildNode
		kid.ord = i
		kid.sortDir = isBranch(kid) ? 1 : 0
		kid.id = next.id
		next.id += 1
		assignIds(kid, next)
		kid.subtreeEnd = next.id
	}
	node.children = new Map(kids.map((kid) => [kid.name, kid]))
}

export function writePakDatabase(destPath: string, manifest: PakDbManifest): void {
	const tmpPath = `${destPath}.tmp`
	rmSync(tmpPath, { force: true })
	const db = new Database(tmpPath)
	try {
		db.pragma('journal_mode = OFF')
		db.pragma('synchronous = OFF')
		db.pragma('locking_mode = EXCLUSIVE')
		db.pragma('temp_store = MEMORY')
		createSchema(db)
		const insertPak = db.prepare(
			`INSERT INTO paks (rel_pak_path, source_pak, dest_dir, output_folder, file_count)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		const pakIds = new Map<number, number>()
		const entries = sourceEntries(manifest)
		const tx = db.transaction(() => {
			writeManifestKeys(db, manifest)
			entries.forEach((entry, index) => {
				const info = insertPak.run(
					entry.relPakPath,
					entry.sourcePak ?? null,
					entry.destDir === undefined ? null : entry.destDir,
					entry.outputFolder ?? null,
					entry.files.length,
				)
				pakIds.set(index, Number(info.lastInsertRowid))
			})
			const root = buildTree(entries, pakIds)
			assignIds(root, { id: 1 })
			const insertNode = db.prepare(
				`INSERT INTO nodes (
					id, parent_id, name, name_fold, path, kind, child_count, file_count,
					subtree_end, sort_dir, ord, pak_id, rel_file
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			const walk = (node: BuildNode, parentId: number): void => {
				for (const kid of node.children.values()) {
					insertNode.run(
						kid.id,
						parentId,
						kid.name,
						kid.nameFold,
						kid.path,
						kid.kind,
						kid.children.size,
						kid.fileCount,
						kid.subtreeEnd,
						kid.sortDir,
						kid.ord,
						kid.pakId,
						kid.relFile,
					)
					walk(kid, kid.id)
				}
			}
			walk(root, 0)
			const moved = normalizeMovedFiles(manifest.movedFiles)
			if (moved.length > 0) {
				const insertMoved = db.prepare('INSERT INTO moved_files (path) VALUES (?)')
				for (const rel of moved) insertMoved.run(rel)
			}
			db.exec('CREATE INDEX nodes_parent_ord ON nodes(parent_id, ord)')
			db.exec('CREATE INDEX nodes_pak_rel ON nodes(pak_id, rel_file) WHERE rel_file IS NOT NULL')
			db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`)
		})
		tx()
	} catch (error) {
		db.close()
		rmSync(tmpPath, { force: true })
		throw error
	}
	db.close()
	replaceFile(tmpPath, destPath)
}

function readMeta(db: Database.Database): Map<string, string> {
	const rows = db.prepare('SELECT key, value FROM manifest').all() as { key: string; value: string }[]
	return new Map(rows.map((row) => [row.key, row.value]))
}

function readPakRows(db: Database.Database): PakDbFileEntry[] {
	const paks = db.prepare(
		`SELECT id, rel_pak_path, source_pak, dest_dir, output_folder, file_count FROM paks ORDER BY id`,
	).all() as {
		id: number
		rel_pak_path: string
		source_pak: string | null
		dest_dir: string | null
		output_folder: string | null
		file_count: number
	}[]
	const files = db.prepare(
		`SELECT pak_id, rel_file FROM nodes WHERE rel_file IS NOT NULL ORDER BY pak_id, rel_file`,
	).all() as { pak_id: number; rel_file: string }[]
	const byPak = new Map<number, string[]>()
	for (const file of files) {
		let list = byPak.get(file.pak_id)
		if (!list) {
			list = []
			byPak.set(file.pak_id, list)
		}
		list.push(file.rel_file)
	}
	return paks.map((pak) => ({
		relPakPath: pak.rel_pak_path,
		sourcePak: pak.source_pak ?? undefined,
		outputFolder: pak.output_folder ?? undefined,
		destDir: pak.dest_dir === null ? undefined : pak.dest_dir,
		files: byPak.get(pak.id) ?? [],
		fileCount: pak.file_count,
	}))
}

function manifestFromSqlite(db: Database.Database): PakDbManifest {
	const meta = readMeta(db)
	const versionRaw = meta.get('version')
	const version = versionRaw !== undefined && versionRaw !== '' && !Number.isNaN(Number(versionRaw))
		? Number(versionRaw)
		: undefined
	return {
		version,
		folderName: meta.get('folder_name'),
		inputFolder: meta.get('input_folder'),
		createdAt: meta.get('created_at'),
		relPakPath: meta.get('rel_pak_path'),
		sourcePak: meta.get('source_pak'),
		outputFolder: meta.get('output_folder'),
		destDir: meta.has('dest_dir') ? meta.get('dest_dir') : undefined,
		files: [],
		paks: readPakRows(db),
		movedFiles: readMovedFiles(db),
	}
}

function cleanRel(raw: string): string {
	const rel = raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
	if (rel === '' || rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return ''
	return rel
}

function normalizeMovedFiles(files: string[] | undefined): string[] {
	if (!files || files.length === 0) return []
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of files) {
		const rel = cleanRel(raw)
		if (rel === '' || seen.has(rel)) continue
		seen.add(rel)
		out.push(rel)
	}
	out.sort()
	return out
}

/** v4 db lives inside the extract folder; the legacy aggregate db sits beside it. */
function extractLayout(dbPath: string): { extractRoot: string; unpakedRoot: string } | null {
	const resolved = path.resolve(dbPath)
	const base = path.basename(resolved)
	if (!base.toLowerCase().endsWith('.db')) return null
	const stem = base.slice(0, -3)
	const parent = path.dirname(resolved)
	if (path.basename(parent) === stem && existsSync(parent)) {
		return { extractRoot: parent, unpakedRoot: path.dirname(parent) }
	}
	const sibling = path.join(parent, stem)
	try {
		if (statSync(sibling).isDirectory()) return { extractRoot: sibling, unpakedRoot: parent }
	} catch {
		// no sibling extract folder
	}
	return null
}

function pakOwnedRelPaths(manifest: PakDbManifest, unpakedRoot: string): Set<string> {
	const owned = new Set<string>()
	const entries: PakDbFileEntry[] = manifest.paks.length > 0
		? manifest.paks
		: manifest.relPakPath
			? [{
				relPakPath: manifest.relPakPath,
				sourcePak: manifest.sourcePak,
				outputFolder: manifest.outputFolder,
				destDir: manifest.destDir,
				files: manifest.files,
			}]
			: []
	for (const entry of entries) {
		let base = ''
		if (typeof entry.destDir === 'string') {
			base = cleanRel(entry.destDir)
		} else if (entry.outputFolder) {
			const rel = path.relative(unpakedRoot, path.resolve(entry.outputFolder))
			if (rel.startsWith('..') || path.isAbsolute(rel)) continue
			base = cleanRel(rel.split(path.sep).join('/'))
		}
		for (const file of entry.files) {
			const relFile = cleanRel(file)
			if (relFile === '') continue
			owned.add(base ? `${base}/${relFile}` : relFile)
		}
	}
	return owned
}

/**
 * Files in the extract folder that did not come from a pak TOC.
 * `.pak` archives are skipped; everything else not listed in the manifest
 * is a copied/moved file and belongs in `movedFiles`.
 */
function findCopiedFiles(dbPath: string, manifest: PakDbManifest): string[] {
	const layout = extractLayout(dbPath)
	if (!layout) return []
	const owned = pakOwnedRelPaths(manifest, layout.unpakedRoot)
	const dbResolved = path.resolve(dbPath)
	const found: string[] = []
	const walk = (dir: string): void => {
		let names: string[]
		try {
			names = readdirSync(dir)
		} catch {
			return
		}
		for (const name of names) {
			const full = path.join(dir, name)
			let st: ReturnType<typeof statSync>
			try {
				st = statSync(full)
			} catch {
				continue
			}
			if (st.isDirectory()) {
				walk(full)
				continue
			}
			if (!st.isFile()) continue
			const resolved = path.resolve(full)
			if (resolved === dbResolved || resolved === `${dbResolved}.bak` || resolved === `${dbResolved}.tmp`) continue
			if (path.extname(name).toLowerCase() === '.pak') continue
			const rel = path.relative(layout.unpakedRoot, resolved)
			if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue
			const posix = cleanRel(rel.split(path.sep).join('/'))
			if (posix === '' || owned.has(posix)) continue
			found.push(posix)
		}
	}
	walk(layout.extractRoot)
	return found
}

function readMovedFiles(db: Database.Database): string[] {
	const table = db.prepare(
		`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'moved_files'`,
	).get() as { ok: number } | undefined
	if (!table) return []
	const rows = db.prepare(`SELECT path FROM moved_files ORDER BY path`).all() as { path: string }[]
	return rows.map((row) => row.path)
}

export function readStoredRelPakPath(filePath: string): string | null {
	const kind = sniffPakDb(filePath)
	if (kind === 'missing') return null
	if (kind === 'sqlite') {
		const db = new Database(filePath, { readonly: true, fileMustExist: true })
		try {
			const fromManifest = db.prepare(`SELECT value FROM manifest WHERE key = 'rel_pak_path'`).get() as { value: string } | undefined
			if (fromManifest && fromManifest.value.length > 0) return fromManifest.value.split(path.sep).join('/')
			const fromPak = db.prepare(`SELECT rel_pak_path FROM paks ORDER BY id LIMIT 1`).get() as { rel_pak_path: string } | undefined
			if (fromPak && fromPak.rel_pak_path.length > 0) return fromPak.rel_pak_path.split(path.sep).join('/')
			return null
		} finally {
			db.close()
		}
	}
	try {
		const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
		if (typeof raw['relPakPath'] === 'string' && raw['relPakPath'].length > 0) {
			return raw['relPakPath'].split(path.sep).join('/')
		}
		return null
	} catch {
		return null
	}
}

export function readPakManifest(filePath: string): Record<string, unknown> | null {
	const kind = sniffPakDb(filePath)
	if (kind === 'missing') return null
	if (kind === 'json') {
		try {
			const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
			if (!raw || typeof raw !== 'object') return null
			return raw as Record<string, unknown>
		} catch {
			return null
		}
	}
	const db = new Database(filePath, { readonly: true, fileMustExist: true })
	try {
		return manifestRecord(manifestFromSqlite(db))
	} finally {
		db.close()
	}
}

function slimInfo(manifest: PakDbManifest): PakDatabaseInfo {
	const paks: PakDatabasePakEntry[] = manifest.paks.map((pak) => ({
		relPakPath: pak.relPakPath,
		destDir: pak.destDir,
		files: [],
		fileCount: pak.fileCount ?? pak.files.length,
	}))
	return {
		relPakPath: manifest.folderName ?? manifest.relPakPath,
		folderName: manifest.folderName,
		version: manifest.version,
		files: [],
		paks: paks.length > 0 ? paks : undefined,
		sourcePak: manifest.sourcePak,
		outputFolder: manifest.outputFolder,
		destDir: manifest.destDir,
		createdAt: manifest.createdAt,
	}
}

const ROW_SQL = `SELECT id, parent_id AS parentId, name, path, kind, child_count AS childCount, file_count AS fileCount`

function mapRow(row: {
	id: number
	parentId: number
	name: string
	path: string
	kind: string
	childCount: number
	fileCount: number
}): DbTreeRow {
	return {
		id: row.id,
		parentId: row.parentId,
		name: row.name,
		path: row.path,
		kind: row.kind === 'dir' ? 'dir' : 'file',
		childCount: row.childCount,
		fileCount: row.fileCount,
	}
}

export function readChildRows(db: Database.Database, parentId: number): DbTreeRow[] {
	const rows = db.prepare(`${ROW_SQL} FROM nodes WHERE parent_id = ? ORDER BY ord`).all(parentId) as {
		id: number
		parentId: number
		name: string
		path: string
		kind: string
		childCount: number
		fileCount: number
	}[]
	return rows.map(mapRow)
}

export function readRowsByIds(db: Database.Database, ids: number[]): DbTreeRow[] {
	if (ids.length === 0) return []
	const placeholders = ids.map(() => '?').join(', ')
	const rows = db.prepare(`${ROW_SQL} FROM nodes WHERE id IN (${placeholders})`).all(...ids) as {
		id: number
		parentId: number
		name: string
		path: string
		kind: string
		childCount: number
		fileCount: number
	}[]
	const byId = new Map(rows.map((row) => [row.id, mapRow(row)]))
	const ordered: DbTreeRow[] = []
	for (const id of ids) {
		const row = byId.get(id)
		if (row) ordered.push(row)
	}
	return ordered
}

interface SearchHit {
	id: number
	subtreeEnd: number
	nameFold: string
	path: string
	kind: string
	childCount: number
}

function ftsQuery(query: string): string {
	return `"${query.replace(/"/g, '""')}"`
}

function collectHits(rows: Iterable<SearchHit>, query: string): number[] {
	const ids: number[] = []
	let rich: SearchHit[] | null = []
	let skip = 0
	for (const row of rows) {
		if (row.id < skip) continue
		if (!row.nameFold.includes(query)) continue
		ids.push(row.id)
		if (rich) {
			rich.push(row)
			if (rich.length > 25000) rich = null
		}
		skip = row.subtreeEnd
	}
	if (rich && rich.length > 1) {
		rich.sort((a, b) => {
			const aDir = a.childCount > 0 || a.kind === 'dir'
			const bDir = b.childCount > 0 || b.kind === 'dir'
			if (aDir !== bDir) return aDir ? -1 : 1
			if (a.path < b.path) return -1
			if (a.path > b.path) return 1
			return 0
		})
		return rich.map((row) => row.id)
	}
	return ids
}

export function searchNodeIds(db: Database.Database, rawQuery: string): number[] {
	const query = rawQuery.trim().toLowerCase()
	if (query === '') return []
	const columns = `n.id AS id, n.subtree_end AS subtreeEnd, n.name_fold AS nameFold, n.path AS path, n.kind AS kind, n.child_count AS childCount`
	if (query.length >= 3) {
		try {
			const stmt = db.prepare(
				`SELECT ${columns} FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.rowid WHERE nodes_fts MATCH ? ORDER BY n.id`,
			)
			return collectHits(stmt.iterate(ftsQuery(query)) as Iterable<SearchHit>, query)
		} catch {
			// Trigram MATCH rejects some tokens; the scan below still filters names.
		}
	}
	const stmt = db.prepare(
		`SELECT id, subtree_end AS subtreeEnd, name_fold AS nameFold, path, kind, child_count AS childCount FROM nodes ORDER BY id`,
	)
	return collectHits(stmt.iterate() as Iterable<SearchHit>, query)
}

export function readLeafPaths(db: Database.Database, nodePath: string): string[] {
	const prefix = `${nodePath}/`
	const end = `${nodePath}0`
	const rows = db.prepare(
		`SELECT path FROM nodes
		 WHERE kind = 'file' AND child_count = 0
		   AND (path = ? OR (path >= ? AND path < ?))
		 ORDER BY path`,
	).all(nodePath, prefix, end) as { path: string }[]
	return rows.map((row) => row.path)
}

function openReadonly(filePath: string): Database.Database {
	return new Database(filePath, { readonly: true, fileMustExist: true })
}

export function openPakDatabase(filePath: string): DbOpenResult {
	const kind = sniffPakDb(filePath)
	if (kind === 'missing') return { success: false, error: 'Database not found' }
	let migrated = false
	if (kind === 'json') {
		let raw: Record<string, unknown>
		try {
			const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
			if (!parsed || typeof parsed !== 'object') return { success: false, error: 'Invalid database' }
			raw = parsed as Record<string, unknown>
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) }
		}
		try {
			const manifest = manifestFromUnknown(raw)
			const copied = findCopiedFiles(filePath, manifest)
			if (copied.length > 0) manifest.movedFiles = [...(manifest.movedFiles ?? []), ...copied]
			writePakDatabase(filePath, manifest)
			migrated = true
		} catch (error) {
			return { success: false, fallback: true, error: error instanceof Error ? error.message : String(error) }
		}
	}
	const db = openReadonly(filePath)
	try {
		const manifest = manifestFromSqlite(db)
		const root = readChildRows(db, 0)
		let direct = 0
		for (const row of root) direct += row.childCount
		const prefetch: DbPrefetch[] = []
		if (direct > 0 && direct <= AUTO_EXPAND_LIMIT) {
			for (const row of root) {
				if (row.childCount > 0) prefetch.push({ parentId: row.id, rows: readChildRows(db, row.id) })
			}
		}
		return { success: true, migrated, info: slimInfo(manifest), root, prefetch }
	} finally {
		db.close()
	}
}

export function withReadonly<T>(filePath: string, read: (db: Database.Database) => T): T {
	const db = openReadonly(filePath)
	try {
		return read(db)
	} finally {
		db.close()
	}
}

