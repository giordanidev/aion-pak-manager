// Headless CLI logic for the AION PAK manager (Electron-free).
//
// Runs the same core as the app (backend/core) without opening the GUI, so
// UnPAK / RePAK / decrypt can be scripted. Used by the standalone entry
// (backend/cli/index.ts -> .build/backend/cli.js) and by the packaged app when
// launched as `<app>.exe cli <command>` (see backend/index.ts).
import { existsSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { MessageChannel } from 'node:worker_threads'
import { Piscina } from 'piscina'
import type { CpuEffort } from '../../shared/api-types'
import { createSimpleZipPak } from '../core/repak'
import {
	createDecryptPool,
	decryptFolderParallel,
	resolveRepakWorkerFile,
	resolveUnpakWorkerFile,
} from '../services/decrypt-pool'
import { mapPool } from '../services/parallel'
import { loadSettings } from '../services/settings'
import { cpuThreadsForWork, innerConcurrency, resolveCpuThreads, setThreadsOverride } from '../services/threads'
import { extractPaksParallel } from '../services/unpak-parallel'
import type { RepakTaskInput, RepakTaskResult } from '../workers/repak-task'
import type { UnpakTaskInput, UnpakTaskResult } from '../workers/unpak-task'

const USAGE = `Aion PAK Manager CLI

Usage:
  cli unpak <pak|folder...> [-o <dir>] [--decrypt] [--effort <mode>] [--threads <n>]
  cli repak <folder...> [-o <pak|dir>] [--simple-zip] [--effort <mode>] [--threads <n>]
  cli decrypt <folder...> [--effort <mode>] [--threads <n>]
  cli help

Commands:
  unpak    Extract .pak archives into folders (a directory target is scanned
           recursively for .pak files). Multiple .pak files run in parallel on a
           worker pool sized to the CPU effort.
  repak    Build .pak archives from folders. Multiple folders run in parallel on
           a worker pool sized to the CPU effort.
  decrypt  Decrypt AION-encoded XML/HTML files inside folders (in place).
           Multiple folders run in parallel on a worker pool sized to the effort.

Options:
  -o, --out <path>   unpak: base output directory (default: beside each .pak).
                     repak: output .pak file, or a directory (default: beside
                     each source folder as <folder>.pak).
  --effort <mode>    CPU effort: low|medium|high|extreme|manual. Sizes the worker
                     pool (30%/60%/90%/100% of logical cores; manual uses
                     --threads). Default: the value in settings.json.
  --threads <n>      Thread count for manual effort (implies --effort manual).
  --decrypt          unpak: decrypt extracted XML/HTML files in place.
  --simple-zip       repak: build a simple zip-style .pak instead of AION.
  -h, --help         Show this help.

Examples:
  npm run cli -- unpak PAKS/pak/data.pak
  npm run cli -- unpak PAKS/pak -o PAKS/unpaked --decrypt
  npm run cli -- repak PAKS/unpaked/data_ptbr -o PAKS/repaked/data_ptbr.pak
  npm run cli -- decrypt PAKS/unpaked/data_ptbr
  npm run cli -- unpak PAKS/pak --effort extreme
  npm run cli -- repak PAKS/unpaked/data_ptbr --effort manual --threads 6
`

type Command = 'unpak' | 'repak' | 'decrypt' | 'help'

const CPU_EFFORTS: readonly CpuEffort[] = ['low', 'medium', 'high', 'extreme', 'manual']

function isCpuEffort(value: unknown): value is CpuEffort {
	return typeof value === 'string' && (CPU_EFFORTS as readonly string[]).includes(value)
}

interface Options {
	command: Command
	targets: string[]
	out?: string
	decrypt: boolean
	simpleZip: boolean
	effort?: CpuEffort
	threads?: number
}

function parseArgs(argv: string[]): Options {
	const opts: Options = { command: 'help', targets: [], decrypt: false, simpleZip: false }
	const positional: string[] = []
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string
		if (arg === '-h' || arg === '--help') return { ...opts, command: 'help' }
		if (arg === '-o' || arg === '--out') {
			opts.out = argv[++i]
		} else if (arg.startsWith('--out=')) {
			opts.out = arg.slice('--out='.length)
		} else if (arg === '--effort' || arg.startsWith('--effort=')) {
			const value = arg.startsWith('--effort=') ? arg.slice('--effort='.length) : argv[++i]
			if (!isCpuEffort(value)) {
				throw new Error(`Invalid --effort: ${String(value)} (expected low|medium|high|extreme|manual)`)
			}
			opts.effort = value
		} else if (arg === '--threads' || arg.startsWith('--threads=')) {
			const raw = arg.startsWith('--threads=') ? arg.slice('--threads='.length) : argv[++i]
			const value = Number(raw)
			if (!Number.isFinite(value) || value < 1) {
				throw new Error(`Invalid --threads: ${String(raw)} (expected a positive integer)`)
			}
			opts.threads = Math.floor(value)
		} else if (arg === '--decrypt') {
			opts.decrypt = true
		} else if (arg === '--simple-zip') {
			opts.simpleZip = true
		} else {
			positional.push(arg)
		}
	}

	const command = positional[0]
	if (command === 'unpak' || command === 'repak' || command === 'decrypt') {
		opts.command = command
		opts.targets = positional.slice(1)
	} else if (command === undefined || command === 'help') {
		opts.command = 'help'
	} else {
		throw new Error(`Unknown command: ${command}`)
	}
	return opts
}

