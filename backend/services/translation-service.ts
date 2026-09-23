import { promises as fsp } from 'fs'
import path from 'path'
import { MessageChannel } from 'node:worker_threads'
import { Piscina } from 'piscina'
import { decryptFolderParallel, createDecryptPool, resolveUnpakWorkerFile, resolveRepakWorkerFile } from './decrypt-pool'
import type { DecryptFolderOptions } from './decrypt-pool'
import { errorMessage, type ProgressCallback } from './progress'
import { extractPaksParallel } from './unpak-parallel'
import {
	PAK_DIR,
	REPAKED_DIR,
	UNPAKED_DIR,
	unpakedLegacyRootDbForFolder,
	unpakedRootDbForFolder,
} from './paths'
import { mapPool, cpuConcurrency } from './parallel'
import { cpuThreadsForWork, innerConcurrency } from './threads'
import { listFilesInPak } from '../core/unpak'
import type { UnpakTaskInput, UnpakTaskResult } from '../workers/unpak-task'
import type { RepakTaskInput, RepakTaskResult } from '../workers/repak-task'
import type { ConflictChoice, ExtractConflictRequest } from '../../shared/api-types'

export interface TranslationServiceOptions {
	onProgress?: ProgressCallback;
	signal?: AbortSignal;
	/** Interactive resolver for `.pak` conflicts; when absent, conflicts are skipped. */
	onConflict?: (request: ExtractConflictRequest) => Promise<ConflictChoice>;
}

export interface ExtractFolderPayload {
	inputFolder: string;
	includeNonPak: boolean;
	overwrite: boolean;
	/** Legacy (unused): kept so old payloads still typecheck. */
	outputFolder?: string;
	/** Legacy (unused): kept so old payloads still typecheck. */
	translationName?: string;
	/** Legacy (unused): kept so old payloads still typecheck. */
	dbPath?: string;
}

export interface ExtractFolderResult {
	outputFolder: string;
	paksExtracted: number;
	otherFilesCopied: number;
	dbPaths: string[];
	skippedExisting: string[];
}

export interface TranslationResults {
	success: unknown[];
	failed: unknown[];
}

async function ensureDir(p: string): Promise<void> {
	await fsp.mkdir(p, { recursive: true })
}

async function existsAsync(p: string): Promise<boolean> {
	try {
		await fsp.access(p)
		return true
	} catch {
		return false
	}
}

async function rmAsync(p: string): Promise<void> {
	try {
		await fsp.rm(p, { recursive: true, force: true })
	} catch {
		// ignore cleanup errors
	}
}

function abortIfCanceled(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error('Operation canceled')
	}
}

async function runRepakPoolWithProgress(
	repakPool: Piscina<RepakTaskInput, RepakTaskResult>,
	input: Omit<RepakTaskInput, 'port'>,
	onProgress: ProgressCallback | undefined,
	signal: AbortSignal | undefined,
	packageCtx: { packageName: string; packageIndex: number; packageTotal: number },
): Promise<void> {
	const channel = new MessageChannel()
	const { port1, port2 } = channel
	let finished = false
	const abortListener = (): void => {
		try {
			port1.postMessage({ type: 'abort' })
		} catch {
			// ignore
		}
	}
	const messageHandler = (msg: unknown): void => {
		if (!msg || typeof msg !== 'object') return
		const m = msg as Record<string, unknown>
		if (m['type'] !== 'progress') return
		const current = typeof m['current'] === 'number' ? m['current'] : undefined
		const total = typeof m['total'] === 'number' ? m['total'] : undefined
		const percent = typeof m['percent'] === 'number' ? m['percent'] : undefined
		if (typeof current !== 'number' || typeof total !== 'number' || typeof percent !== 'number') return
		const fileName = typeof m['fileName'] === 'string' && m['fileName'].length > 0 ? (m['fileName'] as string) : undefined
		const bytesDelta = typeof m['bytesDelta'] === 'number' && m['bytesDelta'] > 0 ? (m['bytesDelta'] as number) : undefined
		onProgress?.(
			{
				stage: 'repak',
				packageName: packageCtx.packageName,
				packageIndex: packageCtx.packageIndex,
				packageTotal: packageCtx.packageTotal,
				current,
				total,
				percent,
				bytesDelta,
				fileName,
				file: input.inputFolder,
				output: input.outputPak,
			},
			{ current, total },
		)
	}
	// Ensure port1 will emit 'message' events
	try {
		;(port1 as unknown as { on: (ev: string, cb: (m: unknown) => void) => void }).on('message', messageHandler)
	} catch {
		// ignore
	}
	if (signal) {
		if (signal.aborted) {
			abortListener()
		} else {
			signal.addEventListener('abort', abortListener, { once: true })
		}
	}
	try {
		await repakPool.run(
			{ ...input, port: port2, concurrency: input.concurrency ?? cpuThreadsForWork() } as RepakTaskInput,
			{ transferList: [port2], signal: signal ?? undefined } as unknown as Parameters<typeof repakPool.run>[1],
		)
	} finally {
		finished = true
		void finished
		if (signal) {
			try {
				signal.removeEventListener('abort', abortListener)
			} catch {
				// ignore
			}
		}
		try {
			;(port1 as unknown as { off?: (ev: string, cb: (...a: unknown[]) => void) => void }).off?.('message', messageHandler as (...a: unknown[]) => void)
		} catch {
			// ignore
		}
		try {
			port1.close()
		} catch {
			// ignore
		}
		// port2 was transferred to worker; closing here is no-op if detached, but ensure not leaking
		try {
			;(port2 as unknown as { close?: () => void }).close?.()
		} catch {
			// ignore if already detached/closed
		}
	}
}

