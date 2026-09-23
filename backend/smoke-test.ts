// Smoke test for backend core/parse (native only — no bin tools required).
//
// Run directly (Node 18+ with tsx, or Node >=22.6 with --experimental-strip-types):
//   npx tsx backend/smoke-test.ts
//   node --experimental-strip-types backend/smoke-test.ts
//   node backend/smoke-test.ts            (Node >=23.6, type stripping on by default)
//
// Or bundle + run (esbuild ships with electron-vite/vite):
//   npx esbuild backend/smoke-test.ts --bundle --platform=node --format=cjs --outfile=tmp-smoke.cjs
//   node tmp-smoke.cjs
//
// Checks (soft-skip when fixtures are absent):
//   - readPrefix() on an unpaked dialogs/*.html -> isPlainHtml === true
//   - native decode of scripts/aion_f2p_24_data_encrypted/* vs golden scripts/aion_f2p_24_data/*
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { resolveProjectRoot } from './bin/platform';
import { decodeAionBinaryXml } from './parse/binary-xml';
import { decodeAionEncryptedHtml } from './parse/html-crypt';
import { isPlainHtml, readPrefix } from './parse/format-detect';

let failures = 0;
let skipped = 0;

function assert(cond: boolean, message: string): void {
	if (!cond) {
		failures += 1;
		console.error(`FAIL: ${message}`);
	} else {
		console.log(`ok: ${message}`);
	}
}

function skip(message: string): void {
	skipped += 1;
	console.log(`skip: ${message}`);
}

function findFirstHtml(): string | null {
	const dialogsDir = path.join(resolveProjectRoot(), 'unpaked', 'data_origin46_english', 'dialogs');
	if (!existsSync(dialogsDir)) {
		return null;
	}
	for (const name of readdirSync(dialogsDir)) {
		if (name.endsWith('.html')) {
			return path.join(dialogsDir, name);
		}
	}
	return null;
}

const htmlFile = findFirstHtml();
if (htmlFile) {
	const prefix = readPrefix(htmlFile);
	assert(prefix.length > 0, `readPrefix('${path.basename(htmlFile)}') returns ${prefix.length} bytes`);
	assert(isPlainHtml(prefix), `isPlainHtml(prefix of ${path.basename(htmlFile)}) is true`);
} else {
	skip('no unpaked/data_origin46_english/dialogs/*.html file');
}

function collectFiles(dir: string): string[] {
	const out: string[] = [];
	function walk(d: string): void {
		for (const name of readdirSync(d)) {
			const full = path.join(d, name);
			if (statSync(full).isDirectory()) {
				walk(full);
			} else if (statSync(full).isFile()) {
				out.push(full);
			}
		}
	}
	walk(dir);
	return out.sort();
}

const encRoot = path.join(resolveProjectRoot(), 'scripts', 'aion_f2p_24_data_encrypted');
const goldRoot = path.join(resolveProjectRoot(), 'scripts', 'aion_f2p_24_data');
if (existsSync(encRoot) && existsSync(goldRoot)) {
	for (const encPath of collectFiles(encRoot)) {
		const rel = path.relative(encRoot, encPath);
		const goldPath = path.join(goldRoot, rel);
		if (!existsSync(goldPath)) {
			skip(`no golden for ${rel}`);
			continue;
		}
		const enc = readFileSync(encPath);
		const gold = readFileSync(goldPath);
		try {
			let decoded: Buffer;
			if (enc[0] === 0x80) {
				decoded = Buffer.from(decodeAionBinaryXml(enc), 'utf8');
			} else if (enc[0] === 0x81) {
				decoded = decodeAionEncryptedHtml(enc, path.basename(encPath));
			} else {
				throw new Error(`unknown magic 0x${enc[0].toString(16)}`);
			}
			assert(decoded.equals(gold), `native decode matches golden ${rel}`);
		} catch (err) {
			assert(false, `native decode matches golden ${rel} (${err instanceof Error ? err.message : String(err)})`);
		}
	}
} else {
	skip('scripts/aion_f2p_24_data_encrypted vs golden pair absent');
}

if (failures > 0) {
	console.error(`\n${failures} smoke test check(s) failed (${skipped} skipped)`);
	process.exitCode = 1;
} else {
	console.log(`\nAll smoke test checks passed (${skipped} skipped)`);
}
