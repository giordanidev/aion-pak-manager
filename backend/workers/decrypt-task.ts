import { decryptFile } from '../core/decrypt'
import type { MessagePort } from 'node:worker_threads'

export interface DecryptTaskInput {
	files: string[];
	port?: MessagePort;
}

export interface DecryptProgressMessage {
	type: 'progress';
	filePath: string;
	success: boolean;
	error?: string;
}

export interface DecryptTaskResult {
	success: string[];
	failed: { path: string; error: string }[];
}

export default function decryptTask(input: string[] | DecryptTaskInput): DecryptTaskResult {
	const files = Array.isArray(input) ? input : input.files
	const port = !Array.isArray(input) ? input.port : undefined
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
		const success: string[] = []
		const failed: { path: string; error: string }[] = []
		try {
			for (const filePath of files) {
				if (aborted) throw new Error('Operation canceled')
				try {
					decryptFile(filePath)
					success.push(filePath)
					try {
						port.postMessage({ type: 'progress', filePath, success: true } as DecryptProgressMessage)
					} catch {
						// ignore if port closed
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					failed.push({ path: filePath, error: message })
					try {
						port.postMessage({ type: 'progress', filePath, success: false, error: message } as DecryptProgressMessage)
					} catch {
						// ignore if port closed
					}
				}
			}
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
		return { success, failed }
	}

	const success: string[] = []
	const failed: { path: string; error: string }[] = []

	for (const filePath of files) {
		try {
			decryptFile(filePath)
			success.push(filePath)
		} catch (error) {
			failed.push({
				path: filePath,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return { success, failed }
}
