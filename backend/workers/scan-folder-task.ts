import { readdirSync, statSync } from 'fs'
import path from 'path'
import type { MessagePort } from 'node:worker_threads'
import { peekPakKind, type PakFileKind } from '../core/unpak'

export interface ScannedPakFile {
	path: string
	kind: Exclude<PakFileKind, 'other'>
}

export interface ScanFolderTaskInput {
	rootDir: string
	includeNonPak: boolean
	port?: MessagePort
}

export interface ScanFolderTaskResult {
	pakFiles: ScannedPakFile[]
	otherFiles: string[]
	filesFound: number
}

function isExtractableKind(kind: PakFileKind): kind is Exclude<PakFileKind, 'other'> {
	return kind === 'aion' || kind === 'zip' || kind === 'chromium'
}

/**
 * Directory walk + PAK classification. Runs inside a worker so the Electron
 * main process keeps pumping the native message loop (Windows "Not Responding"
 * otherwise). Sync fs is intentional here: this thread does not own the window.
 */
export default async function scanFolderTask(input: ScanFolderTaskInput): Promise<ScanFolderTaskResult> {
	const rootDir = typeof input?.rootDir === 'string' ? input.rootDir : ''
	const includeNonPak = input?.includeNonPak === true
	const port = input?.port
	let aborted = false
	const onAbort = (msg: unknown): void => {
		if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'abort') {
			aborted = true
		}
	}
	if (port && typeof port.postMessage === 'function') {
		try {
			port.on('message', onAbort)
		} catch {
			// ignore
		}
		try {
			port.start?.()
		} catch {
			// ignore
		}
	}

	const pakFiles: ScannedPakFile[] = []
	const otherFiles: string[] = []
	let filesFound = 0
	let scanned = 0

	const report = (): void => {
		try {
			port?.postMessage({ type: 'progress', filesFound })
		} catch {
			// port closed
		}
	}

	const walk = async (dir: string): Promise<void> => {
		let names: string[]
		try {
			names = readdirSync(dir)
		} catch {
			return
		}
		for (const name of names) {
			if (aborted) throw new Error('Operation canceled')
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
				filesFound += 1
				const ext = path.extname(name).toLowerCase()
				if (ext === '.pak') {
					const kind = peekPakKind(full)
					if (isExtractableKind(kind)) pakFiles.push({ path: full, kind })
					else if (includeNonPak) otherFiles.push(full)
				} else if (includeNonPak) {
					otherFiles.push(full)
				}
			}
			if ((scanned & 255) === 0) {
				report()
				await new Promise<void>((resolve) => setImmediate(resolve))
			}
		}
	}

	try {
		if (rootDir) await walk(rootDir)
		report()
		return { pakFiles, otherFiles, filesFound }
	} finally {
		try {
			port?.close()
		} catch {
			// ignore
		}
	}
}
