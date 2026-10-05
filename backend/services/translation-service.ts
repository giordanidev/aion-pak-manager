import { promises as fsp } from 'fs'
import path from 'path'
import { MessageChannel } from 'node:worker_threads'
import { Piscina } from 'piscina'
import { decryptFolderParallel, createDecryptPool, resolveUnpakWorkerFile, resolveRepakWorkerFile, resolveScanWorkerFile } from './decrypt-pool'
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
import { cpuThreadsForWork, innerConcurrency, workerResourceLimits } from './threads'
import { peekPakKind, type PakFileKind, type PakScanResult } from '../core/unpak'
import { scanPakOffThread } from './pak-scan-pool'
import { readPakManifestOffThread, writePakDatabaseOffThread } from './db-pool'
import type { PakDbManifest } from '../core/pak-db'
import type { ScanFolderTaskInput, ScanFolderTaskResult, ScannedPakFile } from '../workers/scan-folder-task'
import type { UnpakTaskInput, UnpakTaskResult } from '../workers/unpak-task'
import type { RepakTaskInput, RepakTaskResult } from '../workers/repak-task'
import type { ConflictChoice, ExtractConflictRequest } from '../../shared/api-types'

export interface TranslationServiceOptions {
	onProgress?: ProgressCallback;
	signal?: AbortSignal;
	/** Interactive resolver for `.pak` conflicts; when absent, conflicts are skipped. */
	onConflict?: (request: ExtractConflictRequest) => Promise<ConflictChoice>;
	/** Extraction output root (custom "unpaked" folder); defaults to /PAKS/unpaked. */
	unpakedDir?: string;
	/** RePAK output root (custom "repaked" folder); defaults to /PAKS/repaked. */
	repakedDir?: string;
	/** Source PAK root (custom "pak" folder); defaults to /PAKS/pak. */
	pakDir?: string;
}

export interface ExtractFolderPayload {
	inputFolder: string;
	includeNonPak: boolean;
	overwrite: boolean;
	/**
	 * Nest each `.pak` under a stem-named folder (`…/name/`) instead of the
	 * mirrored parent. Chromium packs always nest. Persisted via `destDir` in the DB.
	 */
	createPakFolder?: boolean;
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
	/** Files written from UnPAK (sum of TOC entries across successful paks). */
	extractedFiles: number;
	/** Bytes written while UnPAKing (compressed payload sizes reported as progress). */
	extractedBytes: number;
	/** Bytes copied for non-pak / non-AION mirrors. */
	otherFilesBytes: number;
	dbPaths: string[];
	skippedExisting: string[];
	/** Non-AION `.pak` (e.g. CEF) and extract failures that were skipped/copied. */
	failedPaks?: { relPakPath: string; error: string }[];
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
		return await readPakManifestOffThread(filePath)
	} catch {
		return null
	}
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

function pumpMain(): Promise<void> {
	// setTimeout (not setImmediate) returns to the native message loop so
	// Windows does not mark the window "Not Responding" during a long walk.
	return new Promise((resolve) => setTimeout(resolve, 0))
}

let scanPool: Piscina<ScanFolderTaskInput, ScanFolderTaskResult> | null = null

function getScanPool(): Piscina<ScanFolderTaskInput, ScanFolderTaskResult> {
	if (!scanPool) {
		scanPool = new Piscina({
			filename: resolveScanWorkerFile(),
			maxThreads: 1,
			resourceLimits: {
				maxOldGenerationSizeMb: 2048,
				maxYoungGenerationSizeMb: 128,
			},
		})
	}
	return scanPool
}

function isExtractableKind(kind: PakFileKind): kind is ScannedPakFile['kind'] {
	return kind === 'aion' || kind === 'zip' || kind === 'chromium'
}

