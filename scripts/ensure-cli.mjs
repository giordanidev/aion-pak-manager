// Ensures the headless CLI is built before running `npm run unpak|repak|cli`.
// Only builds when .build/backend/cli.js is missing, so repeated CLI calls stay
// instant. Re-run `npm run build` after changing backend sources.
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliOutput = path.join(root, '.build', 'backend', 'cli.js')

if (!existsSync(cliOutput)) {
	console.error('[cli] .build/backend/cli.js not found — building...')
	execSync('npx electron-vite build', { cwd: root, stdio: 'inherit' })
}