function decryptFailuresSample(failed: { path: string; error: string }[]): string {
	const samples = failed
		.slice(0, 3)
		.map((f) => `${f.path}: ${String(f.error).slice(0, 160)}`)
	return samples.length > 0 ? ` (${samples.join('; ')})` : ''
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		await fsp.access(filePath)
	} catch {
		return null
	}
	try {
		const text = await fsp.readFile(filePath, 'utf8')
		return JSON.parse(text) as Record<string, unknown>
	} catch {
		return null
	}
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(filePath))
	await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function isSubPath(parent: string, child: string): boolean {
	const rel = path.relative(parent, child)
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function toPosix(p: string): string {
	return p.split(path.sep).join('/')
}

function isPakDirName(name: string): boolean {
	return path.extname(name).toLowerCase() === '.pak'
}

/** Posix dirname with `.` normalized to `''` (so `x.pak` -> ``, `a/x.pak` -> `a`). */
function posixDirname(relPosix: string): string {
	const d = path.posix.dirname(relPosix)
	return d === '.' ? '' : d
}

/** Reject absolute paths, drive letters and `..` segments in a DB-relative path. */
function isUnsafeRelPath(p: string): boolean {
	if (p === '') return false
	if (path.isAbsolute(p) || p.startsWith('/') || p.startsWith('\\')) return true
	if (/^[a-zA-Z]:/.test(p)) return true
	return p.split(/[\\/]/).some((seg) => seg === '..')
}

async function walkAllFiles(
	rootDir: string,
	signal?: AbortSignal,
	onProgress?: (filesFound: number, entriesScanned: number) => void,
): Promise<string[]> {
	const results: string[] = []
	let entriesScanned = 0
	async function walk(dir: string): Promise<void> {
		abortIfCanceled(signal)
		let names: string[]
		try {
			names = await fsp.readdir(dir)
		} catch {
			return
		}
		for (const name of names) {
			const fullPath = path.join(dir, name)
			let stat
			try {
				stat = await fsp.stat(fullPath)
			} catch {
				continue
			}
			entriesScanned += 1
			if (stat.isDirectory()) {
				await walk(fullPath)
			} else if (stat.isFile()) {
				results.push(fullPath)
			}
			if (entriesScanned % 100 === 0) {
				// yield to event loop to keep UI responsive
				await new Promise<void>((resolve) => setImmediate(resolve))
				abortIfCanceled(signal)
				onProgress?.(results.length, entriesScanned)
			}
		}
	}
	await walk(rootDir)
	return results
}

/**
 * Deletes legacy per-pak sibling DBs (`.../name.pak.db`) inside the extract
 * tree once the aggregate root DB
 * (`PAKS/unpaked/<folderName>/<folderName>.db`) is written.
 * Never touches the aggregate root DB itself, nor any `.db` outside the tree.
 */
async function removeLegacySiblingDbs(
	extractRoot: string,
	rootDbPath: string,
	signal: AbortSignal | undefined,
	onRemoved?: (removed: number) => void,
): Promise<number> {
	const rootResolved = path.resolve(extractRoot)
	const rootDbResolved = path.resolve(rootDbPath)
	let removed = 0
	async function walk(dir: string): Promise<void> {
		abortIfCanceled(signal)
		let entries: import('fs').Dirent[]
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				await walk(full)
				continue
			}
			if (!entry.isFile()) continue
			// Legacy per-pak siblings are always `<name>.pak.db`; never delete other
			// `.db` files that belong to mirrored non-pak client content.
			if (!entry.name.toLowerCase().endsWith('.pak.db')) continue
			if (path.resolve(full) === rootDbResolved) continue
			// Never delete aggregate root DBs that happen to be named
			// `<folder>.pak.db` (folder itself ends in `.pak`): they carry `paks[]`.
			const json = await readJsonFile(full)
			if (json && Array.isArray(json['paks'])) continue
			try {
				await fsp.rm(full, { force: true })
				removed += 1
			} catch {
				// ignore individual delete failures
			}
			if (removed > 0 && removed % 100 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve))
				onRemoved?.(removed)
			}
		}
	}
	try {
		const st = await fsp.stat(rootResolved)
		if (!st.isDirectory()) return 0
	} catch {
		return 0
	}
	await walk(rootResolved)
	return removed
}

/** Collect `*.pak` extract dirs: the selection itself if named `*.pak`, plus recursive children. */
async function collectPakDirs(selectionAbs: string, signal?: AbortSignal): Promise<string[]> {
	const found: string[] = []
	async function walk(dir: string): Promise<void> {
		abortIfCanceled(signal)
		let names: string[]
		try {
			names = await fsp.readdir(dir)
		} catch {
			return
		}
		for (const name of names) {
			const fullPath = path.join(dir, name)
			let stat
			try {
				stat = await fsp.stat(fullPath)
			} catch {
				continue
			}
			if (!stat.isDirectory()) continue
			if (isPakDirName(name)) {
				found.push(fullPath)
				continue
			}
			await walk(fullPath)
			if (found.length % 50 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve))
				abortIfCanceled(signal)
			}
		}
	}
	if (isPakDirName(path.basename(selectionAbs))) {
		found.push(selectionAbs)
		return found
	}
	await walk(selectionAbs)
	return found
}

export interface AggregatedPakEntry {
	relPakPath: string;
	sourcePak?: string;
	/** v3 legacy: absolute `<name>.pak/` wrapper folder (removed after reconstruct). */
	outputFolder?: string;
	/** v4: posix dir under the unpaked root where this pak's files were extracted (may be `''`). */
	destDir?: string;
	files: string[];
	fileCount?: number;
}

function normalizePakEntry(value: unknown): AggregatedPakEntry | null {
	if (!value || typeof value !== 'object') return null
	const v = value as Record<string, unknown>
	const relPakPath = typeof v['relPakPath'] === 'string' ? (v['relPakPath'] as string) : ''
	if (relPakPath === '' || !Array.isArray(v['files'])) return null
	return {
		relPakPath,
		sourcePak: typeof v['sourcePak'] === 'string' ? (v['sourcePak'] as string) : undefined,
		outputFolder: typeof v['outputFolder'] === 'string' ? (v['outputFolder'] as string) : undefined,
		destDir: typeof v['destDir'] === 'string' ? (v['destDir'] as string) : undefined,
		files: (v['files'] as unknown[]).filter((f): f is string => typeof f === 'string'),
		fileCount: typeof v['fileCount'] === 'number' ? (v['fileCount'] as number) : undefined,
	}
}

/**
 * Reads the aggregate full-folder DB, stored inside the extracted folder
 * (`<selection>/<selection>.db`, versions 3 and 4 with `paks[]`), falling back
 * to the legacy sibling location (`<selection>.db`). Returns `null` when absent
 * or when it is a legacy single-pak DB.
 */
