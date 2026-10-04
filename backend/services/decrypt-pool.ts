import { existsSync, realpathSync } from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { MessageChannel } from 'node:worker_threads'
import { Piscina } from 'piscina'
import type { ProgressPayload } from '../../shared/api-types'
import type { ProgressCallback } from './progress'
import type { DecryptTaskInput, DecryptTaskResult } from '../workers/decrypt-task'
import { cpuThreadsForWork, workerResourceLimits } from './threads'

export interface DecryptFileProgress extends ProgressPayload {
	stage: 'decrypt';
	current: number;
	total: number;
	percent: number;
	folder: string;
	fileName?: string;
	file?: string;
	packageName?: string;
	packageIndex?: number;
	packageTotal?: number;
}

export interface DecryptFolderOptions {
	onProgress?: ProgressCallback;
	signal?: AbortSignal;
	packageName?: string;
	packageIndex?: number;
	packageTotal?: number;
	pool?: Piscina<DecryptTaskInput | string[], DecryptTaskResult>;
}

export interface DecryptFolderResult {
	success: string[];
	failed: { path: string; error: string }[];
}

/** Prefer a real on-disk path under app.asar.unpacked (worker_threads cannot load from asar). */
function toUnpackedPath(p: string): string {
	const normalized = p.replace(/\\/g, '/')
	if (normalized.includes('app.asar') && !normalized.includes('app.asar.unpacked')) {
		return p.replace('app.asar', 'app.asar.unpacked')
	}
	return p
}

function resolveExisting(p: string): string | null {
	try {
		const candidate = toUnpackedPath(p)
		if (!existsSync(candidate)) return null
		try {
			return realpathSync(candidate)
		} catch {
			return path.resolve(candidate)
		}
	} catch {
		return null
	}
}

function resolveWorkerFile(name: string): string {
	const file = `${name}.js`
	const fileTs = `${name}.ts`
	const dir = __dirname
	const candidates: string[] = [
		// Packaged: workers live next to the main bundle under asar.unpacked.
		toUnpackedPath(path.join(dir, 'workers', file)),
		toUnpackedPath(path.join(dir, '..', 'workers', file)),
		path.join(dir, 'workers', file),
		path.join(dir, '..', 'workers', file),
		path.join(dir, '..', 'workers', fileTs),
		path.resolve(process.cwd(), 'backend', 'workers', file),
		path.resolve(process.cwd(), '.build', 'backend', 'workers', file),
		path.resolve(process.cwd(), '.build', 'backend', 'workers', fileTs),
	]
	for (const cand of candidates) {
		const resolved = resolveExisting(cand)
		if (resolved) return resolved
	}
	const fallback = toUnpackedPath(path.join(dir, 'workers', file))
	throw new Error(`Worker file not found: ${file} (looked near ${dir}; last candidate ${fallback})`)
}

export function resolveDecryptWorkerFile(): string {
	return resolveWorkerFile('decrypt-task')
}

export function resolveUnpakWorkerFile(): string {
	return resolveWorkerFile('unpak-task')
}

export function resolveRepakWorkerFile(): string {
	return resolveWorkerFile('repak-task')
}

export function resolveCountWorkerFile(): string {
	return resolveWorkerFile('count-task')
}

export function resolveScanWorkerFile(): string {
	return resolveWorkerFile('scan-folder-task')
}

export function resolvePakScanWorkerFile(): string {
	return resolveWorkerFile('pak-scan-task')
}

export function resolveDbWorkerFile(): string {
	return resolveWorkerFile('db-task')
}

export function createDecryptPool(): Piscina<DecryptTaskInput | string[], DecryptTaskResult> {
	return new Piscina({
		filename: resolveDecryptWorkerFile(),
		maxThreads: cpuThreadsForWork(),
		resourceLimits: workerResourceLimits(),
	})
}

function percentOf(current: number, total: number): number {
	return Math.round((current / Math.max(total, 1)) * 1000) / 10
}

