import { extractPakToFolder } from '../core/unpak'
import type { MessagePort } from 'node:worker_threads'

export interface UnpakTaskInput {
	inputPath: string;
	outputFolder: string;
	entries?: string[];
	/** AION XOR version from `scanPakEntries` (avoids per-entry detection). */
	version?: number;
	port?: MessagePort;
}

export interface UnpakTaskResult {
	inputPath: string;
	outputFolder: string;
}

function isDirectoryEntryName(fileName: string): boolean {
	return fileName.endsWith('/') || fileName.endsWith('\\')
}

export default async function unpakTask(input: UnpakTaskInput): Promise<UnpakTaskResult> {
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
		// Report files only (skip explicit directory entries) so `current`
		// stays consistent with countFilesInPak(), which counts files.
		let filesDone = 0
		const progressCallback = (progress: { current: number; total: number; percent: number; fileName: string; outputFolder: string; bytesDelta?: number }): void => {
			const name = progress.fileName ?? ''
			if (isDirectoryEntryName(name)) {
				if (typeof progress.bytesDelta === 'number' && progress.bytesDelta > 0) {
					try {
						port.postMessage({
							type: 'progress',
							current: filesDone,
							fileName: progress.fileName,
							outputFolder: progress.outputFolder,
							bytesDelta: progress.bytesDelta,
						})
					} catch {
						// ignore if port closed
					}
				}
				return
			}
			filesDone += 1
			try {
				port.postMessage({
					type: 'progress',
					current: filesDone,
					fileName: progress.fileName,
					outputFolder: progress.outputFolder,
					bytesDelta: progress.bytesDelta,
				})
			} catch {
				// ignore if port closed
			}
		}
		try {
			await extractPakToFolder(input.inputPath, input.outputFolder, progressCallback, shouldAbort, input.entries, input.version)
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
		return { inputPath: input.inputPath, outputFolder: input.outputFolder }
	}
	await extractPakToFolder(input.inputPath, input.outputFolder, undefined, undefined, input.entries, input.version)
	return { inputPath: input.inputPath, outputFolder: input.outputFolder }
}
