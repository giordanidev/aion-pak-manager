import { createAionPak } from '../core/repak'
import type { MessagePort } from 'node:worker_threads'

export interface RepakTaskInput {
	inputFolder: string;
	outputPak: string;
	version?: number;
	port?: MessagePort;
	/** Effective CPU threads from settings for in-worker parallel prepare. */
	concurrency?: number;
}

export interface RepakTaskResult {
	inputFolder: string;
	outputPak: string;
}

export default async function repakTask(input: RepakTaskInput): Promise<RepakTaskResult> {
	const port = (input as { port?: MessagePort }).port
	if (port && typeof (port as unknown as { postMessage?: unknown }).postMessage === 'function') {
		let aborted = false
		const onAbortMessage = (msg: unknown): void => {
			if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'abort') {
				aborted = true
			}
		}
		try {
			// MessagePort may be EventEmitter style or onmessage style
			;(port as unknown as { on: (ev: string, cb: (m: unknown) => void) => void }).on('message', onAbortMessage)
		} catch {
			// ignore
		}
		try {
			;(port as unknown as { start?: () => void }).start?.()
		} catch {
			// ignore
		}
		const shouldAbort = (): boolean => aborted
		const progressCallback = (progress: { current: number; total: number; percent: number; fileName?: string | null; fileIndex?: number; totalFiles?: number | null; output: string; stage: string; bytesDelta?: number }): void => {
			try {
				port.postMessage({
					type: 'progress',
					current: progress.current,
					total: progress.total,
					percent: progress.percent,
					fileName: progress.fileName ?? null,
					fileIndex: progress.fileIndex,
					totalFiles: progress.totalFiles,
					output: progress.output,
					stage: progress.stage,
					bytesDelta: progress.bytesDelta,
				})
			} catch {
				// ignore if port closed
			}
		}
		try {
			await createAionPak(input.inputFolder, input.outputPak, input.version ?? 0, progressCallback, shouldAbort, input.concurrency)
		} finally {
			try {
				;(port as unknown as { off?: (ev: string, cb: (...a: unknown[]) => void) => void }).off?.('message', onAbortMessage as (...a: unknown[]) => void)
			} catch {
				// ignore
			}
			try {
				port.close()
			} catch {
				// ignore
			}
		}
		return { inputFolder: input.inputFolder, outputPak: input.outputPak }
	}
	await createAionPak(input.inputFolder, input.outputPak, input.version ?? 0, undefined, undefined, input.concurrency)
	return { inputFolder: input.inputFolder, outputPak: input.outputPak }
}