function pakBaseName(pakPath: string): string {
	const base = path.basename(pakPath)
	return base.toLowerCase().endsWith('.pak') ? base.slice(0, -4) : base
}

/** Expands file/directory targets into a list of absolute .pak paths. */
function collectPakFiles(targets: string[]): string[] {
	const results: string[] = []
	for (const target of targets) {
		const resolved = path.resolve(target)
		if (!existsSync(resolved)) throw new Error(`Not found: ${target}`)
		const stat = statSync(resolved)
		if (stat.isFile()) {
			results.push(resolved)
			continue
		}
		if (!stat.isDirectory()) continue
		const walk = (dir: string): void => {
			for (const name of readdirSync(dir)) {
				const full = path.join(dir, name)
				let child: ReturnType<typeof statSync>
				try {
					child = statSync(full)
				} catch {
					continue
				}
				if (child.isDirectory()) walk(full)
				else if (child.isFile() && name.toLowerCase().endsWith('.pak')) results.push(full)
			}
		}
		walk(resolved)
	}
	results.sort((a, b) => a.localeCompare(b))
	return results
}

// Windows GUI builds have no console attached: writing to stdout/stderr can
// throw EBADF. Swallow failures so `app.exe cli …` never crashes; when output
// is redirected to a file the writes succeed normally.
function out(text: string): void {
	try {
		process.stdout.write(text)
	} catch {
		/* no console attached */
	}
}

function err(text: string): void {
	try {
		process.stderr.write(text)
	} catch {
		/* no console attached */
	}
}

function makeProgress(label: string, enabled = true): (percent: number) => void {
	if (!enabled) return () => {}
	let last = -1
	return (percent: number): void => {
		const value = Math.max(0, Math.min(100, Math.round(percent)))
		if (value === last) return
		last = value
		out(`\r${label} ${String(value).padStart(3, ' ')}%`)
	}
}

function resolveUnpakOutput(pakPath: string, out: string | undefined): string {
	const name = pakBaseName(pakPath)
	if (out) return path.join(path.resolve(out), name)
	return path.join(path.dirname(pakPath), name)
}

function resolveRepakOutput(folder: string, out: string | undefined, singleTarget: boolean): string {
	if (out) {
		const resolved = path.resolve(out)
		if (singleTarget && resolved.toLowerCase().endsWith('.pak')) return resolved
		return path.join(resolved, `${path.basename(folder)}.pak`)
	}
	return `${folder}.pak`
}

function requireFolder(target: string): string {
	const folder = path.resolve(target)
	if (!existsSync(folder) || !statSync(folder).isDirectory()) {
		throw new Error(`Folder not found: ${target}`)
	}
	return folder
}

/** Runs a RePAK pool task, forwarding per-file progress through a MessagePort. */
async function runRepakTaskWithProgress(
	pool: Piscina<RepakTaskInput, RepakTaskResult>,
	input: Omit<RepakTaskInput, 'port'>,
	onPercent: (percent: number) => void,
): Promise<void> {
	const channel = new MessageChannel()
	const { port1, port2 } = channel
	const messageHandler = (msg: unknown): void => {
		if (!msg || typeof msg !== 'object') return
		const m = msg as Record<string, unknown>
		if (m['type'] !== 'progress') return
		if (typeof m['percent'] === 'number') onPercent(m['percent'] as number)
	}
	try {
		;(port1 as unknown as { on: (ev: string, cb: (m: unknown) => void) => void }).on('message', messageHandler)
	} catch {
		// ignore
	}
	try {
		await pool.run(
			{ ...input, port: port2 } as RepakTaskInput,
			{ transferList: [port2] } as unknown as Parameters<typeof pool.run>[1],
		)
	} finally {
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
		try {
			;(port2 as unknown as { close?: () => void }).close?.()
		} catch {
			// ignore
		}
	}
}

