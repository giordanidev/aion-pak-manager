import os from 'os'
import type { CpuEffort } from '../../shared/api-types'
import { loadSettings } from './settings'

/** Conservative heap ceiling per Piscina worker (MB). Large inflate buffers dominate. */
export const WORKER_HEAP_MB = 512

/** RAM reserved for the OS + Electron main/renderer (bytes). */
const MEMORY_RESERVE_BYTES = 1536 * 1024 * 1024

/** Assumed peak RSS per worker when sizing the pool from free RAM (bytes). */
const MEMORY_PER_WORKER_BYTES = WORKER_HEAP_MB * 1024 * 1024

export function totalCpuThreads(): number {
	try {
		return Math.max(1, os.cpus().length)
	} catch {
		return 4
	}
}

/**
 * Cap worker threads so the pool does not try to consume all available RAM.
 * Uses the smaller of free-minus-reserve and half of total system memory.
 */
export function maxThreadsForAvailableMemory(): number {
	try {
		const total = os.totalmem()
		const free = os.freemem()
		const fromFree = Math.max(0, free - MEMORY_RESERVE_BYTES)
		const fromTotal = Math.max(0, total * 0.5)
		const budget = Math.min(fromFree, fromTotal)
		return Math.max(1, Math.floor(budget / MEMORY_PER_WORKER_BYTES))
	} catch {
		return 4
	}
}

export function resolveCpuThreads(effort?: CpuEffort, manual?: number): number {
	const total = totalCpuThreads()
	switch (effort) {
		case 'low':
			return Math.max(1, Math.round(total * 0.3))
		case 'medium':
			return Math.max(1, Math.round(total * 0.6))
		case 'extreme':
			return total
		case 'manual': {
			const n = Math.floor(manual ?? 0)
			if (n >= 1) return Math.min(n, total)
			return Math.max(1, Math.round(total * 0.9))
		}
		case 'high':
		default:
			return Math.max(1, Math.round(total * 0.9))
	}
}

// CLI-only override: forces the effective thread count for this process,
// ignoring settings.json. The app never sets it (stays null).
let threadsOverride: number | null = null

/** Forces the effective thread count (CLI `--effort`/`--threads`); `null` restores settings. */
export function setThreadsOverride(threads: number | null): void {
	threadsOverride =
		typeof threads === 'number' && Number.isFinite(threads) && threads >= 1
			? Math.max(1, Math.floor(threads))
			: null
}

/** Effective thread count for UnPAK / RePAK / Decrypt work (override or settings.json). */
export function cpuThreadsForWork(): number {
	const byMem = maxThreadsForAvailableMemory()
	if (threadsOverride != null) return Math.min(threadsOverride, byMem)
	const settings = loadSettings()
	return Math.min(resolveCpuThreads(settings.cpuEffort, settings.manualCpuThreads), byMem)
}

/** V8 resourceLimits for each Piscina worker so a single task cannot balloon forever. */
export function workerResourceLimits(): { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number } {
	return {
		maxOldGenerationSizeMb: WORKER_HEAP_MB,
		maxYoungGenerationSizeMb: Math.min(128, Math.floor(WORKER_HEAP_MB / 4)),
	}
}

/**
 * Inner per-job concurrency when `jobCount` jobs run in parallel under the
 * effort budget: `workers × inner ≤ cpuThreadsForWork()`.
 * A single job may use the full budget; many jobs each get a slice.
 */
export function innerConcurrency(jobCount: number): number {
	const budget = cpuThreadsForWork()
	const parallel = Math.max(1, Math.min(budget, Math.max(1, Math.floor(jobCount))))
	return Math.max(1, Math.floor(budget / parallel))
}
