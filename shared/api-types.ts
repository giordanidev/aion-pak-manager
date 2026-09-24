export interface PakEntry {
	label: string;
	fullPath: string;
	fileCount?: number;
	/** Total size of the entry (folder contents or pak file) in bytes. */
	sizeBytes?: number;
	fileCountLoading?: boolean;
	/** Aggregate/legacy DB beside this folder (`<name>.db` / `<name>.pak.db`), when it exists. */
	dbPath?: string;
}

export interface PakDatabasePakEntry {
	/** Original pak location relative to the extraction root (e.g. `PTB/bra.pak`). */
	relPakPath: string;
	/** v4: posix dir under the unpaked root where the pak files were extracted (may be `''`). */
	destDir?: string;
	/** Files contained in the pak, relative to the pak root. */
	files: string[];
	fileCount?: number;
}

export interface PakDatabaseInfo {
	relPakPath?: string;
	/** Aggregate DB root folder name (e.g. `PTB`). */
	folderName?: string;
	version?: number;
	files: string[];
	/** Aggregate DB (v3/v4) pak entries, used to render the reconstructed structure. */
	paks?: PakDatabasePakEntry[];
	sourcePak?: string;
	outputFolder?: string;
	destDir?: string;
	createdAt?: string;
	[key: string]: unknown;
}

export interface AppCustomDirs {
	pak?: string;
	unpaked?: string;
	repaked?: string;
}

export interface AppWindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type CpuEffort = 'low' | 'medium' | 'high' | 'extreme' | 'manual';

export interface AppSettings {
	version?: number;
	locale?: string;
	showFileNames?: boolean;
	customDirs?: AppCustomDirs;
	rememberWindowBounds?: boolean;
	windowBounds?: AppWindowBounds;
	cpuEffort?: CpuEffort;
	manualCpuThreads?: number;
}

export interface SettingsResult {
	success: boolean;
	settings?: AppSettings;
	/** Total hardware threads of the PC (read-only, for UI display). */
	totalThreads?: number;
	error?: string;
}

export interface CheckUpdateResult {
	success: boolean;
	updateAvailable: boolean;
	currentVersion?: string;
	latestVersion?: string;
	releaseUrl?: string;
	error?: string;
}

/** Lifecycle of the native (electron-updater) auto-update flow. */
export type UpdateStatus =
	| 'idle'
	| 'unsupported'
	| 'checking'
	| 'available'
	| 'not-available'
	| 'downloading'
	| 'downloaded'
	| 'error';

export interface UpdateState {
	status: UpdateStatus;
	/** Version being downloaded / ready to install. */
	version?: string;
	/** Download progress 0-100. */
	percent?: number;
	/** Bytes already downloaded. */
	transferred?: number;
	/** Total download size in bytes. */
	total?: number;
	/** Current download speed in bytes/second. */
	bytesPerSecond?: number;
	error?: string;
}

export interface UpdateActionResult {
	success: boolean;
	state: UpdateState;
	error?: string;
}

export interface ListPakDatabasesResult {
	success: boolean;
	databases: PakEntry[];
	error?: string;
}

export interface ReadPakDatabaseResult {
	success: boolean;
	info?: PakDatabaseInfo;
	error?: string;
}

export interface ProgressPayload {
	stage: string;
	packageName?: string;
	packageIndex?: number;
	packageTotal?: number;
	current?: number;
	total?: number;
	percent?: number;
	/** True when `percent` already spans the whole action (not just one task). */
	globalPercent?: boolean;
	bytesDelta?: number;
	speedMBs?: number;
	fileName?: string | null;
	file?: string | null;
	folder?: string;
	message?: string;
	translationName?: string;
	folderName?: string;
	output?: string;
	[key: string]: unknown;
}

export interface ScanPaksResult {
	success: boolean;
	pakFiles: PakEntry[];
	rootFolders: PakEntry[];
	error?: string;
}

export interface ScanUnpakedResult {
	success: boolean;
	unpakedFolders: PakEntry[];
	repakedFiles: PakEntry[];
	repakedCount: number;
	error?: string;
}

export interface CountEntriesResult {
	success: boolean;
	counts?: Record<string, number>;
	/** Total size in bytes per entry, keyed by the same paths as `counts`. */
	sizes?: Record<string, number>;
	error?: string;
}

export interface ListPakContentsResult {
	success: boolean;
	files?: string[];
	error?: string;
}

export interface SelectFolderResult {
	success: boolean;
	folderPath?: string;
	canceled?: boolean;
	error?: string;
}

export interface OperationFailure {
	packageName?: string;
	packagePath?: string;
	error: string;
}

export interface OperationResults {
	success: unknown[];
	failed: unknown[];
}

export interface OperationResult {
	success: boolean;
	results?: OperationResults;
	canceled?: boolean;
	error?: string;
}

export interface ExtractFolderResult {
	success: boolean;
	canceled?: boolean;
	results?: {
		outputFolder: string;
		paksExtracted: number;
		otherFilesCopied: number;
		dbPaths: string[];
		skippedExisting: string[];
	};
	error?: string;
}

export interface CancelActionResult {
	success: boolean;
	error?: string;
}

export interface OpenFolderResult {
	success: boolean;
	error?: string;
}

