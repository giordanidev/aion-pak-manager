import { promises as fsp } from 'fs'
import path from 'path'
import { Piscina } from 'piscina'
import { decryptFolderParallel, createDecryptPool, resolveUnpakWorkerFile, resolveRepakWorkerFile } from './decrypt-pool'
import type { DecryptFolderOptions } from './decrypt-pool'
import { errorMessage, type ProgressCallback } from './progress'
import { runUnpakWithProgress } from './unpak-pool'
import { countFilesInPak } from '../core/unpak'
import { addEntriesToPak, removeEntriesFromPak, type PakAddEntry } from '../core/repak'
import { PAK_DIR, REPAKED_DIR, UNPAKED_DIR, pakRelPathFromFiles, unpakedFolderForPak, unpakedSingleFolderForPak } from './paths'
import { mapPool } from './parallel'
import { cpuThreadsForWork, innerConcurrency } from './threads'
import { extractPaksParallel, type UnpakJob } from './unpak-parallel'
import type { UnpakTaskInput, UnpakTaskResult } from '../workers/unpak-task'
import type { RepakTaskInput, RepakTaskResult } from '../workers/repak-task'

export interface PakPackageSuccess {
	packageName: string;
	packagePath: string;
	outputFolder: string;
}

export interface PakRepackSuccess {
	packageName: string;
	packagePath: string;
	outputPak: string;
}

export interface PakFailure {
	packageName: string;
	packagePath: string;
	error: string;
}

export interface PakServiceResult {
	success: unknown[];
	failed: unknown[];
}

export interface PakServiceOptions {
	onProgress?: ProgressCallback;
	signal?: AbortSignal;
	/** Extraction output root (custom "unpaked" folder); defaults to /PAKS/unpaked. */
	unpakedDir?: string;
	/** RePAK output root (custom "repaked" folder); defaults to /PAKS/repaked. */
	repakedDir?: string;
	/** Source PAK root (custom "pak" folder); defaults to /PAKS/pak. */
	pakDir?: string;
}

function abortIfCanceled(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error('Operation canceled')
	}
}

function decryptFailuresSample(failed: { path: string; error: string }[]): string {
	const samples = failed
		.slice(0, 3)
		.map((f) => `${f.path}: ${String(f.error).slice(0, 160)}`)
	return samples.length > 0 ? ` (${samples.join('; ')})` : ''
}

/** Individual UnPAK output: `<unpakedRoot>/<name-without-.pak>` (mirrors subpaths). */
function packageOutputFolder(
	packagePath: string,
	unpakedRoot: string = UNPAKED_DIR,
	pakRoot: string = PAK_DIR,
): string {
	return unpakedSingleFolderForPak(packagePath, unpakedRoot, pakRoot)
}

/** Folder-extract output (keeps `.pak` name + DB): used by repack/decrypt lookups. */
export function packageFolderExtractPath(
	packagePath: string,
	unpakedRoot: string = UNPAKED_DIR,
	pakRoot: string = PAK_DIR,
): string {
	return unpakedFolderForPak(packagePath, unpakedRoot, pakRoot)
}

async function existsAsync(target: string): Promise<boolean> {
	try {
		await fsp.access(target)
		return true
	} catch {
		return false
	}
}

async function isDirectoryAsync(target: string): Promise<boolean> {
	try {
		const st = await fsp.stat(target)
		return st.isDirectory()
	} catch {
		return false
	}
}

async function ensureDirAsync(target: string): Promise<void> {
	await fsp.mkdir(target, { recursive: true })
}

async function readDbRelPakPath(dbPath: string): Promise<string | null> {
	try {
		if (!(await existsAsync(dbPath))) return null
		const raw = JSON.parse(await fsp.readFile(dbPath, 'utf8')) as Record<string, unknown>
		if (typeof raw['relPakPath'] === 'string' && (raw['relPakPath'] as string).length > 0) {
			return (raw['relPakPath'] as string).split(path.sep).join('/')
		}
		return null
	} catch {
		return null
	}
}

