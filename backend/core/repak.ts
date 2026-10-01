import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'fs';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { deflateRaw } from 'zlib';
import { aionXorParams, crc32Unsigned } from '../parse/pak-codec';

const deflateRawAsync = promisify(deflateRaw);

export interface RepackProgress {
	stage: 'repak';
	current: number;
	total: number;
	percent: number;
	output: string;
	fileName?: string | null;
	fileIndex?: number;
	totalFiles?: number | null;
	bytesDelta?: number;
}

export type ShouldAbort = () => boolean;
export type RepackProgressCallback = (info: RepackProgress) => void;

// Abort flag for cancelZipPak(). Per-file work also honors the shouldAbort
// callback passed by the caller; both are checked in the packing loops.
let cancelRequested = false;

export function cancelZipPak(): void {
	cancelRequested = true;
}

function isAborted(shouldAbort: ShouldAbort): boolean {
	return cancelRequested || shouldAbort();
}

export interface PackEntry {
	// Archive name with `/` separators; directories end with `/`.
	name: string;
	absolutePath: string;
	isDirectory: boolean;
	mtime: Date;
}

function collectPackEntries(rootFolder: string): PackEntry[] {
	const entries: PackEntry[] = [];
	function walk(dir: string, rel: string): void {
		const names = readdirSync(dir).sort();
		for (const name of names) {
			if (name === '._tmp_repack') continue;
			const absolutePath = path.join(dir, name);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(absolutePath);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				const entryRel = rel.length > 0 ? `${rel}/${name}` : name;
				entries.push({ name: `${entryRel}/`, absolutePath, isDirectory: true, mtime: stat.mtime });
				walk(absolutePath, entryRel);
			} else if (stat.isFile()) {
				if (name === '.pak-metadata.json') continue;
				const lower = name.toLowerCase();
				if (lower.endsWith('.db') || lower.endsWith('.pak')) continue;
				const entryRel = rel.length > 0 ? `${rel}/${name}` : name;
				entries.push({ name: entryRel, absolutePath, isDirectory: false, mtime: stat.mtime });
			}
		}
	}
	walk(rootFolder, '');
	return entries;
}

function dosDateTime(date: Date): { time: number; date: number } {
	const year = Math.max(1980, date.getFullYear());
	const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff;
	const dosDate = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
	return { time, date: dosDate };
}

function writeAll(fd: number, buffer: Buffer): void {
	let offset = 0;
	while (offset < buffer.length) {
		const written = writeSync(fd, buffer, offset, buffer.length - offset);
		if (written <= 0) {
			throw new Error('Failed to write output file');
		}
		offset += written;
	}
}

function writeAllAt(fd: number, buffer: Buffer, position: number): number {
	let written = 0;
	while (written < buffer.length) {
		const n = writeSync(fd, buffer, written, buffer.length - written, position + written);
		if (n <= 0) {
			throw new Error('Failed to write output file');
		}
		written += n;
	}
	return position + buffer.length;
}

function reportFileProgress(
	progressCallback: RepackProgressCallback | undefined,
	outputPakPath: string,
	fileIndex: number,
	totalFiles: number,
	fileName: string | null,
	bytesDelta: number,
): void {
	if (!progressCallback) {
		return;
	}
	const percent = totalFiles > 0 ? Math.min(100, Math.round((fileIndex / totalFiles) * 1000) / 10) : 100;
	progressCallback({
		stage: 'repak',
		current: percent,
		total: 100,
		percent,
		output: outputPakPath,
		fileName,
		fileIndex,
		totalFiles,
		bytesDelta,
	});
}

interface PreparedFile {
	entry: PackEntry;
	nameBuf: Buffer;
	method: number;
	crc: number;
	csize: number;
	usize: number;
	cdata: Buffer;
	dosTime: number;
	dosDate: number;
}

// Deflate (method 8) at level ~5. Empty files also use method 8 (deflate of
// empty input is a 2-byte stream) because the AION reader classifies
// `method 0 + usize 0` entries without trailing `/` as directories.
async function prepareFileAsync(entry: PackEntry): Promise<PreparedFile> {
	const nameBuf = Buffer.from(entry.name, 'utf8');
	const { time, date } = dosDateTime(entry.mtime);
	if (entry.isDirectory) {
		return { entry, nameBuf, method: 0, crc: 0, csize: 0, usize: 0, cdata: Buffer.alloc(0), dosTime: time, dosDate: date };
	}
	const data = await readFile(entry.absolutePath);
	const usize = data.length;
	const cdata = (await deflateRawAsync(data, { level: 5 })) as Buffer;
	return {
		entry,
		nameBuf,
		method: 8,
		crc: crc32Unsigned(data),
		csize: cdata.length,
		usize,
		cdata: Buffer.from(cdata),
		dosTime: time,
		dosDate: date,
	};
}

// CPU-bound preparation (read + deflate + CRC) runs with bounded
// parallelism inside the Piscina worker so a single large PAK still uses
// all CPUs. Limited to os.cpus().length in-flight prepares; never spawns
// nested Piscina workers. Output order is preserved by index.
function repakConcurrency(): number {
	try {
		return Math.max(1, os.cpus().length);
	} catch {
		return 4;
	}
}

function effectiveRepakConcurrency(override?: number): number {
	const base = repakConcurrency();
	if (typeof override !== 'number' || !Number.isFinite(override)) return base;
	return Math.max(1, Math.min(Math.floor(override), base));
}

