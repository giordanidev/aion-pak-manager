import { app } from 'electron'
import type { CheckUpdateResult } from '../../shared/api-types'

const REPO = 'giordanidev/aion-pak-manager'
// Primary source: a tiny version.json published as a release asset. GitHub
// redirects `releases/latest/download/<asset>` to the latest release with no
// API call, so it is not subject to the REST API's 60 req/h unauthenticated
// rate limit and always points at the latest published release.
const RELEASE_ASSET_URL = `https://github.com/${REPO}/releases/latest/download/version.json`
// Fallbacks: the same file committed to the default branch, served by a CDN
// (jsDelivr) and then raw.githubusercontent.com.
const VERSION_JSON_URLS = [
	`https://cdn.jsdelivr.net/gh/${REPO}@main/version.json`,
	`https://raw.githubusercontent.com/${REPO}/main/version.json`,
]
// Last resort: the GitHub Releases REST API (rate-limited to 60 req/h per IP).
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
export const RELEASES_URL = `https://github.com/${REPO}/releases`
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

/** Reads a version from a JSON payload (`version` for version.json, `tag_name` for the API). */
function versionFromPayload(data: unknown): string {
	if (typeof data !== 'object' || data === null) return ''
	const record = data as Record<string, unknown>
	const raw = typeof record.version === 'string' ? record.version : typeof record.tag_name === 'string' ? record.tag_name : ''
	return raw.trim().replace(/^v/i, '')
}

/** Fetches a version JSON, returning `null` on any failure (network, status, parse). */
async function fetchVersion(url: string): Promise<string | null> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				Accept: 'application/json',
				'User-Agent': 'aion-pak-manager',
			},
		})
		if (!res.ok) return null
		return versionFromPayload(await res.json()) || null
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}

async function runCheck(): Promise<CheckUpdateResult> {
	const current = currentVersion()
	let lastError = 'Update check failed'
	for (const url of [RELEASE_ASSET_URL, ...VERSION_JSON_URLS, RELEASES_API]) {
		const latest = await fetchVersion(url)
		if (latest) {
			const result: CheckUpdateResult = {
				success: true,
				updateAvailable: isNewer(latest, current),
				currentVersion: current,
				latestVersion: latest,
				releaseUrl: RELEASES_URL,
			}
			cached = result
			return result
		}
		lastError = `No version available from ${url}`
	}
	return {
		success: false,
		updateAvailable: false,
		currentVersion: current,
		error: lastError,
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