/** Mirror `PAKS/pak/.../name.pak` (or the DB `relPakPath`) under the repaked root. Never duplicates `.pak.pak`. */
async function repakOutputForPackage(
	packagePath: string,
	folderPath: string,
	repakedRoot: string = REPAKED_DIR,
	pakRoot: string = PAK_DIR,
): Promise<string> {
	const fromDb = await readDbRelPakPath(`${path.resolve(folderPath)}.db`)
	const rel = fromDb ?? pakRelPathFromFiles(packagePath, pakRoot)
	const relParts = rel.split('/')
	const last = relParts[relParts.length - 1] ?? ''
	const normalizedLast = last.toLowerCase().endsWith('.pak') ? last : `${last}.pak`
	const normalized = [...relParts.slice(0, -1), normalizedLast].join('/')
	return path.join(repakedRoot, ...normalized.split('/'))
}

function isSubPath(parent: string, child: string): boolean {
	const rel = path.relative(parent, child)
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function ensureInsidePakDir(pkg: string, pakRoot: string = PAK_DIR): void {
	const resolved = path.resolve(pkg)
	const root = path.resolve(pakRoot)
	if (!isSubPath(root, resolved) && root !== resolved) {
		throw new Error(`Refusing to extract outside the source PAK folder: ${pkg}`)
	}
}

function createUnpakPool(): Piscina<UnpakTaskInput, UnpakTaskResult> {
	return new Piscina({ filename: resolveUnpakWorkerFile(), maxThreads: cpuThreadsForWork() })
}

function createRepakPool(): Piscina<RepakTaskInput, RepakTaskResult> {
	return new Piscina({ filename: resolveRepakWorkerFile(), maxThreads: cpuThreadsForWork() })
}

interface UnpackOneResult {
	ok: boolean;
	entry?: PakPackageSuccess;
	failure?: PakFailure;
}

async function runUnpakPoolWithProgress(
	pool: Piscina<UnpakTaskInput, UnpakTaskResult>,
	input: Omit<UnpakTaskInput, 'port'>,
	fileTotal: number,
	onProgress: ProgressCallback | undefined,
	signal: AbortSignal | undefined,
	packageCtx: { packageName: string; packageIndex: number; packageTotal: number },
): Promise<void> {
	await runUnpakWithProgress(pool, input, fileTotal, signal, (progress) => {
		// The pre-counted total is authoritative; recompute percent against it.
		// The progress sender batches/throttles the per-file events.
		const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 1000) / 10 : 100
		onProgress?.(
			{
				stage: 'unpack',
				packageName: packageCtx.packageName,
				packageIndex: packageCtx.packageIndex,
				packageTotal: packageCtx.packageTotal,
				current: progress.current,
				total: progress.total,
				percent,
				bytesDelta: progress.bytesDelta,
				fileName: progress.fileName,
				outputFolder: progress.outputFolder,
			},
			{ current: progress.current, total: progress.total },
		)
	})
}

async function unpackOne(
	pkg: string,
	packageIndex: number,
	packageTotal: number,
	onProgress: ProgressCallback | undefined,
	signal: AbortSignal | undefined,
	useWorker: Piscina<UnpakTaskInput, UnpakTaskResult>,
	entries?: string[],
	unpakedRoot: string = UNPAKED_DIR,
	pakRoot: string = PAK_DIR,
): Promise<UnpackOneResult> {
	const packageName = path.basename(pkg)
	const outputFolder = packageOutputFolder(pkg, unpakedRoot, pakRoot)
	const selectedEntries = entries && entries.length > 0 ? entries : undefined
	try {
		ensureInsidePakDir(pkg, pakRoot)
		await ensureDirAsync(outputFolder)
		// Pre-count file entries (yields to the event loop) so per-file
		// progress has a stable total before the worker starts. Selective
		// extract uses the selected entries count as the total.
		const fileTotal = selectedEntries
			? selectedEntries.length
			: await countFilesInPak(pkg, () => signal?.aborted ?? false)
		onProgress?.({ stage: 'unpack-start', packageName, packageIndex, packageTotal, file: pkg, total: fileTotal })
		// 100% assíncrono: exclusivamente em workers Piscina; sem fallback síncrono no main.
		await runUnpakPoolWithProgress(
			useWorker,
			{ inputPath: pkg, outputFolder, entries: selectedEntries },
			fileTotal,
			onProgress,
			signal,
			{ packageName, packageIndex, packageTotal },
		)
		// Individual UnPAK: no DB written.
		onProgress?.({ stage: 'unpack-done', packageName, packageIndex, packageTotal, file: outputFolder })
		return { ok: true, entry: { packageName, packagePath: pkg, outputFolder } }
	} catch (error) {
		return { ok: false, failure: { packageName, packagePath: pkg, error: errorMessage(error) } }
	}
}