async function prepareChunkParallel(
	chunk: PackEntry[],
	concurrency: number,
	shouldAbort: ShouldAbort,
): Promise<PreparedFile[]> {
	const out = new Array<PreparedFile>(chunk.length);
	let next = 0;
	const limit = Math.max(1, Math.min(concurrency, chunk.length));
	async function worker(): Promise<void> {
		for (;;) {
			if (isAborted(shouldAbort)) {
				throw new Error('Operation canceled');
			}
			const i = next;
			next += 1;
			if (i >= chunk.length) return;
			out[i] = await prepareFileAsync(chunk[i] as PackEntry);
		}
	}
	const workers: Promise<void>[] = [];
	for (let w = 0; w < limit; w += 1) {
		workers.push(worker());
	}
	await Promise.all(workers);
	return out;
}

// Standard ZIP structures (PK\x03\x04 local, PK\x01\x02 central, PK\x05\x06 EOCD).
// Preparation (read/deflate) is parallelized in bounded chunks; the final
// file write stays strictly sequential in entry order (deterministic layout).
async function writeSimpleZip(
	entries: PackEntry[],
	outputPakPath: string,
	progressCallback?: RepackProgressCallback,
	shouldAbort: ShouldAbort = () => false,
	concurrencyOverride?: number,
): Promise<void> {
	const fd = openSync(outputPakPath, 'w');
	const centralParts: Buffer[] = [];
	let centralCount = 0;
	let offset = 0;
	const concurrency = effectiveRepakConcurrency(concurrencyOverride);
	// Bounded chunk: parallel preparation without holding the whole PAK in RAM.
	const chunkSize = Math.max(8, concurrency * 2);
	try {
		for (let start = 0; start < entries.length; start += chunkSize) {
			if (isAborted(shouldAbort)) {
				throw new Error('Operation canceled');
			}
			const chunk = entries.slice(start, Math.min(start + chunkSize, entries.length));
			const preparedChunk = await prepareChunkParallel(chunk, concurrency, shouldAbort);
			for (let k = 0; k < preparedChunk.length; k += 1) {
				await new Promise((resolve) => setImmediate(resolve));
				if (isAborted(shouldAbort)) {
					throw new Error('Operation canceled');
				}
				const prepared = preparedChunk[k] as PreparedFile;
				const globalIndex = start + k;
				const localOffset = offset;

				const localHeader = Buffer.alloc(30);
			localHeader.writeUInt32LE(0x04034b50, 0);
			localHeader.writeUInt16LE(20, 4);
			localHeader.writeUInt16LE(0x0800, 6);
			localHeader.writeUInt16LE(prepared.method, 8);
			localHeader.writeUInt16LE(prepared.dosTime, 10);
			localHeader.writeUInt16LE(prepared.dosDate, 12);
			localHeader.writeUInt32LE(prepared.crc, 14);
			localHeader.writeUInt32LE(prepared.csize, 18);
			localHeader.writeUInt32LE(prepared.usize, 22);
			localHeader.writeUInt16LE(prepared.nameBuf.length, 26);
			localHeader.writeUInt16LE(0, 28);
			writeAll(fd, localHeader);
			writeAll(fd, prepared.nameBuf);
			writeAll(fd, prepared.cdata);
			offset += localHeader.length + prepared.nameBuf.length + prepared.cdata.length;

			const centralHeader = Buffer.alloc(46);
			centralHeader.writeUInt32LE(0x02014b50, 0);
			centralHeader.writeUInt16LE(20, 4);
			centralHeader.writeUInt16LE(20, 6);
			centralHeader.writeUInt16LE(0x0800, 8);
			centralHeader.writeUInt16LE(prepared.method, 10);
			centralHeader.writeUInt16LE(prepared.dosTime, 12);
			centralHeader.writeUInt16LE(prepared.dosDate, 14);
			centralHeader.writeUInt32LE(prepared.crc, 16);
			centralHeader.writeUInt32LE(prepared.csize, 20);
			centralHeader.writeUInt32LE(prepared.usize, 24);
			centralHeader.writeUInt16LE(prepared.nameBuf.length, 28);
			centralHeader.writeUInt16LE(0, 30);
			centralHeader.writeUInt16LE(0, 32);
			centralHeader.writeUInt16LE(0, 34);
			centralHeader.writeUInt16LE(0, 36);
			centralHeader.writeUInt32LE(prepared.entry.isDirectory ? 0x10 : 0x20, 38);
			centralHeader.writeUInt32LE(localOffset, 42);
			centralParts.push(centralHeader, prepared.nameBuf);
			centralCount += 1;

			reportFileProgress(progressCallback, outputPakPath, globalIndex + 1, entries.length, prepared.entry.name, prepared.usize);
			}
		}

		const cdStart = offset;
		let cdSize = 0;
		for (const part of centralParts) {
			writeAll(fd, part);
			cdSize += part.length;
		}
		offset += cdSize;

		const eocd = Buffer.alloc(22);
		eocd.writeUInt32LE(0x06054b50, 0);
		eocd.writeUInt16LE(0, 4);
		eocd.writeUInt16LE(0, 6);
		eocd.writeUInt16LE(centralCount, 8);
		eocd.writeUInt16LE(centralCount, 10);
		eocd.writeUInt32LE(cdSize, 12);
		eocd.writeUInt32LE(cdStart, 16);
		eocd.writeUInt16LE(0, 20);
		writeAll(fd, eocd);
		offset += eocd.length;
	} finally {
		closeSync(fd);
	}
}