export interface ExtractFolderPayload {
	inputFolder: string;
	includeNonPak?: boolean;
	overwrite?: boolean;
	showFileProgress?: boolean;
	/** Extraction output root (custom "unpaked" folder); defaults to /PAKS/unpaked. */
	unpakedDir?: string;
	/** Source PAK root (custom "pak" folder); defaults to /PAKS/pak. */
	pakDir?: string;
}

/** Answer to an interactive conflict prompt raised while un-paking a folder. */
export type ConflictChoice = 'overwrite' | 'overwrite-all' | 'skip' | 'skip-all' | 'cancel';

/** Conflict of a single `.pak` already present in the aggregate DB manifest. */
export interface ExtractConflictRequest {
	packageName: string;
	relPakPath: string;
	fileCount?: number;
	conflictIndex: number;
	conflictTotal: number;
}

/** Main -> renderer conflict request (carries the id needed to answer). */
export interface ConflictRequest extends ExtractConflictRequest {
	requestId: number;
}

export interface ResolveConflictPayload {
	requestId: number;
	choice: ConflictChoice;
}

export interface ResolveConflictResult {
	success: boolean;
	error?: string;
}

export interface RepackUnpakedPayload {
	selectedFolderPaths: string[];
	showFileProgress?: boolean;
	/** RePAK output root (custom "repaked" folder); defaults to /PAKS/repaked. */
	repakedDir?: string;
	/** Source extraction root (custom "unpaked" folder); defaults to /PAKS/unpaked. */
	unpakedDir?: string;
}

export interface AddFilesToPakPayload {
	pakPath: string;
	sourcePaths: string[];
	targetFolder?: string;
	overwrite?: boolean;
	base?: string;
	showFileProgress?: boolean;
}

export interface AddFilesToPakResultData {
	pakPath: string;
	added: number;
	replaced: number;
	skipped: number;
	total: number;
}

export interface DeletePakEntriesPayload {
	pakPath: string;
	entries: string[];
	base?: string;
	showFileProgress?: boolean;
}

export interface ProgressOptions {
	showFileProgress?: boolean;
	/** Extraction output root (custom "unpaked" folder); defaults to /PAKS/unpaked. */
	unpakedDir?: string;
	/** Source PAK root (custom "pak" folder); defaults to /PAKS/pak. */
	pakDir?: string;
}

export interface ElectronApi {
	scanPaks(dir?: string): Promise<ScanPaksResult>;
	scanUnpaked(unpakedDir?: string, repakedDir?: string): Promise<ScanUnpakedResult>;
	countEntries(paths: string[], kind: 'pak' | 'pakFolder' | 'folder' | 'repaked', base?: string): Promise<CountEntriesResult>;
	selectFolder(): Promise<SelectFolderResult>;
	listPakContents(pakPath: string, base?: string): Promise<ListPakContentsResult>;
	unpakPackages(paths: string[], opts?: ProgressOptions): Promise<OperationResult>;
	unpakDecryptPackages(paths: string[], opts?: ProgressOptions): Promise<OperationResult>;
	unpakPakEntries(pakPath: string, entries: string[], opts?: ProgressOptions): Promise<OperationResult>;
	unpakDecryptPakEntries(pakPath: string, entries: string[], opts?: ProgressOptions): Promise<OperationResult>;
	decryptPackages(paths: string[], opts?: ProgressOptions): Promise<OperationResult>;
	repackPackages(paths: string[], opts?: ProgressOptions): Promise<OperationResult>;
	extractFolder(payload: ExtractFolderPayload): Promise<ExtractFolderResult>;
	decryptUnpaked(paths: string[], opts?: ProgressOptions): Promise<OperationResult>;
	repackUnpaked(payload: RepackUnpakedPayload): Promise<OperationResult>;
	addFilesToPak(payload: AddFilesToPakPayload): Promise<OperationResult>;
	deletePakEntries(payload: DeletePakEntriesPayload): Promise<OperationResult>;
	cancelAction(): Promise<CancelActionResult>;
	openRepakedFolder(): Promise<OpenFolderResult>;
	openPakFolder(): Promise<OpenFolderResult>;
	openUnpakedFolder(): Promise<OpenFolderResult>;
	openFolder(dir: string): Promise<OpenFolderResult>;
	listPakDatabases(unpakedDir?: string): Promise<ListPakDatabasesResult>;
	readPakDatabase(dbPath: string, base?: string): Promise<ReadPakDatabaseResult>;
	getSettings(): Promise<SettingsResult>;
	setSettings(partial: AppSettings): Promise<SettingsResult>;
	checkUpdate(force?: boolean): Promise<CheckUpdateResult>;
	openReleases(): Promise<OpenFolderResult>;
	getUpdateState(): Promise<UpdateState>;
	downloadUpdate(): Promise<UpdateActionResult>;
	installUpdate(): Promise<UpdateActionResult>;
	onUpdateState(callback: (state: UpdateState) => void): void;
	onProgress(callback: (progress: ProgressPayload) => void): void;
	onConflict(callback: (request: ConflictRequest) => void): void;
	resolveConflict(payload: ResolveConflictPayload): Promise<ResolveConflictResult>;
}
