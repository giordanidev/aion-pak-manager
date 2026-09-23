import { contextBridge, ipcRenderer } from 'electron'
import type {
	AddFilesToPakPayload,
	AppSettings,
	CancelActionResult,
	CheckUpdateResult,
	ConflictRequest,
	CountEntriesResult,
	DeletePakEntriesPayload,
	ElectronApi,
	ExtractFolderPayload,
	ExtractFolderResult,
	ListPakContentsResult,
	ListPakDatabasesResult,
	OpenFolderResult,
	OperationResult,
	ProgressPayload,
	ProgressOptions,
	ReadPakDatabaseResult,
	RepackUnpakedPayload,
	ResolveConflictPayload,
	ResolveConflictResult,
	ScanPaksResult,
	ScanUnpakedResult,
	SelectFolderResult,
	SettingsResult,
} from '../../shared/api-types'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function readShowFileProgress(opts: unknown): boolean | undefined {
	if (isRecord(opts) && typeof opts.showFileProgress === 'boolean') {
		return opts.showFileProgress
	}
	return undefined
}

function readDirOption(opts: unknown, key: 'unpakedDir' | 'pakDir' | 'repakedDir'): string | undefined {
	if (isRecord(opts) && typeof opts[key] === 'string' && (opts[key] as string).length > 0) {
		return opts[key] as string
	}
	return undefined
}

function toCloneable<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