// AION pak structures: inverse of extractPakToFolder in unpak.ts.
// Signatures 0xFBFCB4AF (local) / 0xFDFEB4AF (central) / 0xF9FAB4AF (EOCD)
// with ZIP-identical header layouts; file data prefix XORed with TABLE1
// (version 1, offset (csize & 31) * 32) or TABLE2 (otherwise, offset
// csize & 1023). CRC stored signed, as the reader compares via readInt32LE.
async function writeAionPak(
	entries: PackEntry[],
	outputPakPath: string,
	version: number,
	progressCallback?: RepackProgressCallback,
	shouldAbort: ShouldAbort = () => false,
	concurrencyOverride?: number,
): Promise<void> {
	const fd = openSync(outputPakPath, 'w');
	const centralParts: Buffer[] = [];
	let centralCount = 0;
	let offset = 0;
	const concurrency = effectiveRepakConcurrency(concurrencyOverride);
	// Bounded chunk: parallel preparation without holding the whole PAK in RAM.
	const chunkSize = Math.max(8, concurrency * 2);
	try {
		for (let start = 0; start < entries.length; start += chunkSize) {
			if (isAborted(shouldAbort)) {
				throw new Error('Operation canceled');
			}
			const chunk = entries.slice(start, Math.min(start + chunkSize, entries.length));
			const preparedChunk = await prepareChunkParallel(chunk, concurrency, shouldAbort);
			for (let k = 0; k < preparedChunk.length; k += 1) {
				await new Promise((resolve) => setImmediate(resolve));
				if (isAborted(shouldAbort)) {
					throw new Error('Operation canceled');
				}
				const prepared = preparedChunk[k] as PreparedFile;
				const globalIndex = start + k;
				const localOffset = offset;
				// Signed CRC as the reader compares via readInt32LE; 0 for directories.
				const crcSigned = prepared.entry.isDirectory ? 0 : prepared.crc | 0;

				const cdata = Buffer.from(prepared.cdata);
				const { table, tbloff } = aionXorParams(version, prepared.csize);
				const prefixSize = Math.min(32, prepared.csize);
				for (let j = 0; j < prefixSize; j++) {
					cdata[j] ^= table[tbloff + j];
				}

			const localHeader = Buffer.alloc(30);
			localHeader.writeUInt32LE(0xfbfcb4af, 0);
			localHeader.writeUInt16LE(20, 4);
			localHeader.writeUInt16LE(0, 6);
			localHeader.writeUInt16LE(prepared.method, 8);
			localHeader.writeUInt16LE(prepared.dosTime, 10);
			localHeader.writeUInt16LE(prepared.dosDate, 12);
			localHeader.writeInt32LE(crcSigned, 14);
			localHeader.writeUInt32LE(prepared.csize, 18);
			localHeader.writeUInt32LE(prepared.usize, 22);
			localHeader.writeUInt16LE(prepared.nameBuf.length, 26);
			localHeader.writeUInt16LE(0, 28);
			writeAll(fd, localHeader);
			writeAll(fd, prepared.nameBuf);
			writeAll(fd, cdata);
			offset += localHeader.length + prepared.nameBuf.length + cdata.length;

			const centralHeader = Buffer.alloc(46);
			centralHeader.writeUInt32LE(0xfdfeb4af, 0);
			centralHeader.writeUInt16LE(20, 4);
			centralHeader.writeUInt16LE(20, 6);
			centralHeader.writeUInt16LE(0, 8);
			centralHeader.writeUInt16LE(prepared.method, 10);
			centralHeader.writeUInt16LE(prepared.dosTime, 12);
			centralHeader.writeUInt16LE(prepared.dosDate, 14);
			centralHeader.writeInt32LE(crcSigned, 16);
			centralHeader.writeUInt32LE(prepared.csize, 20);
			centralHeader.writeUInt32LE(prepared.usize, 24);
			centralHeader.writeUInt16LE(prepared.nameBuf.length, 28);
			centralHeader.writeUInt16LE(0, 30);
			centralHeader.writeUInt16LE(0, 32);
			centralHeader.writeUInt16LE(0, 34);
			centralHeader.writeUInt16LE(0, 36);
			centralHeader.writeUInt32LE(prepared.entry.isDirectory ? 0x10 : 0x20, 38);
			centralHeader.writeUInt32LE(localOffset, 42);
			centralParts.push(centralHeader, prepared.nameBuf);
			centralCount += 1;

			reportFileProgress(progressCallback, outputPakPath, globalIndex + 1, entries.length, prepared.entry.name, prepared.usize);
			}
		}

		const cdStart = offset;
		let cdSize = 0;
		for (const part of centralParts) {
			writeAll(fd, part);
			cdSize += part.length;
		}
		offset += cdSize;

		const eocd = Buffer.alloc(22);
		eocd.writeUInt32LE(0xf9fab4af, 0);
		eocd.writeUInt16LE(0, 4);
		eocd.writeUInt16LE(0, 6);
		eocd.writeUInt16LE(centralCount, 8);
		eocd.writeUInt16LE(centralCount, 10);
		eocd.writeUInt32LE(cdSize, 12);
		eocd.writeUInt32LE(cdStart, 16);
		eocd.writeUInt16LE(0, 20);
		writeAll(fd, eocd);
		offset += eocd.length;
	} finally {
		closeSync(fd);
	}
}

