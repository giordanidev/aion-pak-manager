import './bin/threadpool'
import { app, BrowserWindow, screen } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { AppWindowBounds } from '../shared/api-types'
import { registerIpcHandlers } from './ipc/handlers'
import { ensureDataDirs } from './services/paths'
import { loadSettings, saveSettings } from './services/settings'
import { runCli } from './cli/run'

// Development and the packaged app would otherwise share the same Chromium
// cache directory under userData; two processes racing on it produce
// "Unable to move the cache / Unable to create cache" errors. Give dev its own.
if (!app.isPackaged) {
	app.setPath('userData', join(app.getPath('appData'), `${app.getName()}-dev`))
}

let mainWindow: BrowserWindow | null = null

function devIconPath(): string | undefined {
	if (app.isPackaged) return undefined
	const icon = join(app.getAppPath(), 'build', 'icon.ico')
	return existsSync(icon) ? icon : undefined
}

function savedBounds(): AppWindowBounds | undefined {
	const settings = loadSettings()
	if (!settings.rememberWindowBounds) return undefined
	const b = settings.windowBounds
	if (!b) return undefined
	if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.width) || !Number.isFinite(b.height)) {
		return undefined
	}
	if (b.width < 320 || b.height < 240) return undefined
	try {
		const area = screen.getDisplayMatching(b).workArea
		const visible =
			b.x < area.x + area.width &&
			b.x + b.width > area.x &&
			b.y < area.y + area.height &&
			b.y + b.height > area.y
		if (!visible) return undefined
	} catch {
		return undefined
	}
	return b
}

function persistBounds(win: BrowserWindow): void {
	// Never persist while minimized: Windows reports bogus bounds then.
	if (!loadSettings().rememberWindowBounds) return
	if (win.isMinimized() || win.isDestroyed()) return
	try {
		const b = win.getNormalBounds()
		saveSettings({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
	} catch {
		// ignore persistence errors
	}
}

function createWindow(): void {
	const icon = devIconPath()
	const bounds = savedBounds()
	const win = new BrowserWindow({
		...(bounds
			? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
			: { width: 1200, height: 700 }),
		minWidth: 1024,
		minHeight: 700,
		show: false,
		autoHideMenuBar: true,
		...(icon ? { icon } : {}),
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	})
	mainWindow = win

	let boundsTimer: ReturnType<typeof setTimeout> | null = null
	const scheduleBoundsSave = (): void => {
		if (boundsTimer) clearTimeout(boundsTimer)
		boundsTimer = setTimeout(() => {
			boundsTimer = null
			if (mainWindow === win) persistBounds(win)
		}, 400)
	}
	win.on('move', scheduleBoundsSave)
	win.on('resize', scheduleBoundsSave)
	win.on('close', () => {
		if (boundsTimer) {
			clearTimeout(boundsTimer)
			boundsTimer = null
		}
		persistBounds(win)
	})

	win.on('ready-to-show', () => win.show())
	win.on('closed', () => {
		if (mainWindow === win) mainWindow = null
	})

	if (process.env['ELECTRON_RENDERER_URL']) {
		win.loadURL(process.env['ELECTRON_RENDERER_URL'])
	} else {
		win.loadFile(join(__dirname, '../frontend/index.html'))
	}
}

// Packaged app: `<app>.exe cli <command>` runs headless (no window). In
// development the CLI is run directly via `node .build/backend/cli.js`.
const cliArgs = process.argv[1] === 'cli' ? process.argv.slice(2) : null

if (cliArgs) {
	app.whenReady().then(async () => {
		const code = await runCli(cliArgs)
		app.exit(code)
	})
} else if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on('second-instance', () => {
		if (!mainWindow) return
		if (mainWindow.isMinimized()) mainWindow.restore()
		mainWindow.show()
		mainWindow.focus()
	})
	app.whenReady().then(() => {
		ensureDataDirs()
		registerIpcHandlers(() => mainWindow)
		createWindow()

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow()
		})
	})
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
})