async function runUnpak(opts: Options): Promise<void> {
	const pakFiles = collectPakFiles(opts.targets)
	if (pakFiles.length === 0) throw new Error('No .pak files found in the given targets')
	const threads = cpuThreadsForWork()
	const multi = pakFiles.length > 1
	const jobs = pakFiles.map((pak, i) => {
		const outputFolder = resolveUnpakOutput(pak, opts.out)
		out(`UnPAK ${pak}\n  -> ${outputFolder}\n`)
		return {
			pakPath: pak,
			outputFolder,
			packageName: path.basename(pak),
			packageIndex: i + 1,
			packageTotal: pakFiles.length,
		}
	})
	const pool = new Piscina<UnpakTaskInput, UnpakTaskResult>({
		filename: resolveUnpakWorkerFile(),
		maxThreads: threads,
	})
	const progress = makeProgress('  ', !multi)
	try {
		const outcomes = await extractPaksParallel(jobs, pool, threads, (p) => progress(p.percent ?? 0), undefined)
		for (const o of outcomes) {
			if (!o.ok) err(`  failed ${o.job.packageName}: ${o.error}\n`)
		}
	} finally {
		await pool.destroy()
	}
	if (!multi) out('\n')

	if (opts.decrypt) {
		const outputFolders = jobs.map((j) => j.outputFolder)
		const decryptPool = createDecryptPool()
		try {
			await mapPool(outputFolders, Math.min(threads, outputFolders.length), async (folder) => {
				out(`Decrypt ${folder}\n`)
				const decryptProgress = makeProgress('  ', !multi)
				const result = await decryptFolderParallel(folder, {
					pool: decryptPool,
					onProgress: (p) => decryptProgress(p.percent ?? 0),
				})
				if (!multi) out('\n')
				out(`  decrypted ${result.success.length} file(s)\n`)
			})
		} finally {
			await decryptPool.destroy()
		}
	}
}

async function runDecrypt(opts: Options): Promise<void> {
	const folders = opts.targets.map(requireFolder)
	const threads = cpuThreadsForWork()
	const multi = folders.length > 1
	const pool = createDecryptPool()
	try {
		await mapPool(folders, Math.min(threads, folders.length), async (folder) => {
			out(`Decrypt ${folder}\n`)
			const progress = makeProgress('  ', !multi)
			const result = await decryptFolderParallel(folder, {
				pool,
				onProgress: (p) => progress(p.percent ?? 0),
			})
			if (!multi) out('\n')
			out(`  decrypted ${result.success.length} file(s)\n`)
		})
	} finally {
		await pool.destroy()
	}
}

async function runRepak(opts: Options): Promise<void> {
	const single = opts.targets.length === 1
	const folders = opts.targets.map(requireFolder)
	const threads = cpuThreadsForWork()

	if (opts.simpleZip) {
		for (const folder of folders) {
			const outPak = resolveRepakOutput(folder, opts.out, single)
			out(`RePAK ${folder}\n  -> ${outPak}\n`)
			const progress = makeProgress('  ')
			await createSimpleZipPak(folder, outPak, (info) => progress(info.percent), undefined, threads)
			out('\n')
		}
		return
	}

	const multi = folders.length > 1
	const pool = new Piscina<RepakTaskInput, RepakTaskResult>({
		filename: resolveRepakWorkerFile(),
		maxThreads: threads,
	})
	// Split the effort budget across folders: workers × inner ≤ threads.
	const inner = innerConcurrency(folders.length)
	try {
		await mapPool(folders, Math.min(threads, folders.length), async (folder) => {
			const outPak = resolveRepakOutput(folder, opts.out, single)
			out(`RePAK ${folder}\n  -> ${outPak}\n`)
			const progress = makeProgress('  ', !multi)
			await runRepakTaskWithProgress(
				pool,
				{ inputFolder: folder, outputPak: outPak, version: 0, concurrency: inner },
				(percent) => progress(percent),
			)
			if (!multi) out('\n')
		})
	} finally {
		await pool.destroy()
	}
}

/** Runs a CLI command. Returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
	try {
		const opts = parseArgs(argv)
		if (opts.command === 'help') {
			out(USAGE)
			return 0
		}
		if (opts.targets.length === 0) {
			err(`Missing target.\n\n${USAGE}`)
			return 1
		}

		// Effective effort for this run: explicit flags win, else settings.json.
		// `--threads` implies manual effort.
		const settings = loadSettings()
		let effort: CpuEffort = opts.effort ?? settings.cpuEffort ?? 'high'
		if (opts.threads != null) effort = 'manual'
		const threads = resolveCpuThreads(effort, opts.threads ?? settings.manualCpuThreads)
		setThreadsOverride(threads)
		out(`CPU effort: ${effort} (${threads} thread${threads === 1 ? '' : 's'})\n`)

		if (opts.command === 'unpak') await runUnpak(opts)
		else if (opts.command === 'decrypt') await runDecrypt(opts)
		else await runRepak(opts)
		return 0
	} catch (error) {
		err(`\nError: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}