export async function createAionPak(
	folderPath: string,
	outputPakPath: string,
	version = 0,
	progressCallback?: RepackProgressCallback,
	shouldAbort: ShouldAbort = () => false,
	concurrency?: number,
	rejectEmpty = false,
): Promise<void> {
	const rootFolder = path.resolve(folderPath);
	if (!existsSync(rootFolder) || !statSync(rootFolder).isDirectory()) {
		throw new Error(`Input folder not found: ${rootFolder}`);
	}

	const outputDir = path.dirname(outputPakPath);
	mkdirSync(outputDir, { recursive: true });

	cancelRequested = false;
	const entries = collectPackEntries(rootFolder);
	if (rejectEmpty && !entries.some((entry) => !entry.isDirectory)) {
		throw new Error('No files to repack');
	}
	await writeAionPak(entries, outputPakPath, version, progressCallback, shouldAbort, concurrency);
	if (progressCallback) {
		progressCallback({
			stage: 'repak',
			current: 100,
			total: 100,
			percent: 100,
			output: outputPakPath,
		});
	}
}

function pathInside(root: string, candidate: string): boolean {
	const base = path.resolve(root);
	const target = path.resolve(candidate);
	return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * Pack files already on disk (DB manifest) without copying them to a staging
 * folder first. Missing paths are skipped. Parent directories are synthesized
 * so the archive layout matches a folder walk.
 */
export async function createAionPakFromFiles(
	srcRoot: string,
	relativeFiles: readonly string[],
	outputPakPath: string,
	version = 0,
	progressCallback?: RepackProgressCallback,
	shouldAbort: ShouldAbort = () => false,
	concurrency?: number,
): Promise<number> {
	const root = path.resolve(srcRoot);
	cancelRequested = false;
	const entries: PackEntry[] = [];
	const dirNames = new Set<string>();
	for (let i = 0; i < relativeFiles.length; i += 1) {
		if (isAborted(shouldAbort)) throw new Error('Operation canceled');
		const rel = String(relativeFiles[i] ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
		if (rel.length === 0 || rel.endsWith('/') || rel.split('/').includes('..')) continue;
		const abs = path.resolve(root, ...rel.split('/'));
		if (!pathInside(root, abs)) continue;
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(abs);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		entries.push({ name: rel, absolutePath: abs, isDirectory: false, mtime: stat.mtime });
		const parts = rel.split('/');
		parts.pop();
		let acc = '';
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			const dirName = `${acc}/`;
			if (dirNames.has(dirName)) continue;
			dirNames.add(dirName);
			entries.push({ name: dirName, absolutePath: '', isDirectory: true, mtime: stat.mtime });
		}
		if ((i & 255) === 0) await new Promise<void>((resolve) => setImmediate(resolve));
	}
	const fileCount = entries.reduce((n, entry) => n + (entry.isDirectory ? 0 : 1), 0);
	if (fileCount === 0) {
		throw new Error(`No source files found under '${root}'`);
	}
	entries.sort((a, b) => {
		if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
		return a.isDirectory ? -1 : 1;
	});
	mkdirSync(path.dirname(outputPakPath), { recursive: true });
	cancelRequested = false;
	await writeAionPak(entries, outputPakPath, version, progressCallback, shouldAbort, concurrency);
	progressCallback?.({ stage: 'repak', current: 100, total: 100, percent: 100, output: outputPakPath });
	return fileCount;
}

export async function createSimpleZipPak(
	folderPath: string,
	outputPakPath: string,
	progressCallback?: RepackProgressCallback,
	shouldAbort: ShouldAbort = () => false,
	concurrency?: number,
): Promise<void> {
	const rootFolder = path.resolve(folderPath);
	if (!existsSync(rootFolder) || !statSync(rootFolder).isDirectory()) {
		throw new Error(`Input folder not found: ${rootFolder}`);
	}

	const outputDir = path.dirname(outputPakPath);
	mkdirSync(outputDir, { recursive: true });

	cancelRequested = false;
	const entries = collectPackEntries(rootFolder);
	await writeSimpleZip(entries, outputPakPath, progressCallback, shouldAbort, concurrency);
	if (progressCallback) {
		progressCallback({
			stage: 'repak',
			current: 100,
			total: 100,
			percent: 100,
			output: outputPakPath,
		});
	}
}

// ---------------------------------------------------------------------------
// Incremental add/replace without recompressing existing entries.
//
// The AION/ZIP layout stores local headers + data contiguously followed by a
// central directory and an EOCD. To remove an entry its bytes must be dropped
// (sequential AION readers do not use the central directory), which requires
// rewriting the body. Existing entries are copied verbatim (already
// compressed/XORed); only the new/replaced files are compressed.
// When there is nothing to replace, the cheaper in-place append is used:
// truncate at the central directory start, append the new locals and rewrite
// the central directory + EOCD (existing entry offsets stay valid).
// ---------------------------------------------------------------------------

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const AION_LOCAL_SIG = 0xfbfcb4af;
const AION_CENTRAL_SIG = 0xfdfeb4af;
const AION_EOCD_SIG = 0xf9fab4af;

export type PakArchiveFormat = 'zip' | 'aion';

export interface PakAddEntry {
	name: string;
	absolutePath: string;
	isDirectory: boolean;
	mtime: Date;
}

function sanitizeArchiveName(name: string): string | null {
	const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
	if (normalized.length === 0) return null;
	for (const segment of normalized.split('/')) {
		if (segment === '' || segment === '.' || segment === '..') return null;
		if (/^[a-zA-Z]:/.test(segment)) return null;
	}
	return normalized;
}

/** Walk dropped files/folders into archive entries. Runs in the RePAK worker. */
export function collectAddSources(sourcePaths: readonly string[], targetFolder?: string): PakAddEntry[] {
	const entries: PakAddEntry[] = [];
	const seen = new Set<string>();
	const push = (entry: PakAddEntry): void => {
		const key = entry.name.replace(/\\/g, '/').toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		entries.push(entry);
	};
	const target = targetFolder ? sanitizeArchiveName(targetFolder.replace(/^\/+|\/+$/g, '')) : null;
	if (target) {
		let acc = '';
		for (const part of target.split('/')) {
			acc = acc ? `${acc}/${part}` : part;
			push({ name: `${acc}/`, absolutePath: '', isDirectory: true, mtime: new Date() });
		}
	}
	const prefix = target ? `${target}/` : '';
	const walk = (dir: string, currentPrefix: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (name === '.pak-metadata.json' || name.startsWith('._tmp_repack')) continue;
			const full = path.join(dir, name);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(full);
			} catch {
				continue;
			}
			const rel = currentPrefix ? `${currentPrefix}/${name}` : name;
			const archiveName = sanitizeArchiveName(rel);
			if (!archiveName) continue;
			if (stat.isDirectory()) {
				push({ name: `${archiveName}/`, absolutePath: full, isDirectory: true, mtime: stat.mtime });
				walk(full, archiveName);
			} else if (stat.isFile()) {
				const lower = name.toLowerCase();
				if (lower.endsWith('.db') || lower.endsWith('.pak')) continue;
				push({ name: archiveName, absolutePath: full, isDirectory: false, mtime: stat.mtime });
			}
		}
	};
	for (const source of sourcePaths) {
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(source);
		} catch {
			continue;
		}
		const base = path.basename(source);
		if (stat.isDirectory()) {
			const rootName = sanitizeArchiveName(`${prefix}${base}`);
			if (!rootName) continue;
			push({ name: `${rootName}/`, absolutePath: source, isDirectory: true, mtime: stat.mtime });
			walk(source, rootName);
		} else if (stat.isFile()) {
			const archiveName = sanitizeArchiveName(`${prefix}${base}`);
			if (!archiveName) continue;
			push({ name: archiveName, absolutePath: source, isDirectory: false, mtime: stat.mtime });
		}
	}
	return entries;
}

