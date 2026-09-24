import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import {
	PAK_DIR,
	REPAKED_DIR,
	UNPAKED_DIR,
	ROOT_DIR,
	findPakFiles,
	findRepakedPaks,
	findRootFoldersInFiles,
	findUnpakedFolders,
} from '../services/paths'
import { countEntriesDetailed, countRepakedFiles, listPakDatabases } from '../services/counts'
import { listFilesInPak } from '../core/unpak'
import {
	addFilesToRepakedPak,
	decryptPackages,
	deleteRepakedPakEntries,
	repackPackages,
	unpackAndDecryptPakEntries,
	unpackAndDecryptPackages,
	unpackPackages,
	unpackPakEntries,
	type PakServiceOptions,
} from '../services/pak-service'
import {
	decryptTranslations,
	extractFolder,
	repackTranslations,
} from '../services/translation-service'
import { loadSettings, saveSettings } from '../services/settings'
import { totalCpuThreads } from '../services/threads'
import { checkForUpdates, RELEASES_URL } from '../services/update-check'
import { downloadUpdate, getUpdateState, installUpdate, setUpdateStateSender } from '../services/updater'
import {
	createProgressSender,
	errorMessage,
	isAbortError,
	type ProgressCallback,
} from '../services/progress'
import { cancelZipPak } from '../core/repak'
import type { AppSettings, ConflictChoice, ExtractConflictRequest, PakDatabasePakEntry } from '../../shared/api-types'

type GetMainWindow = () => BrowserWindow | null

let activeAbortController: AbortController | null = null

interface PendingConflict {
	requestId: number;
	resolve: (choice: ConflictChoice) => void;
}

let pendingConflict: PendingConflict | null = null
let conflictRequestSeq = 0

const CONFLICT_CHOICES = ['overwrite', 'overwrite-all', 'skip', 'skip-all', 'cancel'] as const

function isConflictChoice(value: unknown): value is ConflictChoice {
	return typeof value === 'string' && (CONFLICT_CHOICES as readonly string[]).includes(value)
}

/** Resolves the awaited conflict prompt (if any) with the given choice. */
function settleConflict(choice: ConflictChoice): boolean {
	const pending = pendingConflict
	if (!pending) return false
	pendingConflict = null
	pending.resolve(choice)
	return true
}

/** Asks the renderer how to handle a `.pak` already present in the manifest. */
function requestConflict(
	getMainWindow: GetMainWindow,
	request: ExtractConflictRequest,
): Promise<ConflictChoice> {
	const requestId = ++conflictRequestSeq
	return new Promise<ConflictChoice>((resolve) => {
		pendingConflict = { requestId, resolve }
		const win = getMainWindow()
		if (!win || win.isDestroyed()) {
			pendingConflict = null
			resolve('cancel')
			return
		}
		win.webContents.send('app-conflict', { ...request, requestId })
	})
}

function toCloneable<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