/** Main-process fallback when the scan worker cannot start. Yields often enough to keep the window alive. */
async function scanFolderInProcess(
	rootDir: string,
	includeNonPak: boolean,
	signal: AbortSignal | undefined,
	onProgress?: (filesFound: number) => void,
): Promise<ScanFolderTaskResult> {
	const pakFiles: ScannedPakFile[] = []
	const otherFiles: string[] = []
	let filesFound = 0
	let scanned = 0
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
			scanned += 1
			if (stat.isDirectory()) {
				await walk(fullPath)
			} else if (stat.isFile()) {
				filesFound += 1
				const ext = path.extname(name).toLowerCase()
				if (ext === '.pak') {
					const kind = peekPakKind(fullPath)
					if (isExtractableKind(kind)) pakFiles.push({ path: fullPath, kind })
					else if (includeNonPak) otherFiles.push(fullPath)
				} else if (includeNonPak) {
					otherFiles.push(fullPath)
				}
			}
			if ((scanned & 31) === 0) {
				await pumpMain()
				abortIfCanceled(signal)
				onProgress?.(filesFound)
			}
		}
	}
	await walk(rootDir)
	onProgress?.(filesFound)
	return { pakFiles, otherFiles, filesFound }
}

/**
 * Walk + classify off the Electron main thread. Progress counts come back on a
 * MessagePort so the window keeps painting while the disk is scanned.
 */
