import type { ProgressPayload } from '../../shared/api-types'

export type ProgressCallback = (
	payload: ProgressPayload,
	opts?: { current?: number; total?: number },
) => void

function toCloneable<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

function sanitizeProgressPayload(payload: ProgressPayload): ProgressPayload {
	const plain: Record<string, unknown> = {}
	const allowed = [
		'stage', 'packageName', 'packageIndex', 'packageTotal',
		'current', 'total', 'percent', 'globalPercent', 'bytesDelta', 'speedMBs',
		'fileName', 'file', 'folder',
		'message', 'translationName', 'folderName', 'output', 'fileNames',
	]
	for (const key of allowed) {
		const val = (payload as Record<string, unknown>)[key]
		if (val !== undefined) {
			plain[key] = val
		}
	}
	return plain as ProgressPayload
}

function isBoundaryStage(stage: string): boolean {
	return /(?:^|-)(start|done|canceled)$/.test(stage)
}

function isEndStage(stage: string): boolean {
	return /(?:^|-)(done|canceled)$/.test(stage)
}

/**
 * Batched progress sender: at most 1 IPC event per second for per-file
 * stages, plus boundary events (start/done/canceled/error) always sent.
 * Per-file names accumulate into `fileNames[]` batches; the bar/text never
 * shows file names (renderer rule). `showFileProgress` may be a boolean or a
 * getter so the renderer can toggle file-name streaming mid-operation (the
 * getter is only consulted once per flush, i.e. ~1/s).
 */
export function createProgressSender(
	send: (payload: ProgressPayload) => void,
	showFileProgress: boolean | (() => boolean),
): ProgressCallback {
	let lastFlush = 0
	let pendingNames: string[] = []
	let pendingPayload: ProgressPayload | null = null
	// Disk-speed window: bytes read since the window opened and its start time.
	let windowBytes = 0
	let windowStart = 0
	const FLUSH_MS = 1000
	// Safety bound only: the renderer log keeps the last 2000 entries, so a
	// larger batch could not be displayed anyway. Well above the per-second rate
	// of typical extractions, so names are effectively never dropped.
	const MAX_FLUSH_NAMES = 2000

	const show = (): boolean =>
		typeof showFileProgress === 'function' ? showFileProgress() : showFileProgress

	function emit(payload: ProgressPayload): void {
		try {
			send(toCloneable(sanitizeProgressPayload(payload)))
		} catch {
			try { send({ stage: payload.stage, percent: payload.percent, packageName: payload.packageName }) } catch { /* ignore */ }
		}
	}

	function accumulateBytes(payload: ProgressPayload, now: number): void {
		const delta = (payload as Record<string, unknown>).bytesDelta
		if (typeof delta === 'number' && Number.isFinite(delta) && delta > 0) {
			if (windowStart === 0) windowStart = now
			windowBytes += delta
		}
	}

	// Bytes accumulated in the window plus the smoothed rate (1 decimal).
	function takeWindowSpeed(now: number): { bytesDelta?: number; speedMBs?: number } {
		if (windowBytes <= 0) {
			windowBytes = 0
			windowStart = 0
			return {}
		}
		const bytes = windowBytes
		const elapsedSec = windowStart > 0 ? (now - windowStart) / 1000 : 0
		windowBytes = 0
		windowStart = 0
		if (elapsedSec <= 0) return { bytesDelta: bytes }
		return {
			bytesDelta: bytes,
			speedMBs: Math.round((bytes / elapsedSec / (1024 * 1024)) * 10) / 10,
		}
	}

	function flush(force = false): void {
		if (!pendingPayload) return
		const now = Date.now()
		if (!force && now - lastFlush < FLUSH_MS) return
		lastFlush = now
		const out: ProgressPayload = { ...pendingPayload }
		const speed = takeWindowSpeed(now)
		if (typeof speed.bytesDelta === 'number') out.bytesDelta = speed.bytesDelta
		if (typeof speed.speedMBs === 'number') out.speedMBs = speed.speedMBs
		if (pendingNames.length > 0) {
			if (show()) {
				out.fileNames = pendingNames.slice(0, MAX_FLUSH_NAMES)
				if (pendingNames.length > MAX_FLUSH_NAMES) {
					;(out as Record<string, unknown>).fileNamesOverflow = pendingNames.length - MAX_FLUSH_NAMES
				}
			}
		}
		pendingNames = []
		pendingPayload = null
		emit(out)
	}

	return function sendProgress(
		payload: ProgressPayload,
		_opts: { current?: number; total?: number } = {},
	): void {
		const stage = String(payload.stage ?? '')
		if (isBoundaryStage(stage)) {
			// Flush any pending batch first so ordering stays sane.
			flush(true)
			const now = Date.now()
			const copy: ProgressPayload = { ...payload }
			delete copy.bytesDelta
			if (isEndStage(stage)) {
				// End of action: reset the window and signal the renderer to clear.
				windowBytes = 0
				windowStart = 0
				copy.speedMBs = 0
			} else {
				// Start of action: reset the window, no rate yet.
				windowBytes = 0
				windowStart = 0
				delete copy.speedMBs
			}
			if (!show()) {
				delete copy.fileName
				delete copy.file
				delete copy.fileNames
			} else if (payload.fileName && !copy.fileNames) {
				copy.fileNames = [String(payload.fileName)]
			}
			lastFlush = now
			emit(copy)
			return
		}

		// Per-file progress: accumulate, throttle to 1/sec.
		const copy: ProgressPayload = { ...payload }
		delete copy.fileName
		delete copy.file
		accumulateBytes(payload, Date.now())
		delete copy.bytesDelta
		delete copy.speedMBs
		if (typeof payload.fileName === 'string' && payload.fileName.length > 0) {
			pendingNames.push(payload.fileName)
		} else if (typeof payload.file === 'string' && payload.file.length > 0) {
			pendingNames.push(payload.file)
		}
		pendingPayload = copy
		flush(false)
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError'
}
