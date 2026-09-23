import { app } from 'electron'
import type { CheckUpdateResult } from '../../shared/api-types'

const RELEASES_API = 'https://api.github.com/repos/giordanidev/aion-pak-manager/releases/latest'
export const RELEASES_URL = 'https://github.com/giordanidev/aion-pak-manager/releases'
const TIMEOUT_MS = 8000

let cached: CheckUpdateResult | null = null
let inFlight: Promise<CheckUpdateResult> | null = null

function currentVersion(): string {
	try {
		return app.getVersion()
	} catch {
		return '0.0.0'
	}
}

function parseVersion(value: string): number[] {
	return value
		.trim()
		.replace(/^v/i, '')
		.split('-')[0]!
		.split('.')
		.map((part) => {
			const n = Number.parseInt(part, 10)
			return Number.isFinite(n) ? n : 0
		})
}

function isNewer(latest: string, current: string): boolean {
	const a = parseVersion(latest)
	const b = parseVersion(current)
	const len = Math.max(a.length, b.length)
	for (let i = 0; i < len; i++) {
		const x = a[i] ?? 0
		const y = b[i] ?? 0
		if (x > y) return true
		if (x < y) return false
	}
	return false
}

async function runCheck(): Promise<CheckUpdateResult> {
	const current = currentVersion()
	try {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
		try {
			const res = await fetch(RELEASES_API, {
				signal: controller.signal,
				headers: {
					Accept: 'application/vnd.github+json',
					'User-Agent': 'aion-pak-manager',
				},
			})
			if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
			const data = (await res.json()) as { tag_name?: unknown }
			const tag = typeof data.tag_name === 'string' ? data.tag_name : ''
			const latest = tag.replace(/^v/i, '')
			const result: CheckUpdateResult = {
				success: true,
				updateAvailable: latest ? isNewer(latest, current) : false,
				currentVersion: current,
				latestVersion: latest || undefined,
				releaseUrl: RELEASES_URL,
			}
			cached = result
			return result
		} finally {
			clearTimeout(timer)
		}
	} catch (error) {
		return {
			success: false,
			updateAvailable: false,
			currentVersion: current,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function checkForUpdates(force = false): Promise<CheckUpdateResult> {
	if (!force && cached?.success) return cached
	if (inFlight) return inFlight
	inFlight = runCheck().finally(() => {
		inFlight = null
	})
	return inFlight
}