export interface PakAddOptions {
	overwrite?: boolean;
	version?: number;
	onProgress?: RepackProgressCallback;
	shouldAbort?: ShouldAbort;
}

export interface PakAddResult {
	added: number;
	replaced: number;
	skipped: number;
	total: number;
	conflicts?: string[];
}

interface CentralRecord {
	name: string;
	nameLower: string;
	record: Buffer;
	localOffset: number;
}

interface EocdInfo {
	format: PakArchiveFormat;
	eocdOffset: number;
	entriesTotal: number;
	cdSize: number;
	cdOffset: number;
	commentLength: number;
}

function readAtSync(fd: number, length: number, position: number): Buffer {
	const buffer = Buffer.alloc(length);
	let read = 0;
	while (read < length) {
		const n = readSync(fd, buffer, read, length - read, position + read);
		if (n <= 0) {
			throw new Error(`Unexpected end of pak at offset ${position + read}`);
		}
		read += n;
	}
	return buffer;
}

function findEocd(fd: number, fileSize: number): EocdInfo {
	const tailSize = Math.min(fileSize, 22 + 65535);
	const tail = readAtSync(fd, tailSize, fileSize - tailSize);
	for (let i = tail.length - 22; i >= 0; i -= 1) {
		const sig = tail.readUInt32LE(i);
		let format: PakArchiveFormat | null = null;
		if (sig === ZIP_EOCD_SIG) format = 'zip';
		else if (sig === AION_EOCD_SIG) format = 'aion';
		if (!format) continue;
		const commentLength = tail.readUInt16LE(i + 20);
		const eocdOffset = fileSize - tailSize + i;
		if (eocdOffset + 22 + commentLength !== fileSize) continue;
		return {
			format,
			eocdOffset,
			entriesTotal: tail.readUInt16LE(i + 10),
			cdSize: tail.readUInt32LE(i + 12),
			cdOffset: tail.readUInt32LE(i + 16),
			commentLength,
		};
	}
	throw new Error('PAK end-of-central-directory not found');
}

function readCentralRecords(fd: number, cdOffset: number, cdSize: number): CentralRecord[] {
	if (cdSize <= 0) return [];
	const central = readAtSync(fd, cdSize, cdOffset);
	const records: CentralRecord[] = [];
	let pos = 0;
	while (pos + 46 <= central.length) {
		const sig = central.readUInt32LE(pos);
		if (sig !== ZIP_CENTRAL_SIG && sig !== AION_CENTRAL_SIG) break;
		const nameLength = central.readUInt16LE(pos + 28);
		const extraLength = central.readUInt16LE(pos + 30);
		const commentLength = central.readUInt16LE(pos + 32);
		const localOffset = central.readUInt32LE(pos + 42);
		const recordLength = 46 + nameLength + extraLength + commentLength;
		if (pos + recordLength > central.length) break;
		const name = central.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
		records.push({
			name,
			nameLower: name.replace(/\\/g, '/').toLowerCase(),
			record: Buffer.from(central.subarray(pos, pos + recordLength)),
			localOffset,
		});
		pos += recordLength;
	}
	return records;
}

function absoluteOffsetInCentralRecord(): number {
	return 42;
}