async function scanFolderOffThread(
	rootDir: string,
	includeNonPak: boolean,
	signal: AbortSignal | undefined,
	onProgress?: (filesFound: number) => void,
): Promise<ScanFolderTaskResult> {
	const channel = new MessageChannel()
	const { port1, port2 } = channel
	const abortListener = (): void => {
		try {
			port1.postMessage({ type: 'abort' })
		} catch {
			// ignore
		}
	}
	const messageHandler = (msg: unknown): void => {
		if (!msg || typeof msg !== 'object') return
		const filesFound = (msg as { filesFound?: unknown }).filesFound
		if ((msg as { type?: unknown }).type === 'progress' && typeof filesFound === 'number') {
			onProgress?.(filesFound)
		}
	}
	try {
		port1.on('message', messageHandler)
	} catch {
		// ignore
	}
	if (signal) {
		if (signal.aborted) abortListener()
		else signal.addEventListener('abort', abortListener, { once: true })
	}
	try {
		return await getScanPool().run(
			{ rootDir, includeNonPak, port: port2 },
			{ transferList: [port2], signal: signal ?? undefined } as unknown as Parameters<Piscina['run']>[1],
		)
	} catch (error) {
		if (signal?.aborted || /canceled/i.test(errorMessage(error))) throw error
		const message = errorMessage(error)
		const workerUnavailable = /worker file not found|cannot find module|MODULE_NOT_FOUND/i.test(message)
		if (!workerUnavailable) throw error
		return scanFolderInProcess(rootDir, includeNonPak, signal, onProgress)
	} finally {
		if (signal) {
			try {
				signal.removeEventListener('abort', abortListener)
			} catch {
				// ignore
			}
		}
		try {
			port1.off('message', messageHandler)
		} catch {
			// ignore
		}
		try {
			port1.close()
		} catch {
			// ignore
		}
	}
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
				await pumpMain()
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
				await pumpMain()
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
async function readAggregateDb(
	selectionAbs: string,
	unpakedRoot: string = UNPAKED_DIR,
): Promise<{ paks: AggregatedPakEntry[]; movedFiles: string[] } | null> {
	const raw = (await readJsonFile(unpakedRootDbForFolder(selectionAbs, unpakedRoot)))
		?? (await readJsonFile(unpakedLegacyRootDbForFolder(selectionAbs, unpakedRoot)))
	if (!raw || !Array.isArray(raw['paks'])) return null
	const paks = (raw['paks'] as unknown[]).map(normalizePakEntry).filter((e): e is AggregatedPakEntry => e !== null)
	const movedFiles = Array.isArray(raw['movedFiles'])
		? (raw['movedFiles'] as unknown[]).filter((file): file is string => typeof file === 'string')
		: []
	return { paks, movedFiles }
}

async function readAggregatedPakEntries(
	selectionAbs: string,
	unpakedRoot: string = UNPAKED_DIR,
): Promise<AggregatedPakEntry[] | null> {
	const db = await readAggregateDb(selectionAbs, unpakedRoot)
	return db ? db.paks : null
}

/** Copy extract-mirrored files (not inside any pak) onto the RePAK root. */
async function copyMovedFilesToRepak(
	movedFiles: string[],
	unpakedRoot: string,
	repakedRoot: string,
	folderName: string,
	onProgress: ProgressCallback | undefined,
	signal: AbortSignal | undefined,
): Promise<{ folderName: string; translationName: string; pak: string; error: string }[]> {
	const failed: { folderName: string; translationName: string; pak: string; error: string }[] = []
	const unpakedResolved = path.resolve(unpakedRoot)
	const repakedResolved = path.resolve(repakedRoot)
	await mapPool(
		movedFiles,
		Math.min(cpuConcurrency(), Math.max(movedFiles.length, 1)),
		async (raw) => {
			abortIfCanceled(signal)
			const rel = toPosix(raw).replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
			if (rel === '' || isUnsafeRelPath(rel)) {
				failed.push({ folderName, translationName: folderName, pak: raw, error: `Unsafe moved path in DB: ${raw}` })
				return
			}
			const src = path.resolve(unpakedResolved, ...rel.split('/'))
			const dest = path.resolve(repakedResolved, ...rel.split('/'))
			if (!isSubPath(unpakedResolved, src) || !isSubPath(repakedResolved, dest)) {
				failed.push({ folderName, translationName: folderName, pak: rel, error: `Unsafe moved path in DB: ${rel}` })
				return
			}
			try {
				await fsp.access(src)
			} catch {
				failed.push({ folderName, translationName: folderName, pak: rel, error: `Moved file not found: ${rel}` })
				return
			}
			await ensureDir(path.dirname(dest))
			await fsp.copyFile(src, dest)
			onProgress?.({
				stage: 'repak',
				fileName: rel,
				message: `Copying ${rel}`,
				packageName: path.basename(rel),
			})
		},
		signal,
	)
	return failed
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
 * mirror under the same root and are recorded as `movedFiles` so RePAK copies
 * them beside the reconstructed paks. Skip is keyed by the DB manifest (`!overwrite`),
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
	const unpakedRoot = options.unpakedDir ? path.resolve(options.unpakedDir) : UNPAKED_DIR
	const pakRoot = options.pakDir ? path.resolve(options.pakDir) : PAK_DIR

	try {
		const st = await fsp.stat(inputResolved)
		if (!st.isDirectory()) throw new Error(`Input folder not found: ${inputResolved}`)
	} catch {
		throw new Error(`Input folder not found: ${inputResolved}`)
	}

	await ensureDir(unpakedRoot)

	const pakResolved = pakRoot
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

	// Walk + header peek run in a worker. The main process only receives a
	// throttled file count, so the window keeps handling input and paint.
	const scanned = await scanFolderOffThread(
		inputResolved,
		payload.includeNonPak,
		options.signal,
		(filesFound) => {
			onProgress?.({
				stage: 'extract-folder-scan',
				current: filesFound,
				total: 0,
				percent: 0,
				message: `Scanning... (${filesFound} files)`,
			})
		},
	)
	const pakFiles = scanned.pakFiles
	const otherFiles = scanned.otherFiles
	onProgress?.({
		stage: 'extract-folder-scan',
		current: scanned.filesFound,
		total: scanned.filesFound,
		percent: 0,
	})

	const rootDbPath = unpakedRootDbForFolder(inputResolved, unpakedRoot)
	const legacyRootDbPath = unpakedLegacyRootDbForFolder(inputResolved, unpakedRoot)

	const skippedExisting: string[] = []
	const failedPaks: { relPakPath: string; error: string }[] = []
	let paksExtracted = 0
	let otherFilesCopied = 0
	let extractedFiles = 0
	let extractedBytes = 0
	let otherFilesBytes = 0
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
		context: {
			packageName?: string
			packageIndex?: number
			packageTotal?: number
			globalPercent?: boolean
			bytesDelta?: number
			current?: number
			total?: number
		} = {},
	): void {
		const clamped = Math.max(0, Math.min(percent, 100))
		if (clamped > lastPercent) lastPercent = clamped
		const value = Math.round(lastPercent * 10) / 10
		const current = context.current ?? doneFiles
		const total = context.total ?? denomFiles
		onProgress?.(
			{
				stage,
				current,
				total,
				percent: value,
				fileName,
				message,
				packageName: context.packageName,
				packageIndex: context.packageIndex,
				packageTotal: context.packageTotal,
				globalPercent: context.globalPercent,
				bytesDelta: context.bytesDelta,
			},
			{ current, total },
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
	for (const pak of pakFiles) {
		abortIfCanceled(options.signal)
		const pakPath = pak.path
		const relPakPath = relToUnpaked(pakPath)
		const parentDir = posixDirname(relPakPath)
		// Nest under `<stem>/` when requested, or always for Chromium/CEF (bare
		// numeric IDs would otherwise collide across sibling packs).
		const stem = path.basename(pakPath, path.extname(pakPath))
		const nestStem = payload.createPakFolder === true || pak.kind === 'chromium'
		const destDir = nestStem
			? (parentDir === '' ? stem : `${parentDir}/${stem}`)
			: parentDir
		const destDirAbs = destDir === '' ? unpakedRoot : path.join(unpakedRoot, ...destDir.split('/'))
		// Legacy wrapper from the previous model: `<name>.pak/` folder under the unpaked root.
		const legacyRel = toPosix(path.relative(relRoot, pakPath))
		const legacyWrapper = path.join(unpakedRoot, ...legacyRel.split('/'))
		candidates.push({ pakPath, relPakPath, destDir, destDirAbs, legacyWrapper })
		if (candidates.length % 20 === 0) await pumpMain()
	}

	// Index pass: each configured thread takes the next .pak and reads its TOC.
	// The file lists feed the progress total, the aggregate DB, and extraction
	// (so the same pak is not scanned again). Overwrite questions start only
	// after every index is known, so skip-all / one-by-one do not wait on disk.
	let conflictMode: 'ask' | 'overwrite-all' | 'skip-all' = payload.overwrite ? 'overwrite-all' : 'ask'
	let conflictSeen = 0
	const jobs: PakJob[] = []
	let skippedFiles = 0
	let pakFilesTotal = 0
	const totalPaks = Math.max(candidates.length, 1)
	let checkedPaks = 0
	let wasCanceled = false
	/** TOC + XOR version from the index pass — reused by parallel extract. */
	const pakScans = new Map<string, PakScanResult>()
	const scanOutcomes = await mapPool(
		candidates,
		cpuThreadsForWork(),
		async (candidate): Promise<{ ok: true; scan: PakScanResult } | { ok: false }> => {
			abortIfCanceled(options.signal)
			try {
				const scan = await scanPakOffThread(candidate.pakPath, options.signal)
				checkedPaks += 1
				emitProgress(
					'extract-folder-check',
					(checkedPaks / totalPaks) * VERIFY_SHARE,
					'',
					`Checking ${candidate.relPakPath}`,
					{ packageName: path.basename(candidate.pakPath), packageIndex: checkedPaks, packageTotal: candidates.length },
				)
				return { ok: true, scan }
			} catch (error) {
				if (options.signal?.aborted || errorMessage(error) === 'Operation canceled') throw error
				failedPaks.push({ relPakPath: candidate.relPakPath, error: errorMessage(error) })
				checkedPaks += 1
				emitProgress(
					'extract-folder-check',
					(checkedPaks / totalPaks) * VERIFY_SHARE,
					'',
					`Skipped ${candidate.relPakPath}`,
					{ packageName: path.basename(candidate.pakPath), packageIndex: checkedPaks, packageTotal: candidates.length },
				)
				return { ok: false }
			}
		},
		options.signal,
	)
	let conflictTotal = 0
	if (!payload.overwrite) {
		for (let i = 0; i < candidates.length; i += 1) {
			const outcome = scanOutcomes[i]
			const candidate = candidates[i]
			if (!outcome?.ok || !candidate) continue
			if (byRelPakPath.has(candidate.relPakPath)) conflictTotal += 1
		}
	}
	if (!wasCanceled && conflictMode === 'ask' && conflictTotal > 1 && options.onConflict) {
		emitProgress('extract-folder-conflicts', VERIFY_SHARE, '', '', {
			current: conflictTotal,
			total: conflictTotal,
		})
		const choice = await options.onConflict({
			packageName: '',
			relPakPath: '',
			fileCount: conflictTotal,
			conflictIndex: 0,
			conflictTotal,
			summary: true,
		})
		if (choice === 'cancel') wasCanceled = true
		else if (choice === 'skip-all' || choice === 'skip') conflictMode = 'skip-all'
		else if (choice === 'overwrite-all' || choice === 'overwrite') conflictMode = 'overwrite-all'
	}
	for (let i = 0; i < candidates.length && !wasCanceled; i += 1) {
		abortIfCanceled(options.signal)
		const candidate = candidates[i] as PakJob
		const outcome = scanOutcomes[i]
		if (!outcome || !outcome.ok) continue
		pakScans.set(candidate.pakPath, outcome.scan)
		const files = outcome.scan.files
		const isConflict = !payload.overwrite && byRelPakPath.has(candidate.relPakPath)
		let accept = true
		if (isConflict && conflictMode === 'ask') {
			conflictSeen += 1
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
		if (accept) {
			await ensureDir(candidate.destDirAbs)
			jobs.push(candidate)
		} else {
			skippedExisting.push(candidate.relPakPath)
			skippedFiles += files.length
		}
		pakFilesTotal += files.length
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
			unpakPool = new Piscina({
				filename: resolveUnpakWorkerFile(),
				maxThreads: cpuThreadsForWork(),
				resourceLimits: workerResourceLimits(),
			})
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
					if (typeof payload.bytesDelta === 'number' && payload.bytesDelta > 0) {
						extractedBytes += payload.bytesDelta
					}
					doneFiles = skippedFiles + (payload.current ?? 0)
					emitProgress('unpack', extractionPercent(doneFiles), payload.fileName ?? '', '', {
						packageName: payload.packageName,
						packageIndex: payload.packageIndex,
						packageTotal: payload.packageTotal,
						globalPercent: true,
						bytesDelta: payload.bytesDelta,
						current: doneFiles,
						total: denomFiles,
					})
				},
				options.signal,
				pakScans,
			)
			const byPak = new Map(jobs.map((j) => [j.pakPath, j]))
			for (const outcome of outcomes) {
				const job = byPak.get(outcome.job.pakPath)
				if (!outcome.ok) {
					failedPaks.push({
						relPakPath: job?.relPakPath ?? outcome.job.packageName,
						error: outcome.error ?? 'unknown error',
					})
					continue
				}
				if (!job) continue
				const files = outcome.files.slice().sort()
				extractedFiles += files.length
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
		emitProgress('extract-folder', extractionPercent(doneFiles), path.basename(rootDbPath), `Indexing ${path.basename(rootDbPath)}`)
		const manifest: PakDbManifest = {
			version: 4,
			folderName: path.basename(inputResolved),
			inputFolder: inputResolved,
			createdAt: new Date().toISOString(),
			files: [],
			paks: mergedPaks,
			movedFiles: otherFiles.map((filePath) => relToUnpaked(filePath)),
		}
		await writePakDatabaseOffThread(rootDbPath, manifest)
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
			? unpakedRoot
			: path.join(unpakedRoot, ...relRootToInput.split(/[\\/]/))
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
			const destPath = path.join(unpakedRoot, ...relPath.split('/'))
			if (!payload.overwrite && (await existsAsync(destPath))) {
				skippedExisting.push(relPath)
				doneFiles += 1
				emitProgress('extract-folder', extractionPercent(doneFiles), relPath, `Skipped (exists) ${relPath}`, {
					packageName: path.basename(filePath),
					current: doneFiles,
					total: denomFiles,
				})
				return
			}
			let bytesDelta = 0
			try {
				bytesDelta = (await fsp.stat(filePath)).size
			} catch {
				bytesDelta = 0
			}
			await ensureDir(path.dirname(destPath))
			await fsp.copyFile(filePath, destPath)
			otherFilesCopied += 1
			if (bytesDelta > 0) otherFilesBytes += bytesDelta
			doneFiles += 1
			emitProgress('extract-folder', extractionPercent(doneFiles), relPath, `Copying ${relPath}`, {
				packageName: path.basename(filePath),
				bytesDelta: bytesDelta > 0 ? bytesDelta : undefined,
				current: doneFiles,
				total: denomFiles,
			})
		},
		options.signal,
	)

	// Boundary: `extract-folder-done` is flushed immediately by the progress sender.
	onProgress?.({ stage: 'extract-folder-done', percent: 100 })

	return {
		outputFolder: unpakedRoot,
		paksExtracted,
		otherFilesCopied,
		extractedFiles,
		extractedBytes,
		otherFilesBytes,
		dbPaths,
		skippedExisting,
		failedPaks,
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

/** `<unpakedRoot>/<rel>` (or `<rel>.pak`) -> `<repakedRoot>/<rel>[.pak]` without duplicating `.pak`. */
function simpleRepakOutput(
	selectionAbs: string,
	unpakedRoot: string = UNPAKED_DIR,
	repakedRoot: string = REPAKED_DIR,
): string {
	const unpakedResolved = path.resolve(unpakedRoot)
	const rel = isSubPath(unpakedResolved, selectionAbs)
		? toPosix(path.relative(unpakedResolved, selectionAbs))
		: path.basename(selectionAbs)
	const parts = rel.split('/')
	const last = parts[parts.length - 1] ?? ''
	const normalizedLast = last.toLowerCase().endsWith('.pak') ? last : `${last}.pak`
	return path.join(repakedRoot, ...[...parts.slice(0, -1), normalizedLast])
}

async function repackSimpleFolder(
	selectionAbs: string,
	folderName: string,
	folderIndex: number,
	totalSelections: number,
	onProgress: ProgressCallback | undefined,
	signal: AbortSignal | undefined,
	repakPool: Piscina<RepakTaskInput, RepakTaskResult>,
	unpakedRoot: string = UNPAKED_DIR,
	repakedRoot: string = REPAKED_DIR,
): Promise<{ ok: boolean; entry?: unknown; failure?: unknown; doneStage: boolean }> {
	const pakOutPath = simpleRepakOutput(selectionAbs, unpakedRoot, repakedRoot)
	await ensureDir(path.dirname(pakOutPath))
	const packageName = path.basename(pakOutPath)

	onProgress?.({
		stage: 'repak-start',
		packageName,
		packageIndex: 1,
		packageTotal: 1,
		percent: 0,
	})

	try {
		if (!repakPool) throw new Error('RePAK worker pool unavailable')
		await runRepakPoolWithProgress(
			repakPool,
			{
				inputFolder: selectionAbs,
				outputPak: pakOutPath,
				version: 0,
				concurrency: innerConcurrency(totalSelections),
				rejectEmpty: true,
			},
			onProgress,
			signal,
			{ packageName, packageIndex: 1, packageTotal: 1 },
		)

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
		const message = errorMessage(error)
		if (/No files to repack/i.test(message)) {
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
		return { ok: false, failure: { folderName, translationName: folderName, error: message }, doneStage: false }
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

	const unpakedRoot = options.unpakedDir ? path.resolve(options.unpakedDir) : UNPAKED_DIR
	const repakedRoot = options.repakedDir ? path.resolve(options.repakedDir) : REPAKED_DIR
	await ensureDir(repakedRoot)

	// Global percent across every PAK reconstructed by every selection. Coarse
	// (advances per completed PAK) but spans the whole action, so the bar never
	// resets between selections.
	let totalPaks = 0
	for (const sel of selectedTranslationPaths) {
		const abs = path.resolve(sel)
		try {
			const entries = await readAggregatedPakEntries(abs, unpakedRoot)
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
			repakPool = new Piscina({
				filename: resolveRepakWorkerFile(),
				maxThreads: cpuThreadsForWork(),
				resourceLimits: workerResourceLimits(),
			})
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
				const aggregate = await readAggregateDb(selectionAbs, unpakedRoot)
				const aggregatedEntries = aggregate ? aggregate.paks : null
				const hasAggregateDb = aggregatedEntries !== null && aggregatedEntries.length > 0
				const pakDirs = hasAggregateDb ? [] : await collectPakDirs(selectionAbs, options.signal)

				if (!hasAggregateDb && pakDirs.length === 0) {
					const r = await repackSimpleFolder(selectionAbs, folderName, folderIndex, totalSelections, wrapRepakProgress(), options.signal, repakPool!, unpakedRoot, repakedRoot)
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

						const pakOutPath = path.join(repakedRoot, ...relPakPath.split('/'))
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
							// Pack straight from the extract tree. The worker reads the DB
							// file list; nothing is copied on the main process.
							if (!repakPool) throw new Error('RePAK worker pool unavailable')
							for (const relFile of entry.files) {
								if (relFile !== '' && isUnsafeRelPath(relFile)) {
									throw new Error(`Unsafe path in DB: ${relFile}`)
								}
							}
							await runRepakPoolWithProgress(
								repakPool!,
								{
									op: 'pack-list',
									srcRoot,
									files: entry.files,
									outputPak: pakOutPath,
									version: 0,
									concurrency: innerConcurrency(totalSelections),
								},
								wrapRepakProgress(),
								options.signal,
								{ packageName, packageIndex: j + 1, packageTotal },
							)
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
					if (aggregate && aggregate.movedFiles.length > 0) {
						const copyFailures = await copyMovedFilesToRepak(
							aggregate.movedFiles,
							unpakedRoot,
							repakedRoot,
							folderName,
							wrapRepakProgress(),
							options.signal,
						)
						for (const failure of copyFailures) localFailed.push(failure)
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
							: toPosix(path.relative(path.resolve(unpakedRoot), pakDir))

						if (!metaFiles) {
							localFailed.push({
								folderName,
								translationName: folderName,
								pak: pakBase,
								error: `DB not found for '${pakBase}'. Expected aggregate '${unpakedRootDbForFolder(selectionAbs, unpakedRoot)}' or legacy sibling '${unpakedLegacyRootDbForFolder(selectionAbs, unpakedRoot)}'.`,
							})
							continue
						}

						const relPakPath = metaRelPakPath
						const pakOutPath = path.join(repakedRoot, ...relPakPath.split('/'))
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
							for (const relFile of metaFiles) {
								if (relFile !== '' && isUnsafeRelPath(relFile)) {
									throw new Error(`Unsafe path in DB: ${relFile}`)
								}
							}

							// 100% assíncrono: exclusivamente em workers Piscina; sem fallback no main.
							if (!repakPool) throw new Error('RePAK worker pool unavailable')
							await runRepakPoolWithProgress(
								repakPool!,
								{
									op: 'pack-list',
									srcRoot: pakDir,
									files: metaFiles,
									outputPak: pakOutPath,
									version: 0,
									concurrency: innerConcurrency(totalSelections),
								},
								wrapRepakProgress(),
								options.signal,
								{ packageName, packageIndex: j + 1, packageTotal: pakDirs.length },
							)
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

function normalizeDbRel(value: string): string {
	return toPosix(value).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Reconstruct only the DB manifest files the user selected from one extracted
 * folder. Each pak is written under the RePAK root at its original `relPakPath`
 * (parent folders included). Source files stay in place.
 */
export async function repackUnpakedSelection(
	folderPath: string,
	entries: string[],
	options: TranslationServiceOptions = {},
): Promise<TranslationResults> {
	const onProgress = options.onProgress
	const signal = options.signal
	const results: TranslationResults = { success: [], failed: [] }
	if (!folderPath) throw new Error('No folder provided')
	if (entries.length === 0) throw new Error('No files selected')

	const selectionAbs = path.resolve(folderPath)
	const unpakedRoot = options.unpakedDir ? path.resolve(options.unpakedDir) : UNPAKED_DIR
	const repakedRoot = options.repakedDir ? path.resolve(options.repakedDir) : REPAKED_DIR
	if (selectionAbs !== unpakedRoot && !isSubPath(unpakedRoot, selectionAbs)) {
		throw new Error('Access denied: folder outside unpaked directory')
	}

	let isDir = false
	try {
		const st = await fsp.stat(selectionAbs)
		isDir = st.isDirectory()
	} catch {
		isDir = false
	}
	if (!isDir) throw new Error(`Folder not found: ${selectionAbs}`)

	const aggregated = await readAggregatedPakEntries(selectionAbs, unpakedRoot)
	if (!aggregated || aggregated.length === 0) {
		throw new Error('Aggregate pak database not found for this folder')
	}

	const index = new Map<string, { entry: AggregatedPakEntry; relFile: string }>()
	const byLength = [...aggregated].sort(
		(a, b) => normalizeDbRel(b.relPakPath).length - normalizeDbRel(a.relPakPath).length,
	)
	for (const entry of byLength) {
		const relPak = normalizeDbRel(entry.relPakPath)
		if (relPak === '' || isUnsafeRelPath(relPak)) continue
		for (const file of entry.files) {
			const relFile = normalizeDbRel(file)
			if (relFile === '' || isUnsafeRelPath(relFile)) continue
			const key = `${relPak}/${relFile}`
			if (!index.has(key)) index.set(key, { entry, relFile })
		}
	}

	const groups = new Map<string, { entry: AggregatedPakEntry; files: string[] }>()
	for (const raw of entries) {
		const hit = index.get(normalizeDbRel(raw))
		if (!hit) continue
		const id = normalizeDbRel(hit.entry.relPakPath)
		let group = groups.get(id)
		if (!group) {
			group = { entry: hit.entry, files: [] }
			groups.set(id, group)
		}
		if (!group.files.includes(hit.relFile)) group.files.push(hit.relFile)
	}
	if (groups.size === 0) {
		throw new Error('No selected files match the pak database')
	}

	await ensureDir(repakedRoot)
	const ordered = [...groups.values()].sort((a, b) =>
		normalizeDbRel(a.entry.relPakPath).localeCompare(normalizeDbRel(b.entry.relPakPath)),
	)
	const packageTotal = ordered.length
	const folderName = path.basename(selectionAbs)
	const rootDir = path.dirname(selectionAbs)
	const repakedResolved = path.resolve(repakedRoot)

	let repakPool: Piscina<RepakTaskInput, RepakTaskResult> | null = null
	try {
		try {
			repakPool = new Piscina({
				filename: resolveRepakWorkerFile(),
				maxThreads: cpuThreadsForWork(),
				resourceLimits: workerResourceLimits(),
			})
		} catch (error) {
			throw new Error(`RePAK worker pool unavailable: ${errorMessage(error)}`)
		}

		for (let j = 0; j < ordered.length; j += 1) {
			abortIfCanceled(signal)
			const group = ordered[j] as { entry: AggregatedPakEntry; files: string[] }
			const entry = group.entry
			const relPakPath = normalizeDbRel(entry.relPakPath)
			if (isUnsafeRelPath(relPakPath)) {
				results.failed.push({ folderName, pak: relPakPath, error: `Unsafe path in DB: ${relPakPath}` })
				continue
			}

			let srcRoot: string
			if (typeof entry.destDir === 'string') {
				const destDir = normalizeDbRel(entry.destDir)
				if (isUnsafeRelPath(destDir)) {
					results.failed.push({ folderName, pak: relPakPath, error: `Unsafe destDir in DB: ${entry.destDir}` })
					continue
				}
				srcRoot = destDir === '' ? rootDir : path.join(rootDir, ...destDir.split('/'))
			} else if (typeof entry.outputFolder === 'string' && entry.outputFolder !== '') {
				if (!(await existsAsync(entry.outputFolder))) {
					results.failed.push({ folderName, pak: relPakPath, error: `Source folder missing for '${relPakPath}'` })
					continue
				}
				srcRoot = entry.outputFolder
			} else {
				results.failed.push({
					folderName,
					pak: relPakPath,
					error: `No source location (destDir/outputFolder) in DB for '${relPakPath}'`,
				})
				continue
			}

			const pakOutPath = path.resolve(repakedResolved, ...relPakPath.split('/'))
			if (!isSubPath(repakedResolved, pakOutPath)) {
				results.failed.push({ folderName, pak: relPakPath, error: `Unsafe output path: ${relPakPath}` })
				continue
			}
			await ensureDir(path.dirname(pakOutPath))
			const packageName = path.basename(relPakPath)
			onProgress?.({
				stage: 'repak-start',
				packageName,
				packageIndex: j + 1,
				packageTotal,
				percent: 0,
			})

			try {
				for (const relFile of group.files) {
					if (relFile !== '' && isUnsafeRelPath(relFile)) throw new Error(`Unsafe path in DB: ${relFile}`)
				}
				await runRepakPoolWithProgress(
					repakPool,
					{
						op: 'pack-list',
						srcRoot,
						files: group.files,
						outputPak: pakOutPath,
						version: 0,
						concurrency: innerConcurrency(1),
					},
					onProgress,
					signal,
					{ packageName, packageIndex: j + 1, packageTotal },
				)
				onProgress?.({
					stage: 'repak-done',
					packageName,
					packageIndex: j + 1,
					packageTotal,
					percent: 100,
					output: pakOutPath,
				})
				results.success.push({ folderName, translationName: folderName, pak: relPakPath, outputPak: pakOutPath, fileCount: group.files.length })
			} catch (error) {
				if (signal?.aborted || errorMessage(error) === 'Operation canceled') throw error
				results.failed.push({ folderName, pak: relPakPath, error: errorMessage(error) })
			}
		}

		onProgress?.({
			stage: 'unpaked-repak-done',
			translationName: folderName,
			packageIndex: 1,
			packageTotal: 1,
			percent: 100,
		})
	} finally {
		if (repakPool) await repakPool.destroy()
	}

	return results
}