async function readAggregatedPakEntries(selectionAbs: string): Promise<AggregatedPakEntry[] | null> {
	const raw = (await readJsonFile(unpakedRootDbForFolder(selectionAbs)))
		?? (await readJsonFile(unpakedLegacyRootDbForFolder(selectionAbs)))
	if (!raw || !Array.isArray(raw['paks'])) return null
	return (raw['paks'] as unknown[]).map(normalizePakEntry).filter((e): e is AggregatedPakEntry => e !== null)
}

/**
 * Recursive UnPAK into /PAKS/unpaked (flat model, DB version 4).
 *
 * `PAKS/pak/<folder>/.../name.pak` -> files land directly under
 * `PAKS/unpaked/<folder>/.../` (no `<name>.pak/` wrapper folders), plus a single
 * aggregate DB `PAKS/unpaked/<folder>/<folder>.db` (inside the extracted folder,
 * version 4 with `paks[]` carrying `destDir` + a `files` manifest taken from the
 * pak TOC). Every path is rooted
 * at `<basename(input)>` — identical to the old layout for first-level folders
 * under /PAKS/pak, consistent for custom/nested inputs. Optional non-pak files
 * mirror under the same root. Skip is keyed by the DB manifest (`!overwrite`),
 * not by on-disk wrappers; legacy wrappers/sibling `*.db` files are removed
 * after a pak is re-extracted / after the root DB is written. Multiple paks
 * extract in parallel via UnPAK workers; global progress is monotonic and based
 * on `completedUnits + sum(in-flight fractions)`.
 */