function patchCentralOffset(record: Buffer, localOffset: number): void {
	record.writeUInt32LE(localOffset, absoluteOffsetInCentralRecord());
}

function buildEocd(format: PakArchiveFormat, count: number, cdSize: number, cdStart: number): Buffer {
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(format === 'zip' ? ZIP_EOCD_SIG : AION_EOCD_SIG, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(count & 0xffff, 8);
	eocd.writeUInt16LE(count & 0xffff, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(cdStart, 16);
	eocd.writeUInt16LE(0, 20);
	return eocd;
}

function prepareNewEntry(entry: PakAddEntry): PackEntry {
	return {
		name: entry.name.replace(/\\/g, '/'),
		absolutePath: entry.absolutePath,
		isDirectory: entry.isDirectory,
		mtime: entry.mtime,
	};
}

function preparedDirectoriesFirst(entries: PakAddEntry[]): PakAddEntry[] {
	return [...entries].sort((a, b) => {
		if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
		return a.isDirectory ? -1 : 1;
	});
}

// Writes a single local entry and returns its central record + bytes written.
function writePreparedEntry(
	fd: number,
	prepared: PreparedFile,
	format: PakArchiveFormat,
	version: number,
	localOffset: number,
): { central: Buffer; size: number } {
	const nameBuf = prepared.nameBuf;
	const isDirectory = prepared.entry.isDirectory;
	let data = prepared.cdata;
	if (format === 'aion' && data.length > 0) {
		data = Buffer.from(data);
		const { table, tbloff } = aionXorParams(version, prepared.csize);
		const prefixSize = Math.min(32, prepared.csize);
		for (let j = 0; j < prefixSize; j += 1) {
			data[j] ^= table[tbloff + j];
		}
	}
	const crcSigned = isDirectory ? 0 : prepared.crc | 0;

	const localHeader = Buffer.alloc(30);
	if (format === 'zip') {
		localHeader.writeUInt32LE(ZIP_LOCAL_SIG, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0x0800, 6);
		localHeader.writeUInt16LE(prepared.method, 8);
		localHeader.writeUInt16LE(prepared.dosTime, 10);
		localHeader.writeUInt16LE(prepared.dosDate, 12);
		localHeader.writeUInt32LE(prepared.crc, 14);
		localHeader.writeUInt32LE(prepared.csize, 18);
		localHeader.writeUInt32LE(prepared.usize, 22);
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28);
	} else {
		localHeader.writeUInt32LE(AION_LOCAL_SIG, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0, 6);
		localHeader.writeUInt16LE(prepared.method, 8);
		localHeader.writeUInt16LE(prepared.dosTime, 10);
		localHeader.writeUInt16LE(prepared.dosDate, 12);
		localHeader.writeInt32LE(crcSigned, 14);
		localHeader.writeUInt32LE(prepared.csize, 18);
		localHeader.writeUInt32LE(prepared.usize, 22);
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28);
	}

	const centralHeader = Buffer.alloc(46);
	if (format === 'zip') {
		centralHeader.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x0800, 8);
		centralHeader.writeUInt16LE(prepared.method, 10);
		centralHeader.writeUInt16LE(prepared.dosTime, 12);
		centralHeader.writeUInt16LE(prepared.dosDate, 14);
		centralHeader.writeUInt32LE(prepared.crc, 16);
		centralHeader.writeUInt32LE(prepared.csize, 20);
		centralHeader.writeUInt32LE(prepared.usize, 24);
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(isDirectory ? 0x10 : 0x20, 38);
		centralHeader.writeUInt32LE(localOffset, 42);
	} else {
		centralHeader.writeUInt32LE(AION_CENTRAL_SIG, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0, 8);
		centralHeader.writeUInt16LE(prepared.method, 10);
		centralHeader.writeUInt16LE(prepared.dosTime, 12);
		centralHeader.writeUInt16LE(prepared.dosDate, 14);
		centralHeader.writeInt32LE(crcSigned, 16);
		centralHeader.writeUInt32LE(prepared.csize, 20);
		centralHeader.writeUInt32LE(prepared.usize, 24);
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(isDirectory ? 0x10 : 0x20, 38);
		centralHeader.writeUInt32LE(localOffset, 42);
	}

	let cursor = localOffset;
	cursor = writeAllAt(fd, localHeader, cursor);
	cursor = writeAllAt(fd, nameBuf, cursor);
	if (data.length > 0 && !isDirectory) {
		cursor = writeAllAt(fd, data, cursor);
	}
	return { central: Buffer.concat([centralHeader, nameBuf]), size: cursor - localOffset };
}

/**
 * Adds/replaces entries in an existing PAK without recompressing the entries
 * that are kept. Returns counts. Never leaves the file in a partially written
 * state on failure (the compaction path writes a temp file and renames it).
 */
