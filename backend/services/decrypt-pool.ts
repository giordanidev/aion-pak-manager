import { existsSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { MessageChannel } from 'node:worker_threads'
import { Piscina } from 'piscina'
import type { ProgressPayload } from '../../shared/api-types'
import type { ProgressCallback } from './progress'
import type { DecryptTaskInput, DecryptTaskResult } from '../workers/decrypt-task'
import { mapPool } from './parallel'
import { cpuThreadsForWork } from './threads'

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

function resolveWorkerFile(name: string): string {
	const candidates: string[] = [
		path.join(__dirname, 'workers', `${name}.js`),
		path.join(__dirname, '..', 'workers', `${name}.js`),
		path.join(__dirname, '..', 'workers', `${name}.ts`),
		path.resolve(process.cwd(), 'backend', 'workers', `${name}.js`),
		path.resolve(process.cwd(), '.build', 'backend', 'workers', `${name}.js`),
		path.resolve(process.cwd(), '.build', 'backend', 'workers', `${name}.ts`),
	]
	for (const cand of candidates) {
		try {
			if (existsSync(cand)) {
				let out = cand
				if (out.includes('app.asar') && !out.includes('app.asar.unpacked')) {
					out = out.replace('app.asar', 'app.asar.unpacked')
				}
				return out
			}
		} catch {
			// ignore
		}
	}
	const raw = path.join(__dirname, 'workers', `${name}.js`)
	if (raw.includes('app.asar') && !raw.includes('app.asar.unpacked')) {
		return raw.replace('app.asar', 'app.asar.unpacked')
	}
	return raw
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

export function createDecryptPool(): Piscina<DecryptTaskInput | string[], DecryptTaskResult> {
	return new Piscina({
		filename: resolveDecryptWorkerFile(),
		maxThreads: cpuThreadsForWork(),
	})
}

function collectFiles(folderPath: string): string[] {
	const files: string[] = []
	function walk(dir: string): void {
		for (const name of readdirSync(dir)) {
			if (name === '.pak-metadata.json') continue
			const fullPath = path.join(dir, name)
			const stat = statSync(fullPath)
			if (stat.isDirectory()) {
				walk(fullPath)
			} else if (stat.isFile()) {
				const ext = path.extname(name).toLowerCase()
				if (ext === '.xml' || ext === '.html') {
					files.push(fullPath)
				}
			}
		}
	}
	walk(folderPath)
	return files
}

function percentOf(current: number, total: number): number {
	return Math.round((current / Math.max(total, 1)) * 1000) / 10
}

export async function decryptFolderParallel(
	folder: string,
	options: DecryptFolderOptions = {},
): Promise<DecryptFolderResult> {
	const resolved = path.resolve(folder)
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		throw new Error(`Input folder not found: ${resolved}`)
	}

	const files = collectFiles(resolved)
	const total = files.length
	const results: DecryptFolderResult = { success: [], failed: [] }
	if (total === 0) {
		return results
	}

	const onProgress = options.onProgress
	const externalPool = options.pool
	const pool = externalPool ?? createDecryptPool()
	const shouldDestroy = !externalPool
	// Small batches so Piscina queue stays full with up to maxThreads in flight.
	const batchSize = 32
	const batches: string[][] = []
	for (let i = 0; i < total; i += batchSize) {
		batches.push(files.slice(i, i + batchSize))
	}

	let current = 0
	const reported = new Set<string>()

	function reportFile(filePath: string, ok: boolean, error?: string): void {
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
		let bytesDelta: number | undefined
		try {
			bytesDelta = statSync(filePath).size
		} catch {
			bytesDelta = undefined
		}
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

	try {
		if (options.signal?.aborted) throw new Error('Operation canceled')
		await mapPool(
			batches,
			cpuThreadsForWork(),
			async (batch) => {
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
					// Per-file call: createProgressSender batches/throttles IPC to 1/sec.
					reportFile(filePath, ok, err)
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
			},
			options.signal,
		)
	} finally {
		if (shouldDestroy) {
			await pool.destroy()
		}
	}

	return results
}