export async function extractFolder(
	payload: ExtractFolderPayload,
	options: TranslationServiceOptions = {},
): Promise<ExtractFolderResult> {
	const onProgress = options.onProgress
	const inputResolved = path.resolve(payload.inputFolder)

	try {
		const st = await fsp.stat(inputResolved)
		if (!st.isDirectory()) throw new Error(`Input folder not found: ${inputResolved}`)
	} catch {
		throw new Error(`Input folder not found: ${inputResolved}`)
	}

	await ensureDir(UNPAKED_DIR)

	const pakResolved = path.resolve(PAK_DIR)
	const underFiles = isSubPath(pakResolved, inputResolved) || inputResolved === pakResolved
	const relRoot = underFiles ? pakResolved : inputResolved
	// Pak content and non-pak mirrors are rooted at `<basename(input)>/…` under
	// /PAKS/unpaked, matching the aggregate DB stored inside that folder
	// (`<basename(input)>/<basename(input)>.db`). For a
	// first-level folder under /PAKS/pak this equals the old `relative(PAK_DIR, …)`.
	const inputBase = path.basename(inputResolved)
	const relToUnpaked = (abs: string): string => {
		const rel = toPosix(path.relative(inputResolved, abs))
		return rel === '' ? inputBase : `${inputBase}/${rel}`
	}

	// Boundary: `extract-folder-start` is flushed immediately by the progress sender.
	// Emitted before the walk so the UI leaves its idle state immediately.
	onProgress?.({ stage: 'extract-folder-start', percent: 0 })

	// The walk can take a while on large clients; emit a throttled "Scanning"
	// heartbeat so the bar never looks frozen at 0% before denom is known.
	const allFiles = await walkAllFiles(inputResolved, options.signal, (filesFound) => {
		onProgress?.({
			stage: 'extract-folder',
			current: 0,
			total: 0,
			percent: 0,
			message: `Scanning... (${filesFound} files)`,
		})
	})
	const pakFiles = allFiles.filter((p) => path.extname(p).toLowerCase() === '.pak')
	const otherFiles = payload.includeNonPak
		? allFiles.filter((p) => path.extname(p).toLowerCase() !== '.pak')
		: []

	const rootDbPath = unpakedRootDbForFolder(inputResolved)
	const legacyRootDbPath = unpakedLegacyRootDbForFolder(inputResolved)

	const skippedExisting: string[] = []
	let paksExtracted = 0
	let otherFilesCopied = 0
	// File-based global progress (extracted + copied + skipped files). The total
	// is known once every PAK is scanned; until then `denomFiles` stays 1.
	let doneFiles = 0
	let denomFiles = 1
	// Backend high-water mark so concurrent jobs never emit a regressing percent.
	let lastPercent = 0
	// The verification/prompt pass fills the first slice of the bar so it keeps
	// moving while files are checked and never jumps to 100% before the real work.
	const VERIFY_SHARE = 10

	function emitProgress(
		stage: string,
		percent: number,
		fileName: string,
		message: string,
		context: { packageName?: string; packageIndex?: number; packageTotal?: number; globalPercent?: boolean } = {},
	): void {
		const clamped = Math.max(0, Math.min(percent, 100))
		if (clamped > lastPercent) lastPercent = clamped
		const value = Math.round(lastPercent * 10) / 10
		onProgress?.(
			{
				stage,
				current: doneFiles,
				total: denomFiles,
				percent: value,
				fileName,
				message,
				...context,
			},
			{ current: doneFiles, total: denomFiles },
		)
	}

	/** Global percent for the extraction/copy phases (second slice of the bar). */
	function extractionPercent(filesDone: number): number {
		return VERIFY_SHARE + (filesDone / denomFiles) * (100 - VERIFY_SHARE)
	}

	// Read the existing aggregate DB up front: skip decisions use the manifest
	// (v3 `outputFolder` entries and v4 `destDir` entries alike), not disk state.
	// Prefer the current location (inside the extracted folder) and fall back to
	// the legacy sibling DB written by older versions.
	const existingRaw = (await readJsonFile(rootDbPath)) ?? (await readJsonFile(legacyRootDbPath))
	const existingEntries = existingRaw && Array.isArray(existingRaw['paks'])
		? (existingRaw['paks'] as unknown[]).map(normalizePakEntry).filter((e): e is AggregatedPakEntry => e !== null)
		: []
	const byRelPakPath = new Map<string, AggregatedPakEntry>()
	for (const entry of existingEntries) byRelPakPath.set(toPosix(entry.relPakPath), entry)

	type PakJob = { pakPath: string; relPakPath: string; destDir: string; destDirAbs: string; legacyWrapper: string }
	const candidates: PakJob[] = []
	for (const pakPath of pakFiles) {
		abortIfCanceled(options.signal)
		const relPakPath = relToUnpaked(pakPath)
		const destDir = posixDirname(relPakPath)
		const destDirAbs = destDir === '' ? UNPAKED_DIR : path.join(UNPAKED_DIR, ...destDir.split('/'))
		// Legacy wrapper from the previous model: `<name>.pak/` folder under the unpaked root.
		const legacyRel = toPosix(path.relative(relRoot, pakPath))
		const legacyWrapper = path.join(UNPAKED_DIR, ...legacyRel.split('/'))
		candidates.push({ pakPath, relPakPath, destDir, destDirAbs, legacyWrapper })
		if (candidates.length % 20 === 0) await new Promise<void>((r) => setImmediate(r))
	}

	// Conflict pass: a candidate conflicts when its mirrored pak path is already
	// in the aggregate DB manifest. `overwrite` (CLI/batch) resolves everything
	// without asking; otherwise ask per pak — the UI may answer "all" so the
	// remaining conflicts resolve silently. The pre-scan below doubles as the
	// aggregate-DB manifest and the progress total, and emits verification
	// progress so the bar moves while files are checked.
	const conflictTotal = payload.overwrite
		? 0
		: candidates.filter((candidate) => byRelPakPath.has(candidate.relPakPath)).length
	let conflictMode: 'ask' | 'overwrite-all' | 'skip-all' = payload.overwrite ? 'overwrite-all' : 'ask'
	let conflictSeen = 0
	const jobs: PakJob[] = []
	let skippedFiles = 0
	let pakFilesTotal = 0
	const totalPaks = Math.max(candidates.length, 1)
	let checkedPaks = 0
	let wasCanceled = false
	for (const candidate of candidates) {
		abortIfCanceled(options.signal)
		const isConflict = !payload.overwrite && byRelPakPath.has(candidate.relPakPath)
		let accept = true
		let files: string[] | null = null
		if (isConflict && conflictMode === 'ask') {
			conflictSeen += 1
			files = await listFilesInPak(candidate.pakPath, () => options.signal?.aborted ?? false)
			const choice = options.onConflict
				? await options.onConflict({
					packageName: path.basename(candidate.pakPath),
					relPakPath: candidate.relPakPath,
					fileCount: files.length,
					conflictIndex: conflictSeen,
					conflictTotal,
				})
				: 'skip'
			if (choice === 'cancel') {
				wasCanceled = true
				break
			}
			if (choice === 'skip-all') { conflictMode = 'skip-all'; accept = false }
			else if (choice === 'overwrite-all') { conflictMode = 'overwrite-all'; accept = true }
			else accept = choice !== 'skip'
		} else if (isConflict) {
			accept = conflictMode === 'overwrite-all'
		}
		if (!files) files = await listFilesInPak(candidate.pakPath, () => options.signal?.aborted ?? false)
		if (accept) {
			await ensureDir(candidate.destDirAbs)
			jobs.push(candidate)
		} else {
			skippedExisting.push(candidate.relPakPath)
			skippedFiles += files.length
		}
		pakFilesTotal += files.length
		checkedPaks += 1
		emitProgress(
			'extract-folder-check',
			(checkedPaks / totalPaks) * VERIFY_SHARE,
			'',
			`Checking ${candidate.relPakPath}`,
			{ packageName: path.basename(candidate.pakPath), packageIndex: checkedPaks, packageTotal: candidates.length },
		)
	}

	if (wasCanceled) {
		const canceled = new Error('Operation canceled')
		canceled.name = 'AbortError'
		throw canceled
	}

	denomFiles = Math.max(pakFilesTotal + otherFiles.length, 1)
	doneFiles = skippedFiles

	// Drop the legacy `<name>.pak/` wrapper + its sibling `.db` BEFORE writing
	// (wrapper only when it is a directory — never a same-named extracted file).
	// The source `.pak` still exists, so a failed extract loses nothing unique.
	for (const job of jobs) {
		try {
			const st = await fsp.stat(job.legacyWrapper)
			if (st.isDirectory()) await rmAsync(job.legacyWrapper)
		} catch {
			// no legacy wrapper
		}
		await rmAsync(`${job.legacyWrapper}.db`)
	}

	// 100% assíncrono: exclusivamente em workers Piscina; sem fallback síncrono no main.
	let unpakPool: Piscina<UnpakTaskInput, UnpakTaskResult> | null = null
	if (jobs.length > 0) {
		try {
			unpakPool = new Piscina({ filename: resolveUnpakWorkerFile(), maxThreads: cpuThreadsForWork() })
		} catch (error) {
			throw new Error(`UnPAK worker pool unavailable: ${errorMessage(error)}`)
		}
	}

	const extractedEntries: AggregatedPakEntry[] = []
	try {
		if (jobs.length > 0) {
			if (!unpakPool) throw new Error('UnPAK worker pool unavailable')
			const unpakJobs = jobs.map((job, i) => ({
				pakPath: job.pakPath,
				outputFolder: job.destDirAbs,
				packageName: path.basename(job.pakPath),
				packageIndex: i + 1,
				packageTotal: jobs.length,
			}))
			// Each PAK is split into entry chunks on a shared pool: a single PAK
			// uses several worker threads, and chunks from different PAKs interleave.
			const outcomes = await extractPaksParallel(
				unpakJobs,
				unpakPool,
				cpuThreadsForWork(),
				(payload) => {
					if (payload.stage !== 'unpack') return
					doneFiles = skippedFiles + (payload.current ?? 0)
					emitProgress('unpack', extractionPercent(doneFiles), payload.fileName ?? '', '', {
						packageName: payload.packageName,
						packageIndex: payload.packageIndex,
						packageTotal: payload.packageTotal,
						globalPercent: true,
					})
				},
				options.signal,
			)
			const byPak = new Map(jobs.map((j) => [j.pakPath, j]))
			for (const outcome of outcomes) {
				if (!outcome.ok) throw new Error(`UnPAK failed for '${outcome.job.packageName}': ${outcome.error ?? 'unknown error'}`)
				const job = byPak.get(outcome.job.pakPath)
				if (!job) continue
				const files = outcome.files.slice().sort()
				extractedEntries.push({
					relPakPath: job.relPakPath,
					sourcePak: job.pakPath,
					destDir: job.destDir,
					files,
					fileCount: files.length,
				} as AggregatedPakEntry)
				paksExtracted += 1
			}
		}
	} finally {
		if (unpakPool) await unpakPool.destroy()
	}
	doneFiles = pakFilesTotal

	// Aggregate one root DB under /PAKS/unpaked (version 4): entries read before
	// the job loop already live in `byRelPakPath`; upsert the ones extracted now.
	for (const entry of extractedEntries) {
		// Drop stale rows for the same source pak (the key changes when the extract
		// root is basename-re-rooted, e.g. custom/nested input dirs).
		if (entry.sourcePak) {
			const want = path.resolve(entry.sourcePak)
			for (const [key, prev] of byRelPakPath) {
				if (prev.sourcePak && path.resolve(prev.sourcePak) === want) byRelPakPath.delete(key)
			}
		}
		byRelPakPath.set(toPosix(entry.relPakPath), entry)
	}

	const mergedPaks = [...byRelPakPath.values()].sort((a, b) => a.relPakPath.localeCompare(b.relPakPath))
	const dbPaths: string[] = []
	if (mergedPaks.length > 0) {
		await writeJsonFile(rootDbPath, {
			version: 4,
			folderName: path.basename(inputResolved),
			inputFolder: inputResolved,
			createdAt: new Date().toISOString(),
			paks: mergedPaks,
		})
		dbPaths.push(rootDbPath)
		emitProgress('extract-folder', extractionPercent(doneFiles), path.basename(rootDbPath), `Wrote ${path.basename(rootDbPath)}`)
		// The DB now lives inside the extracted folder; drop the legacy sibling
		// (`PAKS/unpaked/<folder-name>.db`) written by older versions.
		await rmAsync(legacyRootDbPath)
		// The aggregate DB supersedes the legacy per-pak sibling DBs: drop them so
		// `unpaked/` keeps a single root DB per extracted folder (root DB untouched).
		// Walk root follows where legacy wrappers actually live
		// (`relative(relRoot, input)` under the unpaked root), not just the basename.
		const relRootToInput = path.relative(relRoot, inputResolved)
		const extractionRoot = relRootToInput === ''
			? UNPAKED_DIR
			: path.join(UNPAKED_DIR, ...relRootToInput.split(/[\\/]/))
		await removeLegacySiblingDbs(
			extractionRoot,
			rootDbPath,
			options.signal,
			(count) => emitProgress(
				'extract-folder',
				extractionPercent(doneFiles),
				path.basename(inputResolved),
				`Cleaning legacy DBs... ${count}`,
			),
		)
	}

	// Parallel non-pak copy (I/O bound, limited concurrency).
	await mapPool(
		otherFiles,
		Math.min(cpuConcurrency(), Math.max(otherFiles.length, 1)),
		async (filePath) => {
			abortIfCanceled(options.signal)
			const relPath = relToUnpaked(filePath)
			const destPath = path.join(UNPAKED_DIR, ...relPath.split('/'))
			if (!payload.overwrite && (await existsAsync(destPath))) {
				skippedExisting.push(relPath)
				doneFiles += 1
				emitProgress('extract-folder', extractionPercent(doneFiles), relPath, `Skipped (exists) ${relPath}`)
				return
			}
			await ensureDir(path.dirname(destPath))
			await fsp.copyFile(filePath, destPath)
			otherFilesCopied += 1
			doneFiles += 1
			emitProgress('extract-folder', extractionPercent(doneFiles), relPath, `Copying ${relPath}`)
		},
		options.signal,
	)

	// Boundary: `extract-folder-done` is flushed immediately by the progress sender.
	onProgress?.({ stage: 'extract-folder-done', percent: 100 })

	return {
		outputFolder: UNPAKED_DIR,
		paksExtracted,
		otherFilesCopied,
		dbPaths,
		skippedExisting,
	}
}