/** Recursive file listing of a folder as posix-relative paths (structure view). */
async function listFolderFiles(root: string): Promise<string[]> {
	const results: string[] = []
	async function walk(dir: string, rel: string): Promise<void> {
		let entries: import('fs').Dirent[]
		try {
			entries = await readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (entry.name === '.pak-metadata.json' || entry.name === '._tmp_repack') continue
			const relPath = rel ? `${rel}/${entry.name}` : entry.name
			if (entry.isDirectory()) {
				await walk(path.join(dir, entry.name), relPath)
			} else if (entry.isFile()) {
				results.push(relPath)
			}
		}
	}
	await walk(root, '')
	return results
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function readDirOverride(payload: unknown, key: string): string | undefined {
	if (!isRecord(payload)) return undefined
	const value = payload[key]
	return typeof value === 'string' && value.trim().length > 0 ? path.resolve(value.trim()) : undefined
}

function customDirFromSettings(key: 'pak' | 'unpaked' | 'repaked'): string | undefined {
	const value = loadSettings().customDirs?.[key]
	return typeof value === 'string' && value.trim().length > 0 ? path.resolve(value.trim()) : undefined
}

/** Effective extraction output root: payload override > settings custom dir > /PAKS/unpaked. */
function resolveUnpakedDir(payload: unknown): string {
	return readDirOverride(payload, 'unpakedDir') ?? customDirFromSettings('unpaked') ?? UNPAKED_DIR
}

/** Effective RePAK output root: payload override > settings custom dir > /PAKS/repaked. */
function resolveRepakedDir(payload: unknown): string {
	return readDirOverride(payload, 'repakedDir') ?? customDirFromSettings('repaked') ?? REPAKED_DIR
}

/** Effective source PAK root: payload override > settings custom dir > /PAKS/pak. */
function resolvePakDir(payload: unknown): string {
	return readDirOverride(payload, 'pakDir') ?? customDirFromSettings('pak') ?? PAK_DIR
}

/** Custom dirs resolved from settings only (used to widen access checks). */
function settingsCustomBases(): string[] {
	const bases: string[] = []
	for (const key of ['pak', 'unpaked', 'repaked'] as const) {
		const dir = customDirFromSettings(key)
		if (dir) bases.push(dir)
	}
	return bases
}

function extractPathsAndShowFileProgress(
	payload: unknown,
	pathsKey = 'paths',
): { paths: string[]; showFileProgress: boolean } {
	let paths: string[] = []
	if (Array.isArray(payload)) {
		paths = payload
	} else if (isRecord(payload) && Array.isArray(payload[pathsKey])) {
		paths = payload[pathsKey] as string[]
	}
	const showFileProgress =
		isRecord(payload) && typeof payload.showFileProgress === 'boolean'
			? payload.showFileProgress
			: true
	return { paths, showFileProgress }
}

function extractPakEntriesPayload(payload: unknown): { pakPath: string; entries: string[]; showFileProgress: boolean } {
	const pakPath = isRecord(payload) && typeof payload.pakPath === 'string' ? payload.pakPath : ''
	const entries =
		isRecord(payload) && Array.isArray(payload.entries)
			? (payload.entries as unknown[]).filter((value): value is string => typeof value === 'string')
			: []
	const showFileProgress =
		isRecord(payload) && typeof payload.showFileProgress === 'boolean'
			? payload.showFileProgress
			: true
	return { pakPath, entries, showFileProgress }
}

function makeProgressSender(
	getMainWindow: GetMainWindow,
	showFileProgress: boolean,
): ProgressCallback {
	return createProgressSender((payload) => {
		const win = getMainWindow()
		if (win && !win.isDestroyed()) {
			win.webContents.send('app-progress', payload)
		}
	}, () => {
		// Live toggle: the renderer persists `showFileNames` on every change, so
		// reading it per flush lets the user enable/disable mid-operation.
		const setting = loadSettings().showFileNames
		return setting === undefined ? showFileProgress : setting
	})
}

interface OperationResult {
	success: boolean;
	results?: unknown;
	canceled?: boolean;
	error?: string;
}

async function runOperation(
	getMainWindow: GetMainWindow,
	showFileProgress: boolean,
	run: (onProgress: ProgressCallback, signal: AbortSignal) => Promise<unknown>,
): Promise<OperationResult> {
	if (activeAbortController) {
		return { success: false, error: 'Another action is already running.' }
	}

	const controller = new AbortController()
	activeAbortController = controller
	const onProgress = makeProgressSender(getMainWindow, showFileProgress)

	try {
		const results = await run(onProgress, controller.signal)
		return toCloneable({ success: true, results })
	} catch (error) {
		if (controller.signal.aborted || isAbortError(error)) {
			return { success: false, canceled: true, error: 'Operation canceled' }
		}
		return { success: false, error: errorMessage(error) }
	} finally {
		if (activeAbortController === controller) {
			activeAbortController = null
		}
	}
}

function pakOptions(onProgress: ProgressCallback, signal: AbortSignal, payload?: unknown): PakServiceOptions {
	return {
		onProgress,
		signal,
		unpakedDir: readDirOverride(payload, 'unpakedDir'),
		repakedDir: readDirOverride(payload, 'repakedDir'),
		pakDir: readDirOverride(payload, 'pakDir'),
	}
}

async function openFolder(dir: string): Promise<OperationResult> {
	try {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true })
		}
		const openError = await shell.openPath(dir)
		if (openError) {
			return { success: false, error: openError }
		}
		return { success: true }
	} catch (error) {
		return { success: false, error: errorMessage(error) }
	}
}

