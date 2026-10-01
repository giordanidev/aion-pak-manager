import { readdirSync, statSync } from 'fs'
import path from 'path'
import type { MessagePort } from 'node:worker_threads'
import { decryptFile } from '../core/decrypt'

export interface DecryptTaskInput {
	/** Decrypt these files. */
	files?: string[];
	/** Walk this folder (worker-side) and post path batches; does not decrypt. */
	op?: 'list' | 'decrypt';
	root?: string;
	port?: MessagePort;
}

export interface DecryptProgressMessage {
	type: 'progress';
	filePath: string;
	success: boolean;
	error?: string;
	bytes?: number;
}

export interface DecryptTaskResult {
	success: string[];
	failed: { path: string; error: string }[];
}

async function listDecryptable(root: string, port: MessagePort, aborted: () => boolean): Promise<void> {
	const batch: string[] = []
	let scanned = 0
	const flush = (): void => {
		if (batch.length === 0) return
		try {
			port.postMessage({ type: 'batch', files: batch.splice(0, batch.length) })
		} catch {
			// port closed
		}
	}
	async function walk(dir: string): Promise<void> {
		let names: string[]
		try {
			names = readdirSync(dir)
		} catch {
			return
		}
		for (const name of names) {
			if (aborted()) throw new Error('Operation canceled')
			if (name === '.pak-metadata.json') continue
			const full = path.join(dir, name)
			let stat: ReturnType<typeof statSync>
			try {
				stat = statSync(full)
			} catch {
				continue
			}
			scanned += 1
			if (stat.isDirectory()) {
				await walk(full)
			} else if (stat.isFile()) {
				const ext = path.extname(name).toLowerCase()
				if (ext === '.xml' || ext === '.html') batch.push(full)
			}
			if (batch.length >= 32 || (scanned & 127) === 0) {
				flush()
				await new Promise<void>((resolve) => setImmediate(resolve))
			}
		}
	}
	await walk(root)
	flush()
}

function fileBytes(filePath: string): number | undefined {
	try {
		return statSync(filePath).size
	} catch {
		return undefined
	}
}

export default async function decryptTask(input: string[] | DecryptTaskInput): Promise<DecryptTaskResult> {
	const files = Array.isArray(input) ? input : input.files ?? []
	const port = !Array.isArray(input) ? input.port : undefined
	if (!Array.isArray(input) && input.op === 'list' && typeof input.root === 'string' && port) {
		let aborted = false
		const onAbortMessage = (msg: unknown): void => {
			if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'abort') aborted = true
		}
		try {
			;(port as unknown as { on: (ev: string, cb: (m: unknown) => void) => void }).on('message', onAbortMessage)
		} catch {
			// ignore
		}
		try {
			;(port as unknown as { start?: () => void }).start?.()
		} catch {
			// ignore
		}
		try {
			await listDecryptable(input.root, port, () => aborted)
		} finally {
			try {
				port.close()
			} catch {
				// ignore
			}
		}
		return { success: [], failed: [] }
	}
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
						port.postMessage({ type: 'progress', filePath, success: true, bytes: fileBytes(filePath) } as DecryptProgressMessage)
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