export async function decryptTranslations(
	folderPaths: string[],
	options: TranslationServiceOptions = {},
): Promise<TranslationResults> {
	const onProgress = options.onProgress
	const results: TranslationResults = { success: [], failed: [] }
	const totalFolders = folderPaths.length
	if (totalFolders === 0) return results

	const decryptPool = createDecryptPool()
	try {
		const outcomes = await mapPool(
			folderPaths,
			Math.min(cpuThreadsForWork(), totalFolders),
			async (folder, i) => {
				abortIfCanceled(options.signal)
				const name = path.basename(folder)
				const folderIndex = i + 1
				onProgress?.({
					stage: 'decrypt-start',
					packageName: name,
					packageIndex: folderIndex,
					packageTotal: totalFolders,
					percent: 0,
				})
				try {
					const decryptOptions: DecryptFolderOptions = {
						onProgress: (payload, opts) => {
							onProgress?.(
								{ ...payload, packageName: name, packageIndex: folderIndex, packageTotal: totalFolders },
								opts,
							)
						},
						signal: options.signal,
						packageName: name,
						packageIndex: folderIndex,
						packageTotal: totalFolders,
						pool: decryptPool,
					}
					const decryptResults = await decryptFolderParallel(folder, decryptOptions)
					onProgress?.({
						stage: 'decrypt-done',
						packageName: name,
						packageIndex: folderIndex,
						packageTotal: totalFolders,
						percent: 100,
					})
					if (decryptResults.failed.length > 0) {
						return { ok: false as const, failure: { folderPath: folder, error: `Decrypted with ${decryptResults.failed.length} failures${decryptFailuresSample(decryptResults.failed)}` } }
					}
					return { ok: true as const, entry: { folderPath: folder } }
				} catch (error) {
					return { ok: false as const, failure: { folderPath: folder, error: errorMessage(error) } }
				}
			},
			options.signal,
		)
		for (const o of outcomes) {
			if (o.ok) results.success.push(o.entry)
			else results.failed.push(o.failure)
		}
	} finally {
		await decryptPool.destroy()
	}

	return results
}

/** `/PAKS/unpaked/<rel>` (or `/PAKS/unpaked/<rel>.pak`) -> `/PAKS/repaked/<rel>[.pak]` without duplicating `.pak`. */
function simpleRepakOutput(selectionAbs: string): string {
	const unpakedResolved = path.resolve(UNPAKED_DIR)
	const rel = isSubPath(unpakedResolved, selectionAbs)
		? toPosix(path.relative(unpakedResolved, selectionAbs))
		: path.basename(selectionAbs)
	const parts = rel.split('/')
	const last = parts[parts.length - 1] ?? ''
	const normalizedLast = last.toLowerCase().endsWith('.pak') ? last : `${last}.pak`
	return path.join(REPAKED_DIR, ...[...parts.slice(0, -1), normalizedLast])
}