export async function decryptFolderParallel(
	folder: string,
	options: DecryptFolderOptions = {},
): Promise<DecryptFolderResult> {
	const resolved = path.resolve(folder)
	const rootStat = await fsp.stat(resolved).catch(() => null)
	if (!rootStat?.isDirectory()) {
		throw new Error(`Input folder not found: ${resolved}`)
	}

	const results: DecryptFolderResult = { success: [], failed: [] }
	const onProgress = options.onProgress
	const externalPool = options.pool
	const pool = externalPool ?? createDecryptPool()
	const shouldDestroy = !externalPool

	let current = 0
	let total = 0
	const reported = new Set<string>()

	function reportFile(filePath: string, ok: boolean, error?: string, bytes?: number): void {
		// Dedupe: per-file port events update results immediately; the
		// worker return value only reconciles items never reported.
		if (reported.has(filePath)) return
		reported.add(filePath)
		current += 1
		const relPath = path.relative(resolved, filePath).replace(/\\/g, '/')
		if (ok) {
			results.success.push(relPath)
		} else {
			results.failed.push({ path: relPath, error: error ?? 'Unknown error' })
		}
		const bytesDelta = typeof bytes === 'number' && bytes > 0 ? bytes : undefined
		onProgress?.(
			{
				stage: 'decrypt',
				packageName: options.packageName,
				packageIndex: options.packageIndex,
				packageTotal: options.packageTotal,
				current,
				total,
				percent: percentOf(current, total),
				bytesDelta,
				fileName: relPath,
				file: filePath,
				folder: resolved,
			},
			{ current, total },
		)
	}

	const queue: string[][] = []
	let listed = false
	let listError: unknown = null
	const waiters: Array<() => void> = []
	const poke = (): void => {
		const fn = waiters.shift()
		fn?.()
	}
	const pokeAll = (): void => {
		const pending = waiters.splice(0, waiters.length)
		for (const fn of pending) fn()
	}

	try {
		if (options.signal?.aborted) throw new Error('Operation canceled')
		const listChannel = new MessageChannel()
		const listAbort = (): void => {
			try {
				listChannel.port1.postMessage({ type: 'abort' })
			} catch {
				// ignore
			}
		}
		const onListMessage = (msg: unknown): void => {
			if (!msg || typeof msg !== 'object') return
			const filesRaw = (msg as { files?: unknown }).files
			if ((msg as { type?: unknown }).type !== 'batch' || !Array.isArray(filesRaw)) return
			const files = filesRaw.filter((file): file is string => typeof file === 'string' && file.length > 0)
			if (files.length === 0) return
			total += files.length
			queue.push(files)
			poke()
		}
		try {
			listChannel.port1.on('message', onListMessage)
		} catch {
			// ignore
		}
		if (options.signal) {
			if (options.signal.aborted) listAbort()
			else options.signal.addEventListener('abort', listAbort, { once: true })
		}
		const listPromise = pool.run(
			{ op: 'list', root: resolved, port: listChannel.port2 } as DecryptTaskInput,
			{ transferList: [listChannel.port2], signal: options.signal ?? undefined } as unknown as Parameters<typeof pool.run>[1],
		).then(
			() => {
				listed = true
				pokeAll()
			},
			(error: unknown) => {
				listError = error
				listed = true
				pokeAll()
			},
		)

		async function takeBatch(): Promise<string[] | null> {
			for (;;) {
				if (listError) throw listError
				const next = queue.shift()
				if (next) {
					if (queue.length > 0) poke()
					return next
				}
				if (listed) return null
				await new Promise<void>((resolve) => {
					waiters.push(resolve)
				})
			}
		}

		const consumers = Math.max(1, cpuThreadsForWork())
		await Promise.all(
			Array.from({ length: consumers }, async () => {
				for (;;) {
					if (options.signal?.aborted) throw new Error('Operation canceled')
					const batch = await takeBatch()
					if (!batch) return
				if (options.signal?.aborted) throw new Error('Operation canceled')
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
					const m = msg as Record<string, unknown>
					if (m['type'] !== 'progress') return
					const filePath = m['filePath']
					if (typeof filePath !== 'string' || filePath.length === 0) return
					const ok = m['success'] === true
					const err = typeof m['error'] === 'string' ? (m['error'] as string) : undefined
					const bytes = typeof m['bytes'] === 'number' ? (m['bytes'] as number) : undefined
					// Per-file call: createProgressSender batches/throttles IPC to 1/sec.
					reportFile(filePath, ok, err, bytes)
				}
				try {
					;(port1 as unknown as { on: (ev: string, cb: (m: unknown) => void) => void }).on('message', messageHandler)
				} catch {
					// ignore
				}
				if (options.signal) {
					if (options.signal.aborted) {
						abortListener()
					} else {
						options.signal.addEventListener('abort', abortListener, { once: true })
					}
				}
				try {
					const taskResult = await pool.run(
						{ files: batch, port: port2 } as DecryptTaskInput,
						{ transferList: [port2], signal: options.signal ?? undefined } as unknown as Parameters<typeof pool.run>[1],
					)
					// Reconcile anything not reported via port (or legacy worker without port).
					for (const filePath of taskResult.success) {
						reportFile(filePath, true)
					}
					for (const item of taskResult.failed) {
						reportFile(item.path, false, item.error)
					}
				} finally {
					if (options.signal) {
						try {
							options.signal.removeEventListener('abort', abortListener)
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
					// port2 was transferred to worker; closing here is no-op if detached.
					try {
						;(port2 as unknown as { close?: () => void }).close?.()
					} catch {
						// ignore if already detached/closed
					}
				}
				}
			}),
		)
		await listPromise
		if (listError) throw listError
		try {
			listChannel.port1.close()
		} catch {
			// ignore
		}
		if (options.signal) {
			try {
				options.signal.removeEventListener('abort', listAbort)
			} catch {
				// ignore
			}
		}
	} finally {
		if (shouldDestroy) {
			await pool.destroy()
		}
	}

	return results
}
