import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { decodeAionBinaryXml } from '../parse/binary-xml';
import { decodeAionEncryptedHtml } from '../parse/html-crypt';
import { readPrefix } from '../parse/format-detect';

export interface DecryptProgress {
	current: number;
	total: number;
	file: string;
}

function collectDecryptableFiles(folderPath: string): string[] {
	const entries: string[] = [];
	function walk(dir: string): void {
		for (const name of readdirSync(dir)) {
			if (name === '.pak-metadata.json') continue;
			const fullPath = path.join(dir, name);
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				walk(fullPath);
			} else if (stat.isFile()) {
				const ext = path.extname(name).toLowerCase();
				if (ext === '.xml' || ext === '.html') {
					entries.push(fullPath);
				}
			}
		}
	}
	walk(folderPath);
	return entries;
}

export function decryptFile(filePath: string): string {
	const resolved = path.resolve(filePath);
	if (!existsSync(resolved)) {
		throw new Error(`File not found: ${resolved}`);
	}

	const ext = path.extname(resolved).toLowerCase();
	if (ext !== '.xml' && ext !== '.html') {
		throw new Error(`Unsupported file extension: ${ext}`);
	}

	const prefix = readPrefix(resolved);
	if (prefix.length === 0) {
		return resolved;
	}

	// Native-only decode (no exe fallback), magic only:
	// 0x81 -> HTML crypt, 0x80 -> binary XML, anything else -> skip (already plaintext).
	// A decode failure throws.
	if (prefix[0] !== 0x80 && prefix[0] !== 0x81) {
		return resolved;
	}
	const raw = readFileSync(resolved);
	let decoded: Buffer;
	if (prefix[0] === 0x81) {
		decoded = decodeAionEncryptedHtml(raw, path.basename(resolved));
	} else {
		decoded = Buffer.from(decodeAionBinaryXml(raw), 'utf8');
	}

	const tmpOutput = `${resolved}.decrypt.tmp`;
	writeFileSync(tmpOutput, decoded);
	try {
		if (existsSync(resolved)) {
			unlinkSync(resolved);
		}
		renameSync(tmpOutput, resolved);
	} catch (renameError) {
		if (existsSync(tmpOutput)) {
			unlinkSync(tmpOutput);
		}
		throw renameError;
	}

	return resolved;
}

export function decryptFolder(folderPath: string, progressCallback?: (info: DecryptProgress) => void): number {
	const resolved = path.resolve(folderPath);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		throw new Error(`Input folder not found: ${resolved}`);
	}

	const files = collectDecryptableFiles(resolved);
	for (let i = 0; i < files.length; i += 1) {
		const file = files[i];
		decryptFile(file);
		if (typeof progressCallback === 'function') {
			progressCallback({ current: i + 1, total: files.length, file });
		}
	}

	return files.length;
}