async function repackSimpleFolder(
	selectionAbs: string,
	folderName: string,
	folderIndex: number,
	totalSelections: number,
	onProgress: ProgressCallback | undefined,
	signal: AbortSignal | undefined,
	repakPool: Piscina<RepakTaskInput, RepakTaskResult>,
): Promise<{ ok: boolean; entry?: unknown; failure?: unknown; doneStage: boolean }> {
	const pakOutPath = simpleRepakOutput(selectionAbs)
	await ensureDir(path.dirname(pakOutPath))
	const packageName = path.basename(pakOutPath)

	onProgress?.({
		stage: 'repak-start',
		packageName,
		packageIndex: 1,
		packageTotal: 1,
		percent: 0,
	})

	// Staging outside source tree, under REPAKED_DIR, so source walk never sees it
	const stagingRoot = path.join(
		path.resolve(REPAKED_DIR),
		'._tmp_repack',
		`${Date.now()}-${Math.random().toString(16).slice(2)}`,
	)
	await ensureDir(stagingRoot)

	try {
		const filesToCopy: string[] = []
		const emptyDirs: string[] = []

		async function walkSimple(cur: string, rel: string): Promise<void> {
			abortIfCanceled(signal)
			let names: string[]
			try {
				names = await fsp.readdir(cur)
			} catch {
				return
			}
			for (const name of names) {
				if (name === '._tmp_repack') continue
				const fullPath = path.join(cur, name)
				let stat
				try {
					stat = await fsp.stat(fullPath)
				} catch {
					continue
				}
				if (stat.isDirectory()) {
					const nextRel = rel ? `${rel}/${name}` : name
					await walkSimple(fullPath, nextRel)
					const destDir = path.join(stagingRoot, nextRel)
					if (!(await existsAsync(destDir))) {
						emptyDirs.push(nextRel)
					}
				} else if (stat.isFile()) {
					if (name === '.pak-metadata.json') continue
					const lower = name.toLowerCase()
					if (lower.endsWith('.db') || lower.endsWith('.pak')) continue
					filesToCopy.push(fullPath)
				}
				if (filesToCopy.length % 50 === 0 || emptyDirs.length % 50 === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve))
					abortIfCanceled(signal)
				}
			}
		}

		await walkSimple(selectionAbs, '')
		abortIfCanceled(signal)

		if (filesToCopy.length === 0) {
			await rmAsync(stagingRoot)
			onProgress?.({
				stage: 'unpaked-repak-done',
				translationName: folderName,
				packageIndex: folderIndex,
				packageTotal: totalSelections,
				percent: Math.round((folderIndex / Math.max(totalSelections, 1)) * 1000) / 10,
			})
			return {
				ok: false,
				failure: {
					folderName,
					translationName: folderName,
					error: `No files to repack in '${folderName}' after exclusions (empty folder or only artefacts)`,
				},
				doneStage: true,
			}
		}

		// Ensure empty directory structure in staging
		for (const dirRel of emptyDirs) {
			await ensureDir(path.join(stagingRoot, ...dirRel.split('/')))
			if (emptyDirs.indexOf(dirRel) % 20 === 0) await new Promise<void>((r) => setImmediate(r))
		}

		await mapPool(
			filesToCopy,
			Math.min(cpuConcurrency(), Math.max(filesToCopy.length, 1)),
			async (src) => {
				abortIfCanceled(signal)
				const rel = path.relative(selectionAbs, src)
				const dest = path.join(stagingRoot, rel)
				if (!isSubPath(stagingRoot, dest) && path.resolve(dest) !== path.resolve(stagingRoot)) {
					throw new Error(`Unsafe path: ${rel}`)
				}
				await ensureDir(path.dirname(dest))
				await fsp.copyFile(src, dest)
			},
			signal,
		)

		abortIfCanceled(signal)

		// 100% assíncrono: exclusivamente em workers Piscina; sem fallback síncrono no main.
		if (!repakPool) throw new Error('RePAK worker pool unavailable')
		await runRepakPoolWithProgress(
			repakPool,
			{ inputFolder: stagingRoot, outputPak: pakOutPath, version: 0, concurrency: innerConcurrency(totalSelections) },
			onProgress,
			signal,
			{ packageName, packageIndex: 1, packageTotal: 1 },
		)

		await rmAsync(stagingRoot)

		onProgress?.({
			stage: 'repak-done',
			packageName,
			packageIndex: 1,
			packageTotal: 1,
			percent: 100,
			output: pakOutPath,
		})
		return { ok: true, entry: { folderName, translationName: folderName, pak: packageName, outputPak: pakOutPath }, doneStage: false }
	} catch (error) {
		await rmAsync(stagingRoot)
		return { ok: false, failure: { folderName, translationName: folderName, error: errorMessage(error) }, doneStage: false }
	}
}