export async function addEntriesToPak(
	pakPath: string,
	newEntries: PakAddEntry[],
	options: PakAddOptions = {},
): Promise<PakAddResult> {
	const overwrite = options.overwrite !== false;
	const version = options.version ?? 0;
	const onProgress = options.onProgress;
	const shouldAbort = options.shouldAbort ?? (() => false);

	const stat = statSync(pakPath);
	const fileSize = stat.size;
	const readFd = openSync(pakPath, 'r');
	let eocd: EocdInfo | null = null;
	let central: CentralRecord[] = [];
	try {
		eocd = findEocd(readFd, fileSize);
		central = readCentralRecords(readFd, eocd.cdOffset, eocd.cdSize);
	} finally {
		closeSync(readFd);
	}
	if (!eocd) {
		throw new Error('PAK end-of-central-directory not found');
	}
	const format = eocd.format;

	{
		const existingFileLower = new Set<string>();
		const existingDirLower = new Set<string>();
		for (const rec of central) {
			if (rec.name.endsWith('/') || rec.name.endsWith('\\')) existingDirLower.add(rec.nameLower);
			else existingFileLower.add(rec.nameLower);
		}

		const replaceLower = new Set<string>();
		const toAdd: PakAddEntry[] = [];
		const conflicts: string[] = [];
		let skipped = 0;
		let replaced = 0;

		for (const rawEntry of preparedDirectoriesFirst(newEntries)) {
			const name = rawEntry.name.replace(/\\/g, '/');
			const lower = name.toLowerCase();
			if (rawEntry.isDirectory || name.endsWith('/')) {
				if (existingDirLower.has(lower)) continue;
				existingDirLower.add(lower);
				toAdd.push({ ...rawEntry, name });
				continue;
			}
			if (existingFileLower.has(lower)) {
				conflicts.push(name);
				if (!overwrite) {
					skipped += 1;
					continue;
				}
				replaceLower.add(lower);
				existingFileLower.delete(lower);
				replaced += 1;
				toAdd.push({ ...rawEntry, name });
				continue;
			}
			existingFileLower.add(lower);
			toAdd.push({ ...rawEntry, name });
		}

		// Conflicts without overwrite: do not touch the pak; let the caller
		// confirm (a single confirmation covers every conflicting file).
		if (conflicts.length > 0 && !overwrite) {
			return { added: 0, replaced: 0, skipped: 0, total: 0, conflicts };
		}

		const added = toAdd.length - replaced;
		const total = toAdd.length;

		// CPU preparation only for new/replaced files.
		const preparedEntries: PreparedFile[] = [];
		for (let i = 0; i < toAdd.length; i += 1) {
			if (isAborted(shouldAbort)) throw new Error('Operation canceled');
			preparedEntries.push(await prepareFileAsync(prepareNewEntry(toAdd[i] as PakAddEntry)));
			if (i % 50 === 49) await new Promise((resolve) => setImmediate(resolve));
		}

		if (toAdd.length === 0) {
			return { added: 0, replaced, skipped, total: 0 };
		}

		cancelRequested = false;

		if (replaceLower.size === 0) {
			// Fast path: in-place append, existing entries stay untouched.
			const writeFd = openSync(pakPath, 'r+');
			try {
				writeInPlaceAppend(writeFd, eocd, central, preparedEntries, format, version, onProgress, shouldAbort);
			} finally {
				closeSync(writeFd);
			}
		} else {
			writeCompactedPak(pakPath, eocd, central, replaceLower, preparedEntries, format, version, onProgress, shouldAbort);
		}

		if (onProgress) {
			onProgress({ stage: 'repak', current: total, total, percent: 100, output: pakPath });
		}
		return { added, replaced, skipped, total };
	}
}

function writeInPlaceAppend(
	fd: number,
	eocd: EocdInfo,
	central: CentralRecord[],
	preparedEntries: PreparedFile[],
	format: PakArchiveFormat,
	version: number,
	onProgress: RepackProgressCallback | undefined,
	shouldAbort: ShouldAbort,
): void {
	// Drop the old central directory + EOCD, append new locals.
	ftruncateSync(fd, eocd.cdOffset);
	let offset = eocd.cdOffset;
	const newCentrals: Buffer[] = [];
	for (let i = 0; i < preparedEntries.length; i += 1) {
		if (isAborted(shouldAbort)) throw new Error('Operation canceled');
		const prepared = preparedEntries[i] as PreparedFile;
		const { central: centralRecord, size } = writePreparedEntry(fd, prepared, format, version, offset);
		offset += size;
		newCentrals.push(centralRecord);
		reportFileProgress(onProgress, '', i + 1, preparedEntries.length, prepared.entry.name, prepared.usize);
	}
	const cdStart = offset;
	let cdSize = 0;
	for (const rec of central) {
		offset = writeAllAt(fd, rec.record, offset);
		cdSize += rec.record.length;
	}
	for (const rec of newCentrals) {
		offset = writeAllAt(fd, rec, offset);
		cdSize += rec.length;
	}
	const count = central.length + newCentrals.length;
	offset = writeAllAt(fd, buildEocd(format, count, cdSize, cdStart), offset);
	ftruncateSync(fd, offset);
}

