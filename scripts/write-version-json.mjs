// Writes version.json — a tiny, cache-friendly update manifest.
//
// It is published as a GitHub Release asset so the app can read the latest
// version from `releases/latest/download/version.json` (no API, no rate limit)
// and is also committed to the default branch as a CDN fallback.
//
// Usage:
//   node scripts/write-version-json.mjs            # uses package.json version
//   node scripts/write-version-json.mjs v0.0.83    # uses an explicit tag/version
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'))
const raw = String(process.argv[2] ?? pkg.version ?? '').trim()
const version = raw.replace(/^v/i, '')

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[version-json] unexpected version "${version}", skipping.`)
  process.exit(0)
}

const data = {
  version,
  releaseUrl: 'https://github.com/giordanidev/aion-pak-manager/releases',
}

writeFileSync(resolve(root, 'version.json'), `${JSON.stringify(data, null, 2)}\n`)
console.log(`[version-json] version ${version}`)