export async function repackTranslations(
	selectedTranslationPaths: string[],
	options: TranslationServiceOptions = {},
): Promise<TranslationResults> {
	const onProgress = options.onProgress
	const results: TranslationResults = { success: [], failed: [] }
	const totalSelections = selectedTranslationPaths.length
	if (totalSelections === 0) return results

	await ensureDir(REPAKED_DIR)

	// Global percent across every PAK reconstructed by every selection. Coarse
	// (advances per completed PAK) but spans the whole action, so the bar never
	// resets between selections.
	let totalPaks = 0
	for (const sel of selectedTranslationPaths) {
		const abs = path.resolve(sel)
		try {
			const entries = await readAggregatedPakEntries(abs)
			if (entries && entries.length > 0) {
				totalPaks += entries.length
				continue
			}
			const dirs = await collectPakDirs(abs, options.signal)
			totalPaks += dirs.length > 0 ? dirs.length : 1
		} catch {
			totalPaks += 1
		}
	}
	let paksCompleted = 0
	let lastGlobalPercent = 0
	function globalPercent(): number {
		const p = totalPaks > 0 ? (paksCompleted / totalPaks) * 100 : 0
		if (p > lastGlobalPercent) lastGlobalPercent = p
		return Math.round(lastGlobalPercent * 10) / 10
	}
	function wrapRepakProgress(): ProgressCallback {
		return (payload, opts) => {
			onProgress?.({ ...payload, percent: globalPercent(), globalPercent: true }, opts)
		}
	}

	let repakPool: Piscina<RepakTaskInput, RepakTaskResult> | null = null
	try {
		try {
			repakPool = new Piscina({ filename: resolveRepakWorkerFile(), maxThreads: cpuThreadsForWork() })
		} catch (error) {
			// 100% assíncrono: sem fallback síncrono no main. Falha estruturada por seleção.
			const msg = `RePAK worker pool unavailable: ${errorMessage(error)}`
			for (const sel of selectedTranslationPaths) {
				results.failed.push({ folderName: path.basename(path.resolve(sel)), translationName: path.basename(path.resolve(sel)), folderPath: path.resolve(sel), error: msg })
			}
			return results
		}
		const outcomes = await mapPool(
			selectedTranslationPaths,
			Math.min(cpuThreadsForWork(), totalSelections),
			async (selection, i) => {
				abortIfCanceled(options.signal)
				if (!repakPool) throw new Error('RePAK worker pool unavailable')
				const selectionAbs = path.resolve(selection)
				const folderName = path.basename(selectionAbs)
				const folderIndex = i + 1
				const localSuccess: unknown[] = []
				const localFailed: unknown[] = []

				let isDir = false
				try {
					const st = await fsp.stat(selectionAbs)
					isDir = st.isDirectory()
				} catch {
					isDir = false
				}
				if (!isDir) {
					localFailed.push({ folderName, folderPath: selectionAbs, error: `Folder not found: ${selectionAbs}` })
					return { localSuccess, localFailed, folderName, folderIndex }
				}

				// Auto-detect DB-driven reconstruct: the standard aggregate DB inside
				// the extract folder (`<selection>/<selection>.db`, versions 3 and 4;
				// legacy sibling `<selection>.db` fallback) switches RePAK to
				// reconstruction from the `paks[]` manifest. Without it, legacy
				// `*.pak/` wrapper trees (per-pak `<name>.pak.db` siblings) also
				// reconstruct per-pak; any other folder is repacked as one simple pak.
				const aggregatedEntries = await readAggregatedPakEntries(selectionAbs)
				const hasAggregateDb = aggregatedEntries !== null && aggregatedEntries.length > 0
				const pakDirs = hasAggregateDb ? [] : await collectPakDirs(selectionAbs, options.signal)

				if (!hasAggregateDb && pakDirs.length === 0) {
					const r = await repackSimpleFolder(selectionAbs, folderName, folderIndex, totalSelections, wrapRepakProgress(), options.signal, repakPool!)
					paksCompleted += 1
					if (r.ok && r.entry) localSuccess.push(r.entry)
					else if (r.failure) localFailed.push(r.failure)
					if (!r.doneStage) {
						onProgress?.({
							stage: 'unpaked-repak-done',
							translationName: folderName,
							packageIndex: folderIndex,
							packageTotal: totalSelections,
							percent: globalPercent(),
							globalPercent: true,
						})
					}
					return { localSuccess, localFailed, folderName, folderIndex }
				}

				if (aggregatedEntries && aggregatedEntries.length > 0) {
					const entries = aggregatedEntries
					// `destDir`/`relPakPath` are relative to the unpaked root, so the
					// source root is the parent of the selected extract folder.
					const rootDir = path.dirname(path.resolve(selectionAbs))
					const packageTotal = entries.length

					for (let j = 0; j < entries.length; j += 1) {
						abortIfCanceled(options.signal)
						const entry = entries[j] as AggregatedPakEntry
						const relPakPath = toPosix(entry.relPakPath)
						if (isUnsafeRelPath(relPakPath)) {
							localFailed.push({ folderName, translationName: folderName, pak: relPakPath, error: `Unsafe path in DB: ${relPakPath}` })
							continue
						}

						// Resolve source root: v4 stores `destDir` (relative to the unpaked
						// root, may be `''`); v3 stores the absolute `outputFolder` wrapper.
						let srcRoot: string
						let removeSourceAfter = false
						if (typeof entry.destDir === 'string') {
							if (isUnsafeRelPath(entry.destDir)) {
								localFailed.push({ folderName, translationName: folderName, pak: relPakPath, error: `Unsafe destDir in DB: ${entry.destDir}` })
								continue
							}
							srcRoot = entry.destDir === '' ? rootDir : path.join(rootDir, ...entry.destDir.split('/'))
						} else if (typeof entry.outputFolder === 'string' && entry.outputFolder !== '') {
							if (!(await existsAsync(entry.outputFolder))) {
								// Legacy wrapper already consumed by a previous reconstruct.
								continue
							}
							srcRoot = entry.outputFolder
							removeSourceAfter = true
						} else {
							localFailed.push({ folderName, translationName: folderName, pak: relPakPath, error: `No source location (destDir/outputFolder) in DB for '${relPakPath}'` })
							continue
						}

						if (entry.files.length === 0) {
							localFailed.push({ folderName, translationName: folderName, pak: relPakPath, error: `Empty file list in DB for '${relPakPath}'` })
							continue
						}

						const pakOutPath = path.join(REPAKED_DIR, ...relPakPath.split('/'))
						await ensureDir(path.dirname(pakOutPath))
						const packageName = path.basename(relPakPath)
						onProgress?.({
							stage: 'repak-start',
							packageName,
							packageIndex: j + 1,
							packageTotal,
							percent: globalPercent(),
							globalPercent: true,
						})

						try {
							// Stage outside the extract tree so cleanup never touches /PAKS/unpaked content.
							const stagingRoot = path.join(
								path.resolve(REPAKED_DIR),
								'._tmp_repack',
								`${Date.now()}-${Math.random().toString(16).slice(2)}`,
							)
							await ensureDir(stagingRoot)
							let staged = 0
							for (let k = 0; k < entry.files.length; k += 1) {
								const relFile = entry.files[k] as string
								abortIfCanceled(options.signal)
								if (relFile === '') continue
								if (isUnsafeRelPath(relFile)) {
									throw new Error(`Unsafe path in DB: ${relFile}`)
								}
								const src = path.join(srcRoot, ...relFile.split('/'))
								const dest = path.join(stagingRoot, ...relFile.split('/'))
								if (!isSubPath(stagingRoot, dest)) {
									throw new Error(`Unsafe path in DB: ${relFile}`)
								}
								let srcIsFile = false
								try {
									const st = await fsp.stat(src)
									srcIsFile = st.isFile()
								} catch {
									srcIsFile = false
								}
								if (srcIsFile) {
									await ensureDir(path.dirname(dest))
									await fsp.copyFile(src, dest)
									staged += 1
								}
								if (k % 50 === 49) {
									await new Promise<void>((resolve) => setImmediate(resolve))
								}
							}
							if (staged === 0) {
								throw new Error(`No source files found for '${relPakPath}' under '${srcRoot}' (0 of ${entry.files.length} staged)`)
							}

							// 100% assíncrono: exclusivamente em workers Piscina; sem fallback no main.
							if (!repakPool) throw new Error('RePAK worker pool unavailable')
							await runRepakPoolWithProgress(
								repakPool!,
								{ inputFolder: stagingRoot, outputPak: pakOutPath, version: 0, concurrency: innerConcurrency(totalSelections) },
								wrapRepakProgress(),
								options.signal,
								{ packageName, packageIndex: j + 1, packageTotal },
							)
							await rmAsync(stagingRoot)
							paksCompleted += 1
							onProgress?.({
								stage: 'repak-done',
								packageName,
								packageIndex: j + 1,
								packageTotal,
								percent: globalPercent(),
								globalPercent: true,
								output: pakOutPath,
							})
							// v3 only: the legacy wrapper is consumed; v4 sources stay in place.
							if (removeSourceAfter) await rmAsync(srcRoot)
							localSuccess.push({ folderName, translationName: folderName, pak: relPakPath, outputPak: pakOutPath })
						} catch (error) {
							localFailed.push({ folderName, translationName: folderName, pak: relPakPath, error: errorMessage(error) })
						}
					}
				} else {
					// Legacy fallback: no aggregate entries — per-pak `*.pak/` wrappers
					// + sibling `<name>.pak.db` files (collected by the auto-detect above).

					for (let j = 0; j < pakDirs.length; j += 1) {
						abortIfCanceled(options.signal)
						const pakDir = pakDirs[j] as string
						const pakBase = path.basename(pakDir)

						const legacy = await readJsonFile(`${pakDir}.db`)
						const metaFiles = legacy && Array.isArray(legacy['files'])
							? (legacy['files'] as unknown[]).filter((f): f is string => typeof f === 'string')
							: null
						const metaRelPakPath = legacy && typeof legacy['relPakPath'] === 'string' && (legacy['relPakPath'] as string).length > 0
							? toPosix(legacy['relPakPath'] as string)
							: toPosix(path.relative(path.resolve(UNPAKED_DIR), pakDir))

						if (!metaFiles) {
							localFailed.push({
								folderName,
								translationName: folderName,
								pak: pakBase,
								error: `DB not found for '${pakBase}'. Expected aggregate '${unpakedRootDbForFolder(selectionAbs)}' or legacy sibling '${unpakedLegacyRootDbForFolder(selectionAbs)}'.`,
							})
							continue
						}

						const relPakPath = metaRelPakPath
						const pakOutPath = path.join(REPAKED_DIR, ...relPakPath.split('/'))
						await ensureDir(path.dirname(pakOutPath))

						const packageName = path.basename(relPakPath)
						onProgress?.({
							stage: 'repak-start',
							packageName,
							packageIndex: j + 1,
							packageTotal: pakDirs.length,
							percent: globalPercent(),
							globalPercent: true,
						})

						try {
							// Stage outside the extract tree so cleanup never touches /PAKS/unpaked content.
							const stagingRoot = path.join(
								path.resolve(REPAKED_DIR),
								'._tmp_repack',
								`${Date.now()}-${Math.random().toString(16).slice(2)}`,
							)
							await ensureDir(stagingRoot)
							let staged = 0
							for (let k = 0; k < metaFiles.length; k += 1) {
								const relFile = metaFiles[k] as string
								abortIfCanceled(options.signal)
								if (relFile === '') continue
								if (isUnsafeRelPath(relFile)) {
									throw new Error(`Unsafe path in DB: ${relFile}`)
								}
								const src = path.join(pakDir, ...relFile.split('/'))
								const dest = path.join(stagingRoot, ...relFile.split('/'))
								if (!isSubPath(stagingRoot, dest)) {
									throw new Error(`Unsafe path in DB: ${relFile}`)
								}
								let srcIsFile = false
								try {
									const st = await fsp.stat(src)
									srcIsFile = st.isFile()
								} catch {
									srcIsFile = false
								}
								if (srcIsFile) {
									await ensureDir(path.dirname(dest))
									await fsp.copyFile(src, dest)
									staged += 1
								}
								if (k % 50 === 49) {
									await new Promise<void>((resolve) => setImmediate(resolve))
								}
							}
							if (staged === 0) {
								throw new Error(`No source files found for '${relPakPath}' under '${pakDir}' (0 of ${metaFiles.length} staged)`)
							}

							// 100% assíncrono: exclusivamente em workers Piscina; sem fallback no main.
							if (!repakPool) throw new Error('RePAK worker pool unavailable')
							await runRepakPoolWithProgress(
								repakPool!,
								{ inputFolder: stagingRoot, outputPak: pakOutPath, version: 0, concurrency: innerConcurrency(totalSelections) },
								wrapRepakProgress(),
								options.signal,
								{ packageName, packageIndex: j + 1, packageTotal: pakDirs.length },
							)
							await rmAsync(stagingRoot)
							paksCompleted += 1
							onProgress?.({
								stage: 'repak-done',
								packageName,
								packageIndex: j + 1,
								packageTotal: pakDirs.length,
								percent: globalPercent(),
								globalPercent: true,
								output: pakOutPath,
							})
							// Extract consumed: remove the `*.pak/` folder, keep the `.db` as history.
							await rmAsync(pakDir)
							localSuccess.push({ folderName, translationName: folderName, pak: relPakPath, outputPak: pakOutPath })
						} catch (error) {
							localFailed.push({ folderName, translationName: folderName, pak: relPakPath, error: errorMessage(error) })
						}
					}
				}

				onProgress?.({
					stage: 'unpaked-repak-done',
					translationName: folderName,
					packageIndex: folderIndex,
					packageTotal: totalSelections,
					percent: globalPercent(),
					globalPercent: true,
				})
				return { localSuccess, localFailed, folderName, folderIndex }
			},
			options.signal,
		)
		for (const o of outcomes) {
			for (const s of o.localSuccess) results.success.push(s)
			for (const f of o.localFailed) results.failed.push(f)
		}
	} finally {
		if (repakPool) await repakPool.destroy()
	}

	return results
}