export async function unpackPackages(
	packagePaths: string[],
	options: PakServiceOptions = {},
): Promise<PakServiceResult> {
	const onProgress = options.onProgress
	const results: PakServiceResult = { success: [], failed: [] }
	const totalPackages = packagePaths.length
	if (totalPackages === 0) return results

	const unpakedRoot = options.unpakedDir ? path.resolve(options.unpakedDir) : UNPAKED_DIR
	const pakRoot = options.pakDir ? path.resolve(options.pakDir) : PAK_DIR

	const threads = cpuThreadsForWork()
	let pool: Piscina<UnpakTaskInput, UnpakTaskResult> | null = null
	try {
		try {
			pool = createUnpakPool()
		} catch (error) {
			// 100% assíncrono: sem fallback síncrono no main. Falha estruturada por pacote.
			const msg = `UnPAK worker pool unavailable: ${errorMessage(error)}`
			for (const pkg of packagePaths) {
				results.failed.push({ packageName: path.basename(pkg), packagePath: pkg, error: msg } as PakFailure)
			}
			return results
		}

		// Validate + prepare output folders, then extract all PAKs on a shared
		// pool: each PAK is split into entry chunks so a single PAK uses several
		// worker threads (not just one).
		const jobs: UnpakJob[] = []
		for (let i = 0; i < packagePaths.length; i += 1) {
			const pkg = packagePaths[i] as string
			const packageName = path.basename(pkg)
			try {
				ensureInsidePakDir(pkg, pakRoot)
				const outputFolder = packageOutputFolder(pkg, unpakedRoot, pakRoot)
				await ensureDirAsync(outputFolder)
				jobs.push({ pakPath: pkg, outputFolder, packageName, packageIndex: i + 1, packageTotal: totalPackages })
			} catch (error) {
				results.failed.push({ packageName, packagePath: pkg, error: errorMessage(error) } as PakFailure)
			}
		}

		const outcomes = await extractPaksParallel(jobs, pool, threads, onProgress, options.signal)
		for (const o of outcomes) {
			if (o.ok) {
				onProgress?.({
					stage: 'unpack-done',
					packageName: o.job.packageName,
					packageIndex: o.job.packageIndex,
					packageTotal: o.job.packageTotal,
					file: o.job.outputFolder,
				})
				results.success.push({
					packageName: o.job.packageName,
					packagePath: o.job.pakPath,
					outputFolder: o.job.outputFolder,
				} as PakPackageSuccess)
			} else {
				results.failed.push({
					packageName: o.job.packageName,
					packagePath: o.job.pakPath,
					error: o.error ?? 'Unknown error',
				} as PakFailure)
			}
		}
	} finally {
		if (pool) await pool.destroy()
	}

	return results
}

