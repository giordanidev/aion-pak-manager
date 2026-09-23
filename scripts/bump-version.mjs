// Bumps the patch version before a production build.
// - 0.0.44-alpha.3 -> 0.0.45 (ignores any lingering -alpha.N suffix)
// - 0.0.45 -> 0.0.46
// Never creates -alpha suffixes. Never changes major/minor numbers.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function getCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

const pkgPath = resolve(process.cwd(), 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const current = typeof pkg.version === 'string' ? pkg.version : ''
const commit = getCommitHash()

const m = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.\d+)?$/.exec(current)
if (!m) {
  console.error(`[bump] unexpected version "${current}", leaving unchanged (commit ${commit}).`)
  process.exit(0)
}

const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n')

try {
  const lockPath = resolve(process.cwd(), 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  lock.version = next
  if (lock.packages && typeof lock.packages === 'object' && lock.packages[''] && typeof lock.packages[''] === 'object') {
    lock.packages[''].version = next
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, '\t') + '\n')
} catch {
  // package-lock.json missing or unreadable: ignore, keep package.json as source of truth.
}

// Keep version.json (served as a release asset + CDN fallback) in sync.
try {
  const versionJson = {
    version: next,
    releaseUrl: 'https://github.com/giordanidev/aion-pak-manager/releases',
  }
  writeFileSync(resolve(process.cwd(), 'version.json'), `${JSON.stringify(versionJson, null, 2)}\n`)
} catch {
  // Non-fatal: package.json stays the source of truth.
}

console.log(`[bump] ${current} -> ${next} (commit ${commit})`)