export function registerIpcHandlers(getMainWindow: GetMainWindow): void {
	setUpdateStateSender((state) => {
		const win = getMainWindow()
		if (win && !win.isDestroyed()) win.webContents.send('app-update-state', state)
	})

	ipcMain.handle('scan-paks', async (_event, payload) => {
		try {
			const dir = isRecord(payload) && typeof payload.dir === 'string' && payload.dir.length > 0 ? payload.dir : PAK_DIR
			const pakFiles = findPakFiles(dir)
			const rootFolders = findRootFoldersInFiles(dir)
			return { success: true, pakFiles, rootFolders }
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('scan-unpaked', async (_event, payload) => {
		try {
			const unpakedDir =
				isRecord(payload) && typeof payload.unpakedDir === 'string' && payload.unpakedDir.length > 0
					? payload.unpakedDir
					: UNPAKED_DIR
			const repakedDir =
				isRecord(payload) && typeof payload.repakedDir === 'string' && payload.repakedDir.length > 0
					? payload.repakedDir
					: REPAKED_DIR
			const unpakedFolders = findUnpakedFolders(unpakedDir)
			const repakedFiles = findRepakedPaks(repakedDir)
			const repakedCount = await countRepakedFiles(repakedDir)
			return { success: true, unpakedFolders, repakedFiles, repakedCount }
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('count-entries', async (_event, payload) => {
		try {
			const paths = isRecord(payload) && Array.isArray(payload.paths)
				? payload.paths.filter((value): value is string => typeof value === 'string')
				: []
			const kind =
				isRecord(payload) && payload.kind === 'folder'
					? 'folder'
					: isRecord(payload) && payload.kind === 'pakFolder'
						? 'pakFolder'
						: isRecord(payload) && payload.kind === 'repaked'
							? 'repaked'
							: 'pak'
			const base = path.resolve(
				isRecord(payload) && typeof payload.base === 'string' && payload.base.length > 0
					? payload.base
					: kind === 'folder' ? UNPAKED_DIR : kind === 'repaked' ? REPAKED_DIR : PAK_DIR,
			)
			const safePaths = paths.filter((entryPath) => {
				const resolved = path.resolve(entryPath)
				return resolved.startsWith(base + path.sep)
			})
			const detailed = await countEntriesDetailed(safePaths, kind)
			return { success: true, counts: detailed.counts, sizes: detailed.sizes }
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('list-pak-contents', async (_event, payload) => {
		try {
			const pakPath = isRecord(payload) && typeof payload.pakPath === 'string' ? payload.pakPath : ''
			if (!pakPath) throw new Error('No pak path provided')
			const resolved = path.resolve(pakPath)
			const allowedBases = [path.resolve(PAK_DIR), path.resolve(REPAKED_DIR), path.resolve(UNPAKED_DIR)]
			if (isRecord(payload) && typeof payload.base === 'string' && payload.base.length > 0) {
				allowedBases.push(path.resolve(payload.base))
			}
			if (!allowedBases.some((base) => resolved.startsWith(base + path.sep))) {
				throw new Error('Access denied: pak path outside PAK directories')
			}
			const statEntry = await stat(resolved).catch(() => null)
			if (statEntry?.isDirectory()) {
				return { success: true, files: await listFolderFiles(resolved) }
			}
			return { success: true, files: await listFilesInPak(resolved) }
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('list-pak-databases', async (_event, payload) => {
		try {
			const dir = readDirOverride(payload, 'unpakedDir') ?? customDirFromSettings('unpaked') ?? UNPAKED_DIR
			const databases = await listPakDatabases(dir, ROOT_DIR)
			return { success: true, databases }
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('read-pak-database', async (_event, payload) => {
		try {
			const dbPath = isRecord(payload) && typeof payload.dbPath === 'string'
				? payload.dbPath
				: typeof payload === 'string' ? payload : ''
			if (!dbPath) throw new Error('No database path provided')
			const resolved = path.resolve(dbPath)
			const allowedBases = [path.resolve(UNPAKED_DIR), ...settingsCustomBases()]
			const payloadBase = readDirOverride(payload, 'base')
			if (payloadBase) allowedBases.push(payloadBase)
			const inside = allowedBases.some((base) => resolved === base || resolved.startsWith(base + path.sep))
			if (!inside) {
				throw new Error('Access denied: database path outside unpaked directory')
			}
			const raw = JSON.parse(await readFile(resolved, 'utf8')) as Record<string, unknown>
			let files: string[] = []
			let relPakPath = typeof raw['relPakPath'] === 'string' ? (raw['relPakPath'] as string) : undefined
			const folderName = typeof raw['folderName'] === 'string' ? (raw['folderName'] as string) : undefined
			// Aggregate full-folder DB (versions 3/4 with `paks[]`): expose each entry
			// so the DbModal can render the reconstructed structure (pak nodes with
			// their original files nested underneath). Also flatten into `files` for
			// backwards compatibility. v4 entries store `destDir` (relative to
			// unpaked, may be `''`); v3 entries prefix with `relPakPath/` (the legacy
			// `<name>.pak/` wrapper).
			const paks: PakDatabasePakEntry[] = []
			if (Array.isArray(raw['paks'])) {
				for (const entry of raw['paks'] as unknown[]) {
					if (!isRecord(entry)) continue
					const rel = typeof entry['relPakPath'] === 'string' ? (entry['relPakPath'] as string) : ''
					if (!rel) continue
					const destDir = typeof entry['destDir'] === 'string' ? (entry['destDir'] as string) : undefined
					const entryFiles = Array.isArray(entry['files'])
						? (entry['files'] as unknown[]).filter((f): f is string => typeof f === 'string')
						: []
					const prefix = destDir !== undefined ? destDir : rel
					for (const f of entryFiles) {
						files.push(prefix ? `${prefix}/${f}` : f)
					}
					paks.push({
						relPakPath: rel,
						destDir,
						files: entryFiles,
						fileCount: typeof entry['fileCount'] === 'number'
							? (entry['fileCount'] as number)
							: entryFiles.length,
					})
				}
				relPakPath = folderName ?? relPakPath
			} else {
				files = Array.isArray(raw['files'])
					? (raw['files'] as unknown[]).filter((f): f is string => typeof f === 'string')
					: []
			}
			return {
				success: true,
				info: {
					relPakPath,
					folderName,
					version: typeof raw['version'] === 'number' ? raw['version'] as number : undefined,
					files,
					paks: paks.length > 0 ? paks : undefined,
					sourcePak: typeof raw['sourcePak'] === 'string' ? raw['sourcePak'] as string : undefined,
					outputFolder: typeof raw['outputFolder'] === 'string' ? raw['outputFolder'] as string : undefined,
					destDir: typeof raw['destDir'] === 'string' ? raw['destDir'] as string : undefined,
					createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] as string : undefined,
				},
			}
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('select-folder', async () => {
		try {
			const result = await dialog.showOpenDialog({
				title: 'Select folder',
				properties: ['openDirectory'],
			})
			if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
				return { success: false, canceled: true }
			}
			return { success: true, folderPath: result.filePaths[0] }
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('unpak-packages', (_event, payload) => {
		const { paths, showFileProgress } = extractPathsAndShowFileProgress(payload)
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			unpackPackages(paths, pakOptions(onProgress, signal, payload)),
		)
	})

	ipcMain.handle('unpak-decrypt-packages', (_event, payload) => {
		const { paths, showFileProgress } = extractPathsAndShowFileProgress(payload)
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			unpackAndDecryptPackages(paths, pakOptions(onProgress, signal, payload)),
		)
	})

	ipcMain.handle('unpak-pak-entries', (_event, payload) => {
		const { pakPath, entries, showFileProgress } = extractPakEntriesPayload(payload)
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			unpackPakEntries(pakPath, entries, pakOptions(onProgress, signal, payload)),
		)
	})

	ipcMain.handle('unpak-decrypt-pak-entries', (_event, payload) => {
		const { pakPath, entries, showFileProgress } = extractPakEntriesPayload(payload)
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			unpackAndDecryptPakEntries(pakPath, entries, pakOptions(onProgress, signal, payload)),
		)
	})

	ipcMain.handle('decrypt-packages', (_event, payload) => {
		const { paths, showFileProgress } = extractPathsAndShowFileProgress(payload)
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			decryptPackages(paths, pakOptions(onProgress, signal, payload)),
		)
	})

	ipcMain.handle('repack-packages', (_event, payload) => {
		const { paths, showFileProgress } = extractPathsAndShowFileProgress(payload)
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			repackPackages(paths, pakOptions(onProgress, signal, payload)),
		)
	})

	ipcMain.handle('extract-folder', (_event, payload) => {
		const showFileProgress =
			isRecord(payload) && typeof payload.showFileProgress === 'boolean'
				? payload.showFileProgress
				: true
		return runOperation(getMainWindow, showFileProgress, async (onProgress, signal) => {
			const inputFolder = isRecord(payload) && payload.inputFolder ? String(payload.inputFolder) : ''
			if (!inputFolder) {
				throw new Error('No input folder provided')
			}

			return await extractFolder(
				{
					inputFolder,
					includeNonPak: isRecord(payload) && 'includeNonPak' in payload ? Boolean(payload.includeNonPak) : true,
					overwrite: isRecord(payload) ? Boolean(payload.overwrite) : false,
				},
				{
					onProgress,
					signal,
					onConflict: (request) => requestConflict(getMainWindow, request),
					unpakedDir: resolveUnpakedDir(payload),
					pakDir: resolvePakDir(payload),
				},
			)
		})
	})

	ipcMain.handle('resolve-conflict', async (_event, payload) => {
		const requestId =
			isRecord(payload) && typeof payload.requestId === 'number' ? payload.requestId : Number.NaN
		const choice = isRecord(payload) ? payload.choice : undefined
		if (!pendingConflict || pendingConflict.requestId !== requestId) {
			return { success: false, error: 'No matching conflict request' }
		}
		if (!isConflictChoice(choice)) {
			return { success: false, error: 'Invalid conflict choice' }
		}
		if (choice === 'cancel') {
			activeAbortController?.abort()
		}
		settleConflict(choice)
		return { success: true }
	})

	ipcMain.handle('decrypt-unpaked', (_event, payload) => {
		const { paths, showFileProgress } = extractPathsAndShowFileProgress(payload)
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			decryptTranslations(paths, { onProgress, signal }),
		)
	})

	ipcMain.handle('repack-unpaked', (_event, payload) => {
		const rawPaths =
			isRecord(payload) && Array.isArray(payload.selectedFolderPaths)
				? (payload.selectedFolderPaths as unknown[])
				: []
		const selectedFolderPaths = rawPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
		const showFileProgress =
			isRecord(payload) && typeof payload.showFileProgress === 'boolean'
				? payload.showFileProgress
				: true
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			repackTranslations(selectedFolderPaths, {
				onProgress,
				signal,
				unpakedDir: resolveUnpakedDir(payload),
				repakedDir: resolveRepakedDir(payload),
			}),
		)
	})

	ipcMain.handle('add-files-to-pak', (_event, payload) => {
		const pakPath = isRecord(payload) && typeof payload.pakPath === 'string' ? payload.pakPath : ''
		const sourcePaths =
			isRecord(payload) && Array.isArray(payload.sourcePaths)
				? (payload.sourcePaths as unknown[]).filter((value): value is string => typeof value === 'string' && value.length > 0)
				: []
		const overwrite = isRecord(payload) ? payload.overwrite === true : false
		const targetFolder = isRecord(payload) && typeof payload.targetFolder === 'string' ? payload.targetFolder : undefined
		const base = isRecord(payload) && typeof payload.base === 'string' && payload.base.length > 0 ? payload.base : undefined
		const showFileProgress =
			isRecord(payload) && typeof payload.showFileProgress === 'boolean'
				? payload.showFileProgress
				: true
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			addFilesToRepakedPak(pakPath, sourcePaths, { onProgress, signal, overwrite, targetFolder, base }),
		)
	})

	ipcMain.handle('delete-pak-entries', (_event, payload) => {
		const pakPath = isRecord(payload) && typeof payload.pakPath === 'string' ? payload.pakPath : ''
		const entries =
			isRecord(payload) && Array.isArray(payload.entries)
				? (payload.entries as unknown[]).filter((value): value is string => typeof value === 'string' && value.length > 0)
				: []
		const base = isRecord(payload) && typeof payload.base === 'string' && payload.base.length > 0 ? payload.base : undefined
		const showFileProgress =
			isRecord(payload) && typeof payload.showFileProgress === 'boolean'
				? payload.showFileProgress
				: true
		return runOperation(getMainWindow, showFileProgress, (onProgress, signal) =>
			deleteRepakedPakEntries(pakPath, entries, { onProgress, signal, base }),
		)
	})

	ipcMain.handle('open-repaked-folder', async () => {
		return openFolder(REPAKED_DIR)
	})

	ipcMain.handle('open-pak-folder', async () => {
		return openFolder(PAK_DIR)
	})

	ipcMain.handle('open-unpaked-folder', async () => {
		return openFolder(UNPAKED_DIR)
	})

	ipcMain.handle('open-folder', async (_event, payload) => {
		const dir = isRecord(payload) && typeof payload.dir === 'string' ? payload.dir : ''
		if (!dir) {
			return { success: false, error: 'No folder provided' }
		}
		return openFolder(dir)
	})

	ipcMain.handle('settings-get', async () => {
		try {
			return {
				success: true,
				settings: toCloneable(loadSettings()),
				totalThreads: totalCpuThreads(),
			}
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('settings-set', async (_event, payload) => {
		try {
			if (!isRecord(payload)) throw new Error('Invalid settings payload')
			const patch: AppSettings = {}
			if (typeof payload.locale === 'string') patch.locale = payload.locale
			if (typeof payload.showFileNames === 'boolean') patch.showFileNames = payload.showFileNames
			if (typeof payload.rememberWindowBounds === 'boolean') {
				patch.rememberWindowBounds = payload.rememberWindowBounds
			}
			if (
				typeof payload.cpuEffort === 'string' &&
				(['low', 'medium', 'high', 'extreme', 'manual'] as const).includes(payload.cpuEffort as 'low')
			) {
				patch.cpuEffort = payload.cpuEffort as AppSettings['cpuEffort']
			}
			if (typeof payload.manualCpuThreads === 'number' && Number.isFinite(payload.manualCpuThreads)) {
				patch.manualCpuThreads = Math.max(1, Math.floor(payload.manualCpuThreads))
			}
			if (isRecord(payload.customDirs)) {
				const dirs: NonNullable<AppSettings['customDirs']> = {}
				for (const key of ['pak', 'unpaked', 'repaked'] as const) {
					const value = payload.customDirs[key]
					if (typeof value === 'string') dirs[key] = value
				}
				if (Object.keys(dirs).length > 0) patch.customDirs = dirs
			}
			const settings = saveSettings(patch)
			return { success: true, settings: toCloneable(settings) }
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('check-update', async (_event, payload) => {
		const force = isRecord(payload) ? payload.force === true : false
		return checkForUpdates(force)
	})

	ipcMain.handle('open-releases', async () => {
		try {
			await shell.openExternal(RELEASES_URL)
			return { success: true }
		} catch (error) {
			return { success: false, error: errorMessage(error) }
		}
	})

	ipcMain.handle('update-get-state', async () => getUpdateState())

	ipcMain.handle('update-download', async () => {
		try {
			const state = await downloadUpdate()
			return { success: state.status !== 'error', state, error: state.error }
		} catch (error) {
			return { success: false, state: getUpdateState(), error: errorMessage(error) }
		}
	})

	ipcMain.handle('update-install', async () => {
		try {
			installUpdate()
			return { success: true, state: getUpdateState() }
		} catch (error) {
			return { success: false, state: getUpdateState(), error: errorMessage(error) }
		}
	})

	ipcMain.handle('cancel-action', async () => {
		if (!activeAbortController) {
			return { success: false, error: 'No active action to cancel' }
		}
		settleConflict('cancel')
		activeAbortController.abort()
		cancelZipPak()
		const win = getMainWindow()
		if (win && !win.isDestroyed()) {
			win.webContents.send('app-progress', { stage: 'canceled', percent: 0 })
		}
		return { success: true }
	})
}
