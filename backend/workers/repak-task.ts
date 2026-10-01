import { addEntriesToPak, collectAddSources, createAionPak, createAionPakFromFiles, removeEntriesFromPak } from '../core/repak'
import type { MessagePort } from 'node:worker_threads'
import type { RepackProgress } from '../core/repak'

export interface RepakTaskInput {
	op?: 'create' | 'pack-list' | 'add' | 'remove';
	inputFolder?: string;
	outputPak?: string;
	version?: number;
	port?: MessagePort;
	/** Effective CPU threads from settings for in-worker parallel prepare. */
	concurrency?: number;
	/** create: fail when the folder has no packable files. */
	rejectEmpty?: boolean;
	srcRoot?: string;
	files?: string[];
	pakPath?: string;
	sourcePaths?: string[];
	targetFolder?: string;
	overwrite?: boolean;
	names?: string[];
}

export interface RepakTaskResult {
	inputFolder: string;
	outputPak: string;
	added?: number;
	replaced?: number;
	skipped?: number;
	total?: number;
	conflicts?: string[];
	removed?: number;
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
			if (input.op === 'pack-list') {
				const total = await createAionPakFromFiles(
					input.srcRoot ?? '',
					input.files ?? [],
					input.outputPak ?? '',
					input.version ?? 0,
					progressCallback as (info: RepackProgress) => void,
					shouldAbort,
					input.concurrency,
				)
				return { inputFolder: input.srcRoot ?? '', outputPak: input.outputPak ?? '', total }
			}
			if (input.op === 'add') {
				const entries = collectAddSources(input.sourcePaths ?? [], input.targetFolder)
				const result = await addEntriesToPak(input.pakPath ?? '', entries, {
					overwrite: input.overwrite === true,
					version: input.version ?? 0,
					shouldAbort,
					onProgress: progressCallback as (info: RepackProgress) => void,
				})
				return {
					inputFolder: '',
					outputPak: input.pakPath ?? '',
					added: result.added,
					replaced: result.replaced,
					skipped: result.skipped,
					total: result.total,
					conflicts: result.conflicts,
				}
			}
			if (input.op === 'remove') {
				const result = await removeEntriesFromPak(input.pakPath ?? '', input.names ?? [], {
					shouldAbort,
					onProgress: progressCallback as (info: RepackProgress) => void,
				})
				return { inputFolder: '', outputPak: input.pakPath ?? '', removed: result.removed }
			}
			await createAionPak(
				input.inputFolder ?? '',
				input.outputPak ?? '',
				input.version ?? 0,
				progressCallback,
				shouldAbort,
				input.concurrency,
				input.rejectEmpty === true,
			)
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
		return { inputFolder: input.inputFolder ?? input.srcRoot ?? '', outputPak: input.outputPak ?? input.pakPath ?? '' }
	}
	if (input.op === 'pack-list') {
		const total = await createAionPakFromFiles(input.srcRoot ?? '', input.files ?? [], input.outputPak ?? '', input.version ?? 0, undefined, undefined, input.concurrency)
		return { inputFolder: input.srcRoot ?? '', outputPak: input.outputPak ?? '', total }
	}
	if (input.op === 'add') {
		const entries = collectAddSources(input.sourcePaths ?? [], input.targetFolder)
		const result = await addEntriesToPak(input.pakPath ?? '', entries, { overwrite: input.overwrite === true, version: input.version ?? 0 })
		return { inputFolder: '', outputPak: input.pakPath ?? '', added: result.added, replaced: result.replaced, skipped: result.skipped, total: result.total, conflicts: result.conflicts }
	}
	if (input.op === 'remove') {
		const result = await removeEntriesFromPak(input.pakPath ?? '', input.names ?? [])
		return { inputFolder: '', outputPak: input.pakPath ?? '', removed: result.removed }
	}
	await createAionPak(input.inputFolder ?? '', input.outputPak ?? '', input.version ?? 0, undefined, undefined, input.concurrency, input.rejectEmpty === true)
	return { inputFolder: input.inputFolder ?? '', outputPak: input.outputPak ?? '' }
}
