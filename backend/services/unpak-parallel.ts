import type { Piscina } from 'piscina'
import type { ProgressPayload } from '../../shared/api-types'
import { scanPakEntries } from '../core/unpak'
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
 */
export async function extractPaksParallel(
	jobs: UnpakJob[],
	pool: Piscina<UnpakTaskInput, UnpakTaskResult>,
	threads: number,
	onProgress: ProgressCallback | undefined,
	signal: AbortSignal | undefined,
): Promise<UnpakJobOutcome[]> {
	const scans = new Map<string, { files: string[]; version: number | null }>()
	let grandTotal = 0
	for (const job of jobs) {
		if (signal?.aborted) throw new Error('Operation canceled')
		const scan = await scanPakEntries(job.pakPath, () => signal?.aborted ?? false)
		scans.set(job.pakPath, scan)
		grandTotal += scan.files.length
	}
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
		outcomes.set(job.pakPath, { job, ok: true, files: scans.get(job.pakPath)?.files ?? [] })
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