function writeCompactedPak(
	pakPath: string,
	eocd: EocdInfo,
	central: CentralRecord[],
	replaceLower: ReadonlySet<string>,
	preparedEntries: PreparedFile[],
	format: PakArchiveFormat,
	version: number,
	onProgress: RepackProgressCallback | undefined,
	shouldAbort: ShouldAbort,
): void {
	const dir = path.dirname(pakPath);
	const tempPath = path.join(dir, `._tmp_repack_${Date.now()}_${Math.random().toString(16).slice(2)}.pak`);
	const inFd = openSync(pakPath, 'r');
	const outFd = openSync(tempPath, 'w');
	let committed = false;
	try {
		try {
		let offset = 0;
		let pos = 0;
		const patchedOffsets = new Map<string, number>();
		while (pos < eocd.cdOffset) {
			if (isAborted(shouldAbort)) throw new Error('Operation canceled');
			const sig = readAtSync(inFd, 4, pos);
			const sigValue = sig.readUInt32LE(0);
			if (sigValue === ZIP_LOCAL_SIG || sigValue === AION_LOCAL_SIG) {
				const header = readAtSync(inFd, 26, pos + 4);
				const csize = header.readUInt32LE(14);
				const nameLength = header.readUInt16LE(22);
				const extraLength = header.readUInt16LE(24);
				const recordLength = 30 + nameLength + extraLength + csize;
				const nameBuf = readAtSync(inFd, nameLength, pos + 30);
				const name = nameBuf.toString('utf8');
				const lower = name.replace(/\\/g, '/').toLowerCase();
				if (!replaceLower.has(lower)) {
					const raw = readAtSync(inFd, recordLength, pos);
					writeAll(outFd, raw);
					patchedOffsets.set(lower, offset);
					offset += recordLength;
				}
				pos += recordLength;
			} else if (sigValue === ZIP_CENTRAL_SIG || sigValue === AION_CENTRAL_SIG) {
				const header = readAtSync(inFd, 42, pos + 4);
				const nameLength = header.readUInt16LE(24);
				const extraLength = header.readUInt16LE(26);
				const commentLength = header.readUInt16LE(28);
				pos += 46 + nameLength + extraLength + commentLength;
			} else if (sigValue === ZIP_EOCD_SIG || sigValue === AION_EOCD_SIG) {
				break;
			} else {
				throw new Error(`Bad signature: ${sigValue}`);
			}
		}

		const newCentrals: Buffer[] = [];
		for (let i = 0; i < preparedEntries.length; i += 1) {
			if (isAborted(shouldAbort)) throw new Error('Operation canceled');
			const prepared = preparedEntries[i] as PreparedFile;
			const { central: centralRecord, size } = writePreparedEntry(outFd, prepared, format, version, offset);
			offset += size;
			newCentrals.push(centralRecord);
			reportFileProgress(onProgress, '', i + 1, preparedEntries.length, prepared.entry.name, prepared.usize);
		}

		const cdStart = offset;
		let cdSize = 0;
		for (const rec of central) {
			if (replaceLower.has(rec.nameLower)) continue;
			const newOffset = patchedOffsets.get(rec.nameLower);
			const record = Buffer.from(rec.record);
			if (typeof newOffset === 'number') patchCentralOffset(record, newOffset);
			offset = writeAllAt(outFd, record, offset);
			cdSize += record.length;
		}
		for (const rec of newCentrals) {
			offset = writeAllAt(outFd, rec, offset);
			cdSize += rec.length;
		}
		const count = central.length - replaceLower.size + newCentrals.length;
		writeAllAt(outFd, buildEocd(format, count, cdSize, cdStart), offset);
		} finally {
			closeSync(outFd);
			closeSync(inFd);
		}
		renameSync(tempPath, pakPath);
		committed = true;
	} finally {
		if (!committed) {
			try {
				unlinkSync(tempPath);
			} catch {
				// ignore cleanup failure
			}
		}
	}
}

/** Lists the file names (posix, no directories) inside an existing pak. */
export function listPakEntryNames(pakPath: string): string[] {
	const stat = statSync(pakPath);
	const fd = openSync(pakPath, 'r');
	try {
		const eocd = findEocd(fd, stat.size);
		const central = readCentralRecords(fd, eocd.cdOffset, eocd.cdSize);
		return central
			.map((rec) => rec.name.replace(/\\/g, '/'))
			.filter((name) => name.length > 0 && !name.endsWith('/'));
	} finally {
		closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// Remove entries from an existing PAK. Files may be removed individually;
// folders (names ending with `/`) remove every entry under that prefix.
// Rewrites the body copying kept entries verbatim (no recompression).
// ---------------------------------------------------------------------------

export interface PakRemoveResult {
	removed: number;
}

export async function removeEntriesFromPak(
	pakPath: string,
	removeEntries: string[],
	options: PakAddOptions = {},
): Promise<PakRemoveResult> {
	const shouldAbort = options.shouldAbort ?? (() => false);
	const stat = statSync(pakPath);
	const readFd = openSync(pakPath, 'r');
	let eocd: EocdInfo | null = null;
	let central: CentralRecord[] = [];
	try {
		eocd = findEocd(readFd, stat.size);
		central = readCentralRecords(readFd, eocd.cdOffset, eocd.cdSize);
	} finally {
		closeSync(readFd);
	}
	if (!eocd) {
		throw new Error('PAK end-of-central-directory not found');
	}

	const exact = new Set<string>();
	const prefixes: string[] = [];
	for (const raw of removeEntries) {
		const name = raw.replace(/\\/g, '/').replace(/^\/+/, '');
		if (name.length === 0) continue;
		const lower = name.toLowerCase();
		if (name.endsWith('/')) {
			prefixes.push(lower);
		} else {
			exact.add(lower);
		}
	}
	const isRemoved = (lower: string): boolean =>
		exact.has(lower) || prefixes.some((prefix) => lower.startsWith(prefix));
	if (exact.size === 0 && prefixes.length === 0) {
		return { removed: 0 };
	}

	const removeLower = new Set<string>();
	for (const rec of central) {
		if (isRemoved(rec.nameLower)) removeLower.add(rec.nameLower);
	}
	if (removeLower.size === 0) {
		return { removed: 0 };
	}

	cancelRequested = false;
	writeCompactedPak(pakPath, eocd, central, removeLower, [], eocd.format, options.version ?? 0, options.onProgress, shouldAbort);
	options.onProgress?.({ stage: 'repak', current: 1, total: 1, percent: 100, output: pakPath });
	return { removed: removeLower.size };
}
