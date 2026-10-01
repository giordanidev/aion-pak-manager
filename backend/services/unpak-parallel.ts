import type { Piscina } from 'piscina'
import type { ProgressPayload } from '../../shared/api-types'
import type { PakScanResult } from '../core/unpak'
import { scanPakOffThread } from './pak-scan-pool'
import { mapPool } from './parallel'
import type { ProgressCallback } from './progress'
import { runUnpakWithProgress } from './unpak-pool'
import type { UnpakTaskInput, UnpakTaskResult } from '../workers/unpak-task'

export interface UnpakJob {
	pakPath: string
	outputFolder: string
	packageName: string
	packageIndex: number
	packageTotal: number
}

export interface UnpakJobOutcome {
	job: UnpakJob
	ok: boolean
	error?: string
	files: string[]
}

// Smallest entry slice handed to one worker. A single PAK is split into up to
// `threads` slices so it can saturate the pool; many PAKs share the same pool.
const MIN_CHUNK = 8

/**
 * Extracts every job's entries across a shared Piscina pool: each PAK is split
 * into entry chunks (so a single PAK uses multiple worker threads) while chunks
 * from different PAKs interleave for full utilization. Emits a **global**
 * monotonic percent (`done files / total files`) plus the current PAK for the
 * progress label. Per-PAK failures do not abort the others.
 *
 * Pass `preScans` (from a prior conflict/check pass) to skip a second full TOC
 * walk so extraction — and byte/speed progress — starts immediately.
 */
export async function extractPaksParallel(
	jobs: UnpakJob[],
	pool: Piscina<UnpakTaskInput, UnpakTaskResult>,
	threads: number,
	onProgress: ProgressCallback | undefined,
	signal: AbortSignal | undefined,
	preScans?: ReadonlyMap<string, PakScanResult>,
): Promise<UnpakJobOutcome[]> {
	const scans = new Map<string, PakScanResult>()
	const scanErrors = new Map<string, string>()
	const needScan = jobs.filter((job) => !preScans?.has(job.pakPath))
	for (const job of jobs) {
		const cached = preScans?.get(job.pakPath)
		if (cached) scans.set(job.pakPath, cached)
	}
	await mapPool(
		needScan,
		Math.max(1, Math.min(threads, Math.max(needScan.length, 1))),
		async (job) => {
			if (signal?.aborted) throw new Error('Operation canceled')
			onProgress?.({
				stage: 'unpack',
				packageName: job.packageName,
				packageIndex: job.packageIndex,
				packageTotal: job.packageTotal,
				current: 0,
				total: 0,
				percent: 0,
				globalPercent: true,
				fileName: job.packageName,
			} as ProgressPayload)
			try {
				const scan = await scanPakOffThread(job.pakPath, signal)
				scans.set(job.pakPath, scan)
			} catch (error) {
				scans.set(job.pakPath, { files: [], version: null })
				scanErrors.set(job.pakPath, error instanceof Error ? error.message : String(error))
			}
		},
		signal,
	)
	let grandTotal = 0
	for (const job of jobs) grandTotal += scans.get(job.pakPath)?.files.length ?? 0
	const total = Math.max(grandTotal, 1)

	interface Chunk {
		job: UnpakJob
		entries: string[]
		version: number | null
	}
	const chunks: Chunk[] = []
	for (const job of jobs) {
		const scan = scans.get(job.pakPath)
		if (!scan || scan.files.length === 0) continue
		const files = scan.files
		const chunkCount = Math.max(1, Math.min(threads, Math.ceil(files.length / MIN_CHUNK)))
		const size = Math.ceil(files.length / chunkCount)
		for (let i = 0; i < files.length; i += size) {
			chunks.push({ job, entries: files.slice(i, i + size), version: scan.version })
		}
	}

	const outcomes = new Map<string, UnpakJobOutcome>()
	for (const job of jobs) {
		const scanError = scanErrors.get(job.pakPath)
		if (scanError) {
			outcomes.set(job.pakPath, { job, ok: false, error: scanError, files: [] })
		} else {
			outcomes.set(job.pakPath, { job, ok: true, files: scans.get(job.pakPath)?.files ?? [] })
		}
	}

	let done = 0
	const started = new Set<string>()

	await mapPool(
		chunks,
		Math.max(1, Math.min(threads, Math.max(chunks.length, 1))),
		async (chunk) => {
			if (signal?.aborted) throw new Error('Operation canceled')
			const job = chunk.job
			try {
				await runUnpakWithProgress(
					pool,
					{
						inputPath: job.pakPath,
						outputFolder: job.outputFolder,
						entries: chunk.entries,
						version: chunk.version ?? undefined,
					},
					chunk.entries.length,
					signal,
					(progress) => {
						done += 1
						const percent = Math.round((done / total) * 1000) / 10
						if (!started.has(job.pakPath)) {
							started.add(job.pakPath)
							onProgress?.({
								stage: 'unpack-start',
								packageName: job.packageName,
								packageIndex: job.packageIndex,
								packageTotal: job.packageTotal,
								file: job.pakPath,
								total,
								globalPercent: true,
							} as ProgressPayload)
						}
						onProgress?.(
							{
								stage: 'unpack',
								packageName: job.packageName,
								packageIndex: job.packageIndex,
								packageTotal: job.packageTotal,
								current: done,
								total,
								percent,
								globalPercent: true,
								bytesDelta: progress.bytesDelta,
								fileName: progress.fileName,
								outputFolder: job.outputFolder,
							} as ProgressPayload,
							{ current: done, total },
						)
					},
				)
			} catch (error) {
				const outcome = outcomes.get(job.pakPath)
				if (outcome) {
					outcome.ok = false
					outcome.error = error instanceof Error ? error.message : String(error)
				}
			}
		},
		signal,
	)

	return jobs.map((job) => outcomes.get(job.pakPath) as UnpakJobOutcome)
}
