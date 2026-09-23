import { MessageChannel } from 'node:worker_threads'
import type { Piscina } from 'piscina'
import type { UnpakTaskInput, UnpakTaskResult } from '../workers/unpak-task'

export interface UnpakFileProgress {
	current: number;
	total: number;
	fileName?: string;
	outputFolder?: string;
	bytesDelta?: number;
}

/**
 * Runs a single UnPAK task through the Piscina pool with a MessageChannel so
 * the worker reports per-file progress. `fileTotal` is the pre-counted total
 * (`countFilesInPak`) and is authoritative: worker counts are clamped to it.
 * The caller maps {@link UnpakFileProgress} into the desired progress stage
 * (e.g. `unpack` for individual UnPAK, `extract-folder` for full folders).
 */
export async function runUnpakWithProgress(
	pool: Piscina<UnpakTaskInput, UnpakTaskResult>,
	input: Omit<UnpakTaskInput, 'port'>,
	fileTotal: number,
	signal: AbortSignal | undefined,
	onFileProgress: (progress: UnpakFileProgress) => void,
): Promise<void> {
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
		const rawCurrent = typeof m['current'] === 'number' ? m['current'] : undefined
		if (typeof rawCurrent !== 'number') return
		const total = fileTotal
		const current = Math.min(Math.max(rawCurrent, 0), Math.max(total, 0))
		const fileName = typeof m['fileName'] === 'string' && m['fileName'].length > 0 ? (m['fileName'] as string) : undefined
		const outputFolder = typeof m['outputFolder'] === 'string' ? (m['outputFolder'] as string) : input.outputFolder
		const bytesDelta = typeof m['bytesDelta'] === 'number' && m['bytesDelta'] > 0 ? (m['bytesDelta'] as number) : undefined
		onFileProgress({ current, total, fileName, outputFolder, bytesDelta })
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
		await pool.run(
			{ ...input, port: port2 } as UnpakTaskInput,
			{ transferList: [port2], signal: signal ?? undefined } as unknown as Parameters<typeof pool.run>[1],
		)
	} finally {
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
