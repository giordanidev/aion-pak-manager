import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../../shared/api-types'

/**
 * Which native update channel is available:
 * - `nsis`: Windows installer (electron-updater supported).
 * - `appimage`: Linux AppImage (electron-updater supported).
 * - `unsupported`: dev, Windows portable, Linux .deb/.rpm (fall back to the releases link).
 */
export type UpdateSupport = 'nsis' | 'appimage' | 'unsupported'

let stateSender: ((state: UpdateState) => void) | null = null
let wired = false
let current: UpdateState = { status: 'idle' }

export function updateSupport(): UpdateSupport {
	if (!app.isPackaged) return 'unsupported'
	if (process.platform === 'win32') {
		// The portable build sets PORTABLE_EXECUTABLE_DIR and cannot self-update.
		return process.env['PORTABLE_EXECUTABLE_DIR'] ? 'unsupported' : 'nsis'
	}
	if (process.platform === 'linux') {
		// AppImage sets APPIMAGE; .deb/.rpm installs do not.
		return process.env['APPIMAGE'] ? 'appimage' : 'unsupported'
	}
	return 'unsupported'
}

/** Registers the renderer push channel (main -> renderer state updates). */
export function setUpdateStateSender(sender: (state: UpdateState) => void): void {
	stateSender = sender
}

function emit(patch: Partial<UpdateState>): void {
	current = { ...current, ...patch }
	stateSender?.(current)
}

export function getUpdateState(): UpdateState {
	if (current.status === 'idle' && updateSupport() === 'unsupported') {
		return { status: 'unsupported' }
	}
	return current
}

function wire(): void {
	if (wired) return
	wired = true
	autoUpdater.autoDownload = false
	autoUpdater.autoInstallOnAppQuit = true
	autoUpdater.logger = console
	autoUpdater.on('checking-for-update', () => emit({ status: 'checking' }))
	autoUpdater.on('update-available', (info) => emit({ status: 'available', version: info.version }))
	autoUpdater.on('update-not-available', (info) => emit({ status: 'not-available', version: info.version }))
	autoUpdater.on('download-progress', (p) =>
		emit({
			status: 'downloading',
			percent: p.percent,
			transferred: p.transferred,
			total: p.total,
			bytesPerSecond: p.bytesPerSecond,
		}),
	)
	autoUpdater.on('update-downloaded', (info) =>
		emit({ status: 'downloaded', version: info.version, percent: 100 }),
	)
	autoUpdater.on('error', (err) => emit({ status: 'error', error: err?.message ?? String(err) }))
}

/** Checks for an update and, if one exists, starts downloading it. */
export async function downloadUpdate(): Promise<UpdateState> {
	if (updateSupport() === 'unsupported') {
		emit({ status: 'unsupported' })
		return current
	}
	wire()
	try {
		await autoUpdater.checkForUpdates()
		if (current.status !== 'available') return current
		await autoUpdater.downloadUpdate()
	} catch (error) {
		emit({ status: 'error', error: error instanceof Error ? error.message : String(error) })
	}
	return current
}

/** Quits the app and runs the downloaded installer. */
export function installUpdate(): void {
	if (updateSupport() === 'unsupported') return
	wire()
	// Show the installer, then relaunch the app on the new version.
	autoUpdater.quitAndInstall(false, true)
}
