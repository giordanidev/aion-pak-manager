// Compiles better-sqlite3 for the Electron ABI used by the app, dev server, and CLI.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function optional(id) {
	try {
		return require.resolve(id)
	} catch {
		return null
	}
}

if (!optional('electron/package.json') || !optional('better-sqlite3/package.json') || !optional('@electron/rebuild/package.json')) {
	process.exit(0)
}

const result = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3'], {
	stdio: 'inherit',
	shell: true,
})
process.exit(result.status ?? 1)