export function buildElectronApi(): ElectronApi {
	return {
		scanPaks: (dir?: string): Promise<ScanPaksResult> => ipcRenderer.invoke('scan-paks', toCloneable({ dir })),
		scanUnpaked: (unpakedDir?: string, repakedDir?: string): Promise<ScanUnpakedResult> =>
			ipcRenderer.invoke('scan-unpaked', toCloneable({ unpakedDir, repakedDir })),
		countEntries: (paths: string[], kind: 'pak' | 'folder' | 'repaked', base?: string): Promise<CountEntriesResult> =>
			ipcRenderer.invoke('count-entries', toCloneable({ paths: Array.from(paths), kind, base })),
		selectFolder: (): Promise<SelectFolderResult> => ipcRenderer.invoke('select-folder'),

		listPakContents: (pakPath: string, base?: string): Promise<ListPakContentsResult> =>
			ipcRenderer.invoke('list-pak-contents', toCloneable({ pakPath, base })),

		unpakPackages: (paths: string[], opts?: ProgressOptions): Promise<OperationResult> =>
			ipcRenderer.invoke('unpak-packages', toCloneable({ paths: Array.from(paths), showFileProgress: readShowFileProgress(opts), unpakedDir: readDirOption(opts, 'unpakedDir'), pakDir: readDirOption(opts, 'pakDir') })),

		unpakDecryptPackages: (paths: string[], opts?: ProgressOptions): Promise<OperationResult> =>
			ipcRenderer.invoke('unpak-decrypt-packages', toCloneable({ paths: Array.from(paths), showFileProgress: readShowFileProgress(opts), unpakedDir: readDirOption(opts, 'unpakedDir'), pakDir: readDirOption(opts, 'pakDir') })),

		unpakPakEntries: (pakPath: string, entries: string[], opts?: ProgressOptions): Promise<OperationResult> =>
			ipcRenderer.invoke('unpak-pak-entries', toCloneable({ pakPath, entries: Array.from(entries), showFileProgress: readShowFileProgress(opts), unpakedDir: readDirOption(opts, 'unpakedDir'), pakDir: readDirOption(opts, 'pakDir') })),

		unpakDecryptPakEntries: (pakPath: string, entries: string[], opts?: ProgressOptions): Promise<OperationResult> =>
			ipcRenderer.invoke('unpak-decrypt-pak-entries', toCloneable({ pakPath, entries: Array.from(entries), showFileProgress: readShowFileProgress(opts), unpakedDir: readDirOption(opts, 'unpakedDir'), pakDir: readDirOption(opts, 'pakDir') })),

		decryptPackages: (paths: string[], opts?: ProgressOptions): Promise<OperationResult> =>
			ipcRenderer.invoke('decrypt-packages', toCloneable({ paths: Array.from(paths), showFileProgress: readShowFileProgress(opts), unpakedDir: readDirOption(opts, 'unpakedDir'), pakDir: readDirOption(opts, 'pakDir') })),

		repackPackages: (paths: string[], opts?: ProgressOptions): Promise<OperationResult> =>
			ipcRenderer.invoke('repack-packages', toCloneable({ paths: Array.from(paths), showFileProgress: readShowFileProgress(opts), unpakedDir: readDirOption(opts, 'unpakedDir'), repakedDir: readDirOption(opts, 'repakedDir'), pakDir: readDirOption(opts, 'pakDir') })),

		extractFolder: (payload: ExtractFolderPayload): Promise<ExtractFolderResult> =>
			ipcRenderer.invoke('extract-folder', toCloneable({
				inputFolder: payload.inputFolder,
				includeNonPak: payload.includeNonPak,
				overwrite: payload.overwrite,
				showFileProgress: payload.showFileProgress,
				unpakedDir: payload.unpakedDir,
				pakDir: payload.pakDir,
			})),

		decryptUnpaked: (paths: string[], opts?: ProgressOptions): Promise<OperationResult> =>
			ipcRenderer.invoke('decrypt-unpaked', toCloneable({ paths: Array.from(paths), showFileProgress: readShowFileProgress(opts) })),

		repackUnpaked: (payload: RepackUnpakedPayload): Promise<OperationResult> =>
			ipcRenderer.invoke('repack-unpaked', toCloneable({
				selectedFolderPaths: Array.from(payload.selectedFolderPaths),
				showFileProgress: payload.showFileProgress,
				repakedDir: payload.repakedDir,
				unpakedDir: payload.unpakedDir,
			})),

		addFilesToPak: (payload: AddFilesToPakPayload): Promise<OperationResult> =>
			ipcRenderer.invoke('add-files-to-pak', toCloneable({
				pakPath: payload.pakPath,
				sourcePaths: Array.from(payload.sourcePaths),
				targetFolder: payload.targetFolder,
				overwrite: payload.overwrite,
				base: payload.base,
				showFileProgress: payload.showFileProgress,
			})),

		deletePakEntries: (payload: DeletePakEntriesPayload): Promise<OperationResult> =>
			ipcRenderer.invoke('delete-pak-entries', toCloneable({
				pakPath: payload.pakPath,
				entries: Array.from(payload.entries),
				base: payload.base,
				showFileProgress: payload.showFileProgress,
			})),

		cancelAction: (): Promise<CancelActionResult> => ipcRenderer.invoke('cancel-action'),

		openRepakedFolder: (): Promise<OpenFolderResult> => ipcRenderer.invoke('open-repaked-folder'),

		openPakFolder: (): Promise<OpenFolderResult> => ipcRenderer.invoke('open-pak-folder'),

		openUnpakedFolder: (): Promise<OpenFolderResult> => ipcRenderer.invoke('open-unpaked-folder'),

		openFolder: (dir: string): Promise<OpenFolderResult> => ipcRenderer.invoke('open-folder', toCloneable({ dir })),

		listPakDatabases: (unpakedDir?: string): Promise<ListPakDatabasesResult> =>
			ipcRenderer.invoke('list-pak-databases', toCloneable({ unpakedDir })),

		readPakDatabase: (dbPath: string, base?: string): Promise<ReadPakDatabaseResult> =>
			ipcRenderer.invoke('read-pak-database', toCloneable({ dbPath, base })),

		getSettings: (): Promise<SettingsResult> => ipcRenderer.invoke('settings-get'),

		setSettings: (partial: AppSettings): Promise<SettingsResult> =>
			ipcRenderer.invoke('settings-set', toCloneable(partial)),

		checkUpdate: (force?: boolean): Promise<CheckUpdateResult> =>
			ipcRenderer.invoke('check-update', toCloneable({ force: force === true })),

		openReleases: (): Promise<OpenFolderResult> => ipcRenderer.invoke('open-releases'),

		onProgress: (callback: (progress: ProgressPayload) => void): void => {
			ipcRenderer.on('app-progress', (_event, progress: ProgressPayload) => {
				callback(progress)
			})
		},

		onConflict: (callback: (request: ConflictRequest) => void): void => {
			ipcRenderer.on('app-conflict', (_event, request: ConflictRequest) => {
				callback(request)
			})
		},

		resolveConflict: (payload: ResolveConflictPayload): Promise<ResolveConflictResult> =>
			ipcRenderer.invoke('resolve-conflict', toCloneable({ requestId: payload.requestId, choice: payload.choice })),
	}
}

export function exposeElectronApi(): void {
	contextBridge.exposeInMainWorld('electronAPI', buildElectronApi())
}