export async function unpackAndDecryptPackages(
	packagePaths: string[],
	options: PakServiceOptions = {},
): Promise<PakServiceResult> {
	const onProgress = options.onProgress
	const results: PakServiceResult = { success: [], failed: [] }
	const totalPackages = packagePaths.length
	if (totalPackages === 0) return results

	const unpakedRoot = options.unpakedDir ? path.resolve(options.unpakedDir) : UNPAKED_DIR
	const pakRoot = options.pakDir ? path.resolve(options.pakDir) : PAK_DIR

	const concurrency = cpuThreadsForWork()
	let unpakPool: Piscina<UnpakTaskInput, UnpakTaskResult> | null = null
	try {
		try {
			unpakPool = createUnpakPool()
		} catch (error) {
			// 100% assíncrono: sem fallback síncrono no main. Falha estruturada por pacote.
			const msg = `UnPAK worker pool unavailable: ${errorMessage(error)}`
			for (const pkg of packagePaths) {
				results.failed.push({ packageName: path.basename(pkg), packagePath: pkg, error: msg } as PakFailure)
			}
			return results
		}
		const decryptPool = createDecryptPool()
		try {
			const outcomes = await mapPool(
				packagePaths,
				Math.min(concurrency, totalPackages),
				async (pkg, i) => {
					const packageIndex = i + 1
					const packageName = path.basename(pkg)
					const unpacked = await unpackOne(pkg, packageIndex, totalPackages, onProgress, options.signal, unpakPool!, undefined, unpakedRoot, pakRoot)
					if (!unpacked.ok || !unpacked.entry) {
						return { ok: false as const, failure: unpacked.failure! }
					}
					const outputFolder = unpacked.entry.outputFolder
					try {
						onProgress?.({ stage: 'decrypt-start', packageName, packageIndex, packageTotal: totalPackages, file: outputFolder })
						const decryptOptions: DecryptFolderOptions = {
							onProgress,
							signal: options.signal,
							packageName,
							packageIndex,
							packageTotal: totalPackages,
							pool: decryptPool,
						}
						const decryptResults = await decryptFolderParallel(outputFolder, decryptOptions)
						// Individual UnPAK: no DB refresh.
						if (decryptResults.failed.length > 0) {
							return {
								ok: false as const,
								failure: {
									packageName,
									packagePath: pkg,
									error: `Decrypted with ${decryptResults.failed.length} failures${decryptFailuresSample(decryptResults.failed)}`,
								} as PakFailure,
							}
						}
						onProgress?.({ stage: 'decrypt-done', packageName, packageIndex, packageTotal: totalPackages, file: outputFolder })
						return { ok: true as const, entry: unpacked.entry }
					} catch (error) {
						return { ok: false as const, failure: { packageName, packagePath: pkg, error: errorMessage(error) } as PakFailure }
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
	} finally {
		if (unpakPool) await unpakPool.destroy()
	}

	return results
}

async function unpackPakEntriesInternal(
	pakPath: string,
	entries: string[],
	decrypt: boolean,
	options: PakServiceOptions,
): Promise<PakServiceResult> {
	const onProgress = options.onProgress
	const results: PakServiceResult = { success: [], failed: [] }
	const unpakedRoot = options.unpakedDir ? path.resolve(options.unpakedDir) : UNPAKED_DIR
	const pakRoot = options.pakDir ? path.resolve(options.pakDir) : PAK_DIR
	const packageName = path.basename(pakPath)
	const normalizedEntries = Array.from(
		new Set(entries.map((entry) => entry.replace(/\\/g, '/')).filter((entry) => entry.length > 0)),
	)
	if (normalizedEntries.length === 0) {
		results.failed.push({ packageName, packagePath: pakPath, error: 'No entries selected' } as PakFailure)
		return results
	}

	let unpakPool: Piscina<UnpakTaskInput, UnpakTaskResult> | null = null
	let decryptPool: ReturnType<typeof createDecryptPool> | null = null
	try {
		try {
			unpakPool = createUnpakPool()
		} catch (error) {
			results.failed.push({
				packageName,
				packagePath: pakPath,
				error: `UnPAK worker pool unavailable: ${errorMessage(error)}`,
			} as PakFailure)
			return results
		}
		if (decrypt) {
			decryptPool = createDecryptPool()
		}

		const unpacked = await unpackOne(pakPath, 1, 1, onProgress, options.signal, unpakPool, normalizedEntries, unpakedRoot, pakRoot)
		if (!unpacked.ok || !unpacked.entry) {
			results.failed.push(unpacked.failure!)
			return results
		}
		if (!decrypt) {
			results.success.push(unpacked.entry)
			return results
		}

		const outputFolder = unpacked.entry.outputFolder
		try {
			onProgress?.({ stage: 'decrypt-start', packageName, packageIndex: 1, packageTotal: 1, file: outputFolder })
			const decryptOptions: DecryptFolderOptions = {
				onProgress,
				signal: options.signal,
				packageName,
				packageIndex: 1,
				packageTotal: 1,
				pool: decryptPool ?? undefined,
			}
			const decryptResults = await decryptFolderParallel(outputFolder, decryptOptions)
			if (decryptResults.failed.length > 0) {
				results.failed.push({
					packageName,
					packagePath: pakPath,
					error: `Decrypted with ${decryptResults.failed.length} failures${decryptFailuresSample(decryptResults.failed)}`,
				} as PakFailure)
				return results
			}
			onProgress?.({ stage: 'decrypt-done', packageName, packageIndex: 1, packageTotal: 1, file: outputFolder })
			results.success.push(unpacked.entry)
		} catch (error) {
			results.failed.push({ packageName, packagePath: pakPath, error: errorMessage(error) } as PakFailure)
		}
	} finally {
		if (decryptPool) await decryptPool.destroy()
		if (unpakPool) await unpakPool.destroy()
	}

	return results
}

/** Extract only the selected entries of a single PAK (individual UnPAK output folder). */
export async function unpackPakEntries(
	pakPath: string,
	entries: string[],
	options: PakServiceOptions = {},
): Promise<PakServiceResult> {
	return unpackPakEntriesInternal(pakPath, entries, false, options)
}

/** Extract only the selected entries of a single PAK, then decrypt the output folder. */
export async function unpackAndDecryptPakEntries(
	pakPath: string,
	entries: string[],
	options: PakServiceOptions = {},
): Promise<PakServiceResult> {
	return unpackPakEntriesInternal(pakPath, entries, true, options)
}

async function resolveDecryptFolder(
	packagePath: string,
	unpakedRoot: string = UNPAKED_DIR,
	pakRoot: string = PAK_DIR,
): Promise<string | null> {
	const outputFolder = packageOutputFolder(packagePath, unpakedRoot, pakRoot)
	if (await isDirectoryAsync(outputFolder)) return outputFolder
	const legacy = packageFolderExtractPath(packagePath, unpakedRoot, pakRoot)
	if (await isDirectoryAsync(legacy)) return legacy
	return null
}

async function resolveRepackFolder(
	packagePath: string,
	unpakedRoot: string = UNPAKED_DIR,
	pakRoot: string = PAK_DIR,
): Promise<string | null> {
	const folderPath = packageOutputFolder(packagePath, unpakedRoot, pakRoot)
	if (await isDirectoryAsync(folderPath)) return folderPath
	const legacy = packageFolderExtractPath(packagePath, unpakedRoot, pakRoot)
	if (await isDirectoryAsync(legacy)) return legacy
	return null
}

export async function decryptPackages(
	packagePaths: string[],
	options: PakServiceOptions = {},
): Promise<PakServiceResult> {
	const onProgress = options.onProgress
	const results: PakServiceResult = { success: [], failed: [] }
	const totalPackages = packagePaths.length
	if (totalPackages === 0) return results

	const unpakedRoot = options.unpakedDir ? path.resolve(options.unpakedDir) : UNPAKED_DIR
	const pakRoot = options.pakDir ? path.resolve(options.pakDir) : PAK_DIR

	const decryptPool = createDecryptPool()
	try {
		const outcomes = await mapPool(
			packagePaths,
			Math.min(cpuThreadsForWork(), totalPackages),
			async (pkg, i) => {
				abortIfCanceled(options.signal)
				const packageName = path.basename(pkg)
				const packageIndex = i + 1
				// Prefer individual output; fall back to folder-extract path.
				const outputFolder = await resolveDecryptFolder(pkg, unpakedRoot, pakRoot)
				if (!outputFolder) {
					const fallback = packageOutputFolder(pkg, unpakedRoot, pakRoot)
					return {
						ok: false as const,
						failure: { packageName, packagePath: pkg, error: `Extracted folder not found: ${fallback}` } as PakFailure,
					}
				}
				onProgress?.({ stage: 'decrypt-start', packageName, packageIndex, packageTotal: totalPackages, file: outputFolder })
				try {
					const decryptOptions: DecryptFolderOptions = {
						onProgress,
						signal: options.signal,
						packageName,
						packageIndex,
						packageTotal: totalPackages,
						pool: decryptPool,
					}
					const decryptResults = await decryptFolderParallel(outputFolder, decryptOptions)
					if (decryptResults.failed.length > 0) {
						return {
							ok: false as const,
							failure: {
								packageName,
								packagePath: pkg,
								error: `Decrypted with ${decryptResults.failed.length} failures${decryptFailuresSample(decryptResults.failed)}`,
							} as PakFailure,
						}
					}
					onProgress?.({ stage: 'decrypt-done', packageName, packageIndex, packageTotal: totalPackages, file: outputFolder })
					return { ok: true as const, entry: { packageName, packagePath: pkg, outputFolder } as PakPackageSuccess }
				} catch (error) {
					return { ok: false as const, failure: { packageName, packagePath: pkg, error: errorMessage(error) } as PakFailure }
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

export async function repackPackages(
	packagePaths: string[],
	options: PakServiceOptions = {},
): Promise<PakServiceResult> {
	const onProgress = options.onProgress
	const results: PakServiceResult = { success: [], failed: [] }
	const totalPackages = packagePaths.length
	if (totalPackages === 0) return results

	const unpakedRoot = options.unpakedDir ? path.resolve(options.unpakedDir) : UNPAKED_DIR
	const repakedRoot = options.repakedDir ? path.resolve(options.repakedDir) : REPAKED_DIR
	const pakRoot = options.pakDir ? path.resolve(options.pakDir) : PAK_DIR
	await ensureDirAsync(repakedRoot)

	let pool: Piscina<RepakTaskInput, RepakTaskResult> | null = null
	try {
		try {
			pool = createRepakPool()
		} catch (error) {
			// 100% assíncrono: sem fallback síncrono no main. Falha estruturada por pacote.
			const msg = `RePAK worker pool unavailable: ${errorMessage(error)}`
			for (const pkg of packagePaths) {
				results.failed.push({ packageName: path.basename(pkg), packagePath: pkg, error: msg } as PakFailure)
			}
			return results
		}
		const outcomes = await mapPool(
			packagePaths,
			Math.min(cpuThreadsForWork(), totalPackages),
			async (pkg, i) => {
				abortIfCanceled(options.signal)
				const packageName = path.basename(pkg)
				const packageIndex = i + 1
				const folderPathCandidate = await resolveRepackFolder(pkg, unpakedRoot, pakRoot)
				const folderPath = folderPathCandidate ?? packageOutputFolder(pkg, unpakedRoot, pakRoot)
				const outputPak = await repakOutputForPackage(pkg, folderPath, repakedRoot, pakRoot)
				onProgress?.({
					stage: 'repak-start',
					packageName,
					packageIndex,
					packageTotal: totalPackages,
					file: folderPath,
					output: outputPak,
					percent: Math.round(((packageIndex - 1) / totalPackages) * 1000) / 10,
					globalPercent: true,
				})
				if (!(await isDirectoryAsync(folderPath))) {
					return {
						ok: false as const,
						failure: { packageName, packagePath: pkg, error: `Extracted folder not found: ${folderPath}` } as PakFailure,
					}
				}
				try {
					await ensureDirAsync(path.dirname(outputPak))
					// 100% assíncrono: exclusivamente em workers Piscina; sem fallback síncrono no main.
					// Slice of the effort budget: N pool workers × inner ≤ cpuThreadsForWork().
					await pool!.run(
						{
							inputFolder: folderPath,
							outputPak,
							version: 0,
							concurrency: innerConcurrency(totalPackages),
						},
						options.signal ? { signal: options.signal } : undefined,
					)
					onProgress?.({ stage: 'repak', packageName, packageIndex, packageTotal: totalPackages, current: 1, total: 1, percent: Math.round((packageIndex / totalPackages) * 1000) / 10, globalPercent: true, fileName: packageName, file: folderPath, output: outputPak })
					onProgress?.({
						stage: 'repak-done',
						packageName,
						packageIndex,
						packageTotal: totalPackages,
						file: folderPath,
						output: outputPak,
						percent: Math.round((packageIndex / totalPackages) * 1000) / 10,
						globalPercent: true,
					})
					return { ok: true as const, entry: { packageName, packagePath: pkg, outputPak } as PakRepackSuccess }
				} catch (error) {
					return { ok: false as const, failure: { packageName, packagePath: pkg, error: errorMessage(error) } as PakFailure }
				}
			},
			options.signal,
		)
		for (const o of outcomes) {
			if (o.ok) results.success.push(o.entry)
			else results.failed.push(o.failure)
		}
	} finally {
		if (pool) await pool.destroy()
	}

	return results
}

// ---------------------------------------------------------------------------
// RePAKEDS: add files to an existing .pak incrementally.
// ---------------------------------------------------------------------------

function isInsideDir(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base)
	const resolved = path.resolve(candidate)
	return resolved === resolvedBase || isSubPath(resolvedBase, resolved)
}

function sanitizeEntryName(name: string): string | null {
	const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
	if (normalized.length === 0) return null
	const segments = normalized.split('/')
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') return null
		if (/^[a-zA-Z]:/.test(segment)) return null
	}
	return segments.join('/')
}

async function collectAddEntries(sourcePaths: string[], targetFolder?: string): Promise<PakAddEntry[]> {
	const entries: PakAddEntry[] = []
	const seen = new Set<string>()
	function push(entry: PakAddEntry): void {
		const key = entry.name.replace(/\\/g, '/').toLowerCase()
		if (seen.has(key)) return
		seen.add(key)
		entries.push(entry)
	}
	const target = targetFolder ? sanitizeEntryName(targetFolder.replace(/^\/+|\/+$/g, '')) : null
	if (target) {
		const parts = target.split('/')
		let acc = ''
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part
			push({ name: `${acc}/`, absolutePath: '', isDirectory: true, mtime: new Date() })
		}
	}
	const prefix = target ? `${target}/` : ''
	async function walk(dir: string, currentPrefix: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error('Operation canceled')
		let dirents: import('fs').Dirent[]
		try {
			dirents = await fsp.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const dirent of dirents) {
			if (dirent.name === '.pak-metadata.json' || dirent.name.startsWith('._tmp_repack')) continue
			const full = path.join(dir, dirent.name)
			const rel = currentPrefix ? `${currentPrefix}/${dirent.name}` : dirent.name
			const name = sanitizeEntryName(rel)
			if (!name) continue
			let stat
			try {
				stat = await fsp.stat(full)
			} catch {
				continue
			}
			if (stat.isDirectory()) {
				push({ name: `${name}/`, absolutePath: full, isDirectory: true, mtime: stat.mtime })
				await walk(full, name, signal)
			} else if (stat.isFile()) {
				const lower = dirent.name.toLowerCase()
				if (lower.endsWith('.db') || lower.endsWith('.pak')) continue
				push({ name, absolutePath: full, isDirectory: false, mtime: stat.mtime })
			}
		}
	}
	for (const source of sourcePaths) {
		let stat
		try {
			stat = await fsp.stat(source)
		} catch {
			continue
		}
		const base = path.basename(source)
		if (stat.isDirectory()) {
			const rootName = sanitizeEntryName(`${prefix}${base}`)
			if (!rootName) continue
			push({ name: `${rootName}/`, absolutePath: source, isDirectory: true, mtime: stat.mtime })
			await walk(source, rootName)
		} else if (stat.isFile()) {
			const name = sanitizeEntryName(`${prefix}${base}`)
			if (!name) continue
			push({ name, absolutePath: source, isDirectory: false, mtime: stat.mtime })
		}
	}
	return entries
}

export interface AddFilesToPakOptions extends PakServiceOptions {
	overwrite?: boolean;
	targetFolder?: string;
	base?: string;
}

/** Adds/replaces files in an existing .pak under /PAKS/repaked without recompressing kept entries. */
export async function addFilesToRepakedPak(
	pakPath: string,
	sourcePaths: string[],
	options: AddFilesToPakOptions = {},
): Promise<PakServiceResult> {
	const results: PakServiceResult = { success: [], failed: [] }
	const packageName = path.basename(pakPath)
	const allowedBase = options.base && options.base.length > 0 ? options.base : REPAKED_DIR
	if (!isInsideDir(allowedBase, pakPath)) {
		results.failed.push({ packageName, packagePath: pakPath, error: `Access denied: pak outside ${allowedBase}` } as PakFailure)
		return results
	}
	if (!(await existsAsync(pakPath))) {
		results.failed.push({ packageName, packagePath: pakPath, error: `PAK not found: ${pakPath}` } as PakFailure)
		return results
	}
	const entries = await collectAddEntries(sourcePaths, options.targetFolder)
	if (entries.length === 0) {
		results.failed.push({ packageName, packagePath: pakPath, error: 'No files to add' } as PakFailure)
		return results
	}

	const onProgress = options.onProgress
	onProgress?.({ stage: 'repak-start', packageName, packageIndex: 1, packageTotal: 1, percent: 0, file: pakPath })

	try {
		const result = await addEntriesToPak(pakPath, entries, {
			overwrite: options.overwrite === true,
			onProgress: (info) => {
				onProgress?.(
					{
						stage: 'repak',
						packageName,
						packageIndex: 1,
						packageTotal: 1,
						current: info.current,
						total: info.total,
						percent: info.percent,
						bytesDelta: info.bytesDelta,
						fileName: info.fileName ?? undefined,
						file: pakPath,
						output: info.output,
					},
					{ current: info.current, total: info.total },
				)
			},
			shouldAbort: () => options.signal?.aborted ?? false,
		})
		onProgress?.({ stage: 'repak-done', packageName, packageIndex: 1, packageTotal: 1, percent: 100, file: pakPath })
		results.success.push({
			packageName,
			packagePath: pakPath,
			added: result.added,
			replaced: result.replaced,
			skipped: result.skipped,
			total: result.total,
			conflicts: result.conflicts ?? [],
		})
	} catch (error) {
		results.failed.push({ packageName, packagePath: pakPath, error: errorMessage(error) } as PakFailure)
	}
	return results
}

// ---------------------------------------------------------------------------
// Delete entries from a RePAKED .pak (files or folders) without recompressing
// the entries that remain.
// ---------------------------------------------------------------------------

export async function deleteRepakedPakEntries(
	pakPath: string,
	entries: string[],
	options: PakServiceOptions & { base?: string } = {},
): Promise<PakServiceResult> {
	const results: PakServiceResult = { success: [], failed: [] }
	const packageName = path.basename(pakPath)
	const allowedBase = options.base && options.base.length > 0 ? options.base : REPAKED_DIR
	if (!isInsideDir(allowedBase, pakPath)) {
		results.failed.push({ packageName, packagePath: pakPath, error: `Access denied: pak outside ${allowedBase}` } as PakFailure)
		return results
	}
	if (!(await existsAsync(pakPath))) {
		results.failed.push({ packageName, packagePath: pakPath, error: `PAK not found: ${pakPath}` } as PakFailure)
		return results
	}
	const normalized = entries
		.map((entry) => entry.replace(/\\/g, '/').trim())
		.filter((entry) => entry.length > 0)
	if (normalized.length === 0) {
		results.failed.push({ packageName, packagePath: pakPath, error: 'No entries selected' } as PakFailure)
		return results
	}

	const onProgress = options.onProgress
	onProgress?.({ stage: 'repak-start', packageName, packageIndex: 1, packageTotal: 1, percent: 0, file: pakPath })
	try {
		const result = await removeEntriesFromPak(pakPath, normalized, {
			onProgress: (info) => {
				onProgress?.(
					{
						stage: 'repak',
						packageName,
						packageIndex: 1,
						packageTotal: 1,
						percent: info.percent,
						file: pakPath,
						output: info.output,
					},
					{ current: info.current, total: info.total },
				)
			},
			shouldAbort: () => options.signal?.aborted ?? false,
		})
		onProgress?.({ stage: 'repak-done', packageName, packageIndex: 1, packageTotal: 1, percent: 100, file: pakPath })
		results.success.push({ packageName, packagePath: pakPath, removed: result.removed })
	} catch (error) {
		results.failed.push({ packageName, packagePath: pakPath, error: errorMessage(error) } as PakFailure)
	}
	return results
}
