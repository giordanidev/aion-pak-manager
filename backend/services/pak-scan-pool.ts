import { Piscina } from 'piscina'
import { countFilesInPak, listFilesInPak, scanPakEntries, type PakScanResult } from '../core/unpak'
import type { PakScanTaskInput, PakScanTaskResult } from '../workers/pak-scan-task'
import { resolvePakScanWorkerFile } from './decrypt-pool'
import { errorMessage } from './progress'
import { cpuThreadsForWork, workerResourceLimits } from './threads'

let scanPool: Piscina<PakScanTaskInput, PakScanTaskResult> | null = null

function getPakScanPool(): Piscina<PakScanTaskInput, PakScanTaskResult> {
	if (!scanPool) {
		scanPool = new Piscina({
			filename: resolvePakScanWorkerFile(),
			maxThreads: cpuThreadsForWork(),
			resourceLimits: workerResourceLimits(),
		})
	}
	return scanPool
}

function workerMissing(error: unknown): boolean {
	return /worker file not found|cannot find module|MODULE_NOT_FOUND/i.test(errorMessage(error))
}

async function runScan<T>(input: PakScanTaskInput, signal: AbortSignal | undefined, fallback: () => Promise<T>, map: (result: PakScanTaskResult) => T): Promise<T> {
	try {
		const result = await getPakScanPool().run(input, signal ? { signal } : undefined)
		return map(result)
	} catch (error) {
		if (signal?.aborted || /canceled/i.test(errorMessage(error))) throw error
		if (!workerMissing(error)) throw error
		return fallback()
	}
}

/** Read a PAK table of contents off the Electron main thread. */
export function scanPakOffThread(pakPath: string, signal?: AbortSignal): Promise<PakScanResult> {
	return runScan(
		{ op: 'scan', path: pakPath },
		signal,
		() => scanPakEntries(pakPath, () => signal?.aborted ?? false),
		(result) => ({ files: result.files ?? [], version: result.version ?? null }),
	)
}

/** Count entries inside a PAK off the Electron main thread. */
export function countPakOffThread(pakPath: string, signal?: AbortSignal): Promise<number> {
	return runScan(
		{ op: 'count', path: pakPath },
		signal,
		() => countFilesInPak(pakPath, () => signal?.aborted ?? false),
		(result) => result.count ?? 0,
	)
}

/** List file names inside a PAK off the Electron main thread. */
export function listPakOffThread(pakPath: string, signal?: AbortSignal): Promise<string[]> {
	return runScan(
		{ op: 'list', path: pakPath },
		signal,
		() => listFilesInPak(pakPath, () => signal?.aborted ?? false),
		(result) => result.files ?? [],
	)
}

/** List a folder tree (structure view) off the Electron main thread. */
export function listFolderOffThread(root: string, signal?: AbortSignal): Promise<string[]> {
	return runScan(
		{ op: 'list-folder', path: root },
		signal,
		async () => {
			const { readdir, stat } = await import('fs/promises')
			const path = await import('path')
			const results: string[] = []
			let scanned = 0
			async function walk(dir: string, rel: string): Promise<void> {
				let names: string[]
				try {
					names = await readdir(dir)
				} catch {
					return
				}
				for (const name of names) {
					if (name === '.pak-metadata.json' || name === '._tmp_repack' || name.startsWith('._tmp_repack_')) continue
					const full = path.join(dir, name)
					let info
					try {
						info = await stat(full)
					} catch {
						continue
					}
					const relPath = rel ? `${rel}/${name}` : name
					scanned += 1
					if (info.isDirectory()) await walk(full, relPath)
					else if (info.isFile()) results.push(relPath)
					if ((scanned & 31) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
				}
			}
			await walk(root, '')
			return results
		},
		(result) => result.files ?? [],
	)
}
