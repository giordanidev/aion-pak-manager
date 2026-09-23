import os from 'os'
import type { CpuEffort } from '../../shared/api-types'
import { loadSettings } from './settings'

export function totalCpuThreads(): number {
	try {
		return Math.max(1, os.cpus().length)
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
	if (threadsOverride != null) return threadsOverride
	const settings = loadSettings()
	return resolveCpuThreads(settings.cpuEffort, settings.manualCpuThreads)
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
