import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import path from 'path'
import type { AppSettings, CpuEffort } from '../../shared/api-types'
import { ROOT_DIR } from './paths'

const SETTINGS_PATH = path.join(ROOT_DIR, 'settings.json')
const SETTINGS_VERSION = 1

const CPU_EFFORTS: readonly CpuEffort[] = ['low', 'medium', 'high', 'extreme', 'manual']

const DEFAULTS: AppSettings = {
	version: SETTINGS_VERSION,
	rememberWindowBounds: false,
	cpuEffort: 'high',
}

let cache: AppSettings | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function sanitize(raw: unknown): AppSettings {
	const settings: AppSettings = { ...DEFAULTS }
	if (!isRecord(raw)) return settings
	if (typeof raw.locale === 'string') settings.locale = raw.locale
	if (typeof raw.showFileNames === 'boolean') settings.showFileNames = raw.showFileNames
	if (typeof raw.rememberWindowBounds === 'boolean') settings.rememberWindowBounds = raw.rememberWindowBounds
	if (typeof raw.cpuEffort === 'string' && (CPU_EFFORTS as readonly string[]).includes(raw.cpuEffort)) {
		settings.cpuEffort = raw.cpuEffort as CpuEffort
	}
	if (typeof raw.manualCpuThreads === 'number' && Number.isFinite(raw.manualCpuThreads)) {
		settings.manualCpuThreads = Math.max(1, Math.floor(raw.manualCpuThreads))
	}
	if (isRecord(raw.customDirs)) {
		const dirs: NonNullable<AppSettings['customDirs']> = {}
		for (const key of ['pak', 'unpaked', 'repaked'] as const) {
			const value = raw.customDirs[key]
			if (typeof value === 'string') dirs[key] = value
		}
		settings.customDirs = dirs
	}
	if (isRecord(raw.windowBounds)) {
		const b = raw.windowBounds
		if (
			typeof b.x === 'number' &&
			typeof b.y === 'number' &&
			typeof b.width === 'number' &&
			typeof b.height === 'number'
		) {
			settings.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
		}
	}
	return settings
}

export function loadSettings(): AppSettings {
	if (cache) return cache
	let parsed: unknown = null
	try {
		if (existsSync(SETTINGS_PATH)) {
			parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
		}
	} catch {
		parsed = null
	}
	cache = sanitize(parsed)
	return cache
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
	const current = loadSettings()
	const merged: AppSettings = { ...current, ...patch, version: SETTINGS_VERSION }
	if (patch.customDirs) {
		merged.customDirs = { ...current.customDirs, ...patch.customDirs }
	}
	cache = merged
	try {
		const dir = path.dirname(SETTINGS_PATH)
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true })
		}
		const tmpPath = `${SETTINGS_PATH}.tmp`
		writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf8')
		renameSync(tmpPath, SETTINGS_PATH)
	} catch {
		// Keep in-memory settings even if the disk write fails.
	}
	return merged
}
