import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { inflateRawSync, inflateSync } from 'zlib';
import { TABLE1, TABLE2, crc32, crc32Unsigned } from '../parse/pak-codec';

export interface UnpackProgress {
	stage: 'unpack';
	current: number;
	total: number;
	percent: number;
	fileName: string;
	outputFolder: string;
	bytesDelta?: number;
}

export type ShouldAbort = () => boolean;
export type UnpackProgressCallback = (info: UnpackProgress) => void;

function detectVersion(cdata: Buffer, usize: number, crc: number, compMethod: number): number | null {
	if (compMethod !== 0 && compMethod !== 8) {
		throw new Error(`Unknown compression method ${compMethod}!`);
	}
	const csize = cdata.length;
	const xorsize = Math.min(32, csize);
	let tbloff = (csize & 31) * 32;
	const table = TABLE1;
	for (let i = 0; i < xorsize; i++) {
		cdata[i] ^= table[tbloff + i];
	}

	let compOk = true;
	let bytes = Buffer.from(cdata);
	if (compMethod === 8) {
		try {
			bytes = inflateRawSync(bytes);
		} catch (err) {
			compOk = false;
		}
	}

	for (let i = 0; i < xorsize; i++) {
		cdata[i] ^= table[tbloff + i];
	}

	if (compOk) {
		if (bytes.length === usize && crc === crc32(bytes)) {
			return 1;
		}
	}

	tbloff = csize & 1023;
	const tableB = TABLE2;
	for (let i = 0; i < xorsize; i++) {
		cdata[i] ^= tableB[tbloff + i];
	}

	compOk = true;
	bytes = Buffer.from(cdata);
	if (compMethod === 8) {
		try {
			bytes = inflateRawSync(bytes);
		} catch (err) {
			compOk = false;
		}
	}

	for (let i = 0; i < xorsize; i++) {
		cdata[i] ^= tableB[tbloff + i];
	}

	if (compOk) {
		if (bytes.length === usize && crc === crc32(bytes)) {
			return 2;
		}
	}
	return null;
}

export async function countPakEntries(fd: number, fileSize: number, shouldAbort: ShouldAbort = () => false): Promise<number> {
	let count = 0;
	let offset = 0;

	while (offset < fileSize) {
		await new Promise((resolve) => setImmediate(resolve));
		if (shouldAbort()) {
			throw new Error('Operation canceled');
		}
		const sigBuf = Buffer.alloc(4);
		if (readSync(fd, sigBuf, 0, 4, offset) !== 4) {
			break;
		}
		offset += 4;
		const sig = sigBuf.readUInt32LE(0);

		if (sig === 0xFBFCB4AF) {
			const header = Buffer.alloc(26);
			readSync(fd, header, 0, 26, offset);
			offset += 26;
			const compMethod = header.readUInt16LE(4);
			const compressedSize = header.readUInt32LE(14);
			const uncompressedSize = header.readUInt32LE(18);
			const fileNameLength = header.readUInt16LE(22);
			const extraFieldLength = header.readUInt16LE(24);
			let isDirectory = compMethod === 0 && uncompressedSize === 0;
			if (fileNameLength > 0) {
				const fnameBuf = Buffer.alloc(fileNameLength);
				readSync(fd, fnameBuf, 0, fileNameLength, offset);
				const entryName = fnameBuf.toString('utf8');
				if (entryName.endsWith('/') || entryName.endsWith('\\')) {
					isDirectory = true;
				}
			}
			if (!isDirectory) {
				count += 1;
			}
			offset += fileNameLength + extraFieldLength;
			offset += compressedSize;
		} else if (sig === 0xFDFEB4AF) {
			const header = Buffer.alloc(42);
			readSync(fd, header, 0, 42, offset);
			offset += 42;
			const fileNameLength = header.readUInt16LE(24);
			const extraFieldLength = header.readUInt16LE(26);
			const commentLength = header.readUInt16LE(28);
			offset += fileNameLength + extraFieldLength + commentLength;
		} else if (sig === 0xF9FAB4AF) {
			offset += 18;
		} else {
			throw new Error(`Bad signature: ${sig}`);
		}
	}

	return count;
}

function isZipPak(inputPath: string): boolean {
	const fd = openSync(inputPath, 'r');
	try {
		const sigBuf = Buffer.alloc(4);
		if (readSync(fd, sigBuf, 0, 4, 0) !== 4) {
			return false;
		}
		return sigBuf.readUInt32LE(0) === 0x04034b50;
	} finally {
		closeSync(fd);
	}
}

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

interface ZipEntry {
	fileName: string;
	method: number;
	crc: number;
	csize: number;
	usize: number;
	localOffset: number;
}

export async function countFilesInPak(inputPath: string, shouldAbort: ShouldAbort = () => false): Promise<number> {
	if (isZipPak(inputPath)) {
		const fd = openSync(inputPath, 'r');
		try {
			const fileSize = statSync(inputPath).size;
			const entries = readZipEntries(fd, fileSize);
			let count = 0;
			for (const e of entries) {
				if (shouldAbort()) throw new Error('Operation canceled');
				if (!e.fileName.endsWith('/')) count += 1;
			}
			return count;
		} finally {
			closeSync(fd);
		}
	}
	const fd = openSync(inputPath, 'r');
	try {
		const fileSize = statSync(inputPath).size;
		return await countPakEntries(fd, fileSize, shouldAbort);
	} finally {
		closeSync(fd);
	}
}

/**
 * Lists only file entries (directories excluded) inside a PAK without
 * extracting data. Names are normalized to `/` separators.
 */
export async function listFilesInPak(inputPath: string, shouldAbort: ShouldAbort = () => false): Promise<string[]> {
	if (isZipPak(inputPath)) {
		const fd = openSync(inputPath, 'r');
		try {
			const fileSize = statSync(inputPath).size;
			const entries = readZipEntries(fd, fileSize);
			const files: string[] = [];
			for (const e of entries) {
				if (shouldAbort()) throw new Error('Operation canceled');
				if (e.fileName.endsWith('/')) continue;
				files.push(e.fileName.replace(/\\/g, '/'));
			}
			return files;
		} finally {
			closeSync(fd);
		}
	}

	const fd = openSync(inputPath, 'r');
	try {
		const fileSize = statSync(inputPath).size;
		const files: string[] = [];
		let offset = 0;

		while (offset < fileSize) {
			await new Promise((resolve) => setImmediate(resolve));
			if (shouldAbort()) {
				throw new Error('Operation canceled');
			}
			const sigBuf = Buffer.alloc(4);
			if (readSync(fd, sigBuf, 0, 4, offset) !== 4) {
				break;
			}
			offset += 4;
			const sig = sigBuf.readUInt32LE(0);

			if (sig === 0xFBFCB4AF) {
				const header = Buffer.alloc(26);
				readSync(fd, header, 0, 26, offset);
				offset += 26;
				const compMethod = header.readUInt16LE(4);
				const compressedSize = header.readUInt32LE(14);
				const uncompressedSize = header.readUInt32LE(18);
				const fileNameLength = header.readUInt16LE(22);
				const extraFieldLength = header.readUInt16LE(24);
				let isDirectory = compMethod === 0 && uncompressedSize === 0;
				if (fileNameLength > 0) {
					const fnameBuf = Buffer.alloc(fileNameLength);
					readSync(fd, fnameBuf, 0, fileNameLength, offset);
					const entryName = fnameBuf.toString('utf8');
					if (entryName.endsWith('/') || entryName.endsWith('\\')) {
						isDirectory = true;
					}
					if (!isDirectory) {
						files.push(entryName.replace(/\\/g, '/'));
					}
				}
				offset += fileNameLength + extraFieldLength;
				offset += compressedSize;
			} else if (sig === 0xFDFEB4AF) {
				const header = Buffer.alloc(42);
				readSync(fd, header, 0, 42, offset);
				offset += 42;
				const fileNameLength = header.readUInt16LE(24);
				const extraFieldLength = header.readUInt16LE(26);
				const commentLength = header.readUInt16LE(28);
				offset += fileNameLength + extraFieldLength + commentLength;
			} else if (sig === 0xF9FAB4AF) {
				offset += 18;
			} else {
				throw new Error(`Bad signature: ${sig}`);
			}
		}

		return files;
	} finally {
		closeSync(fd);
	}
}

export interface PakScanResult {
	/** File entry names (directories excluded), `/`-normalized. */
	files: string[];
	/** Detected AION XOR version (1 or 2); `null` for ZIP or empty paks. */
	version: number | null;
}

/**
 * Single scan of a PAK: file entry names + the AION XOR version, so parallel
 * extraction can split entries across workers and skip the per-entry version
 * probe. Cheap: only local headers (+ one payload for version detection).
 */
export async function scanPakEntries(inputPath: string, shouldAbort: ShouldAbort = () => false): Promise<PakScanResult> {
	if (isZipPak(inputPath)) {
		return { files: await listFilesInPak(inputPath, shouldAbort), version: null };
	}

	const fd = openSync(inputPath, 'r');
	try {
		const fileSize = statSync(inputPath).size;
		const files: string[] = [];
		let version: number | null = null;
		let offset = 0;
		let iter = 0;

		while (offset < fileSize) {
			if ((iter++ & 63) === 0) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (shouldAbort()) throw new Error('Operation canceled');
			const sigBuf = Buffer.alloc(4);
			if (readSync(fd, sigBuf, 0, 4, offset) !== 4) break;
			offset += 4;
			const sig = sigBuf.readUInt32LE(0);

			if (sig === 0xFBFCB4AF) {
				const header = Buffer.alloc(26);
				readSync(fd, header, 0, 26, offset);
				offset += 26;
				const compMethod = header.readUInt16LE(4);
				const crc = header.readInt32LE(10);
				const compressedSize = header.readUInt32LE(14);
				const uncompressedSize = header.readUInt32LE(18);
				const fileNameLength = header.readUInt16LE(22);
				const extraFieldLength = header.readUInt16LE(24);
				const fnameBuf = Buffer.alloc(fileNameLength);
				readSync(fd, fnameBuf, 0, fileNameLength, offset);
				offset += fileNameLength + extraFieldLength;
				if (version === null && uncompressedSize > 0) {
					const cdata = Buffer.alloc(compressedSize);
					readSync(fd, cdata, 0, compressedSize, offset);
					const detected = detectVersion(Buffer.from(cdata), uncompressedSize, crc, compMethod);
					if (detected === null) throw new Error('Unknown AION version');
					version = detected;
				}
				const name = fnameBuf.toString('utf8');
				const isDirectory = name.endsWith('/') || name.endsWith('\\') || (compMethod === 0 && uncompressedSize === 0);
				if (!isDirectory) files.push(name.replace(/\\/g, '/'));
				offset += compressedSize;
			} else if (sig === 0xFDFEB4AF) {
				const header = Buffer.alloc(42);
				readSync(fd, header, 0, 42, offset);
				offset += 42;
				const fileNameLength = header.readUInt16LE(24);
				const extraFieldLength = header.readUInt16LE(26);
				const commentLength = header.readUInt16LE(28);
				offset += fileNameLength + extraFieldLength + commentLength;
			} else if (sig === 0xF9FAB4AF) {
				offset += 18;
			} else {
				throw new Error(`Bad signature: ${sig}`);
			}
		}

		return { files, version };
	} finally {
		closeSync(fd);
	}
}

function normalizeEntryFilter(entryFilter?: ReadonlySet<string> | string[] | null): Set<string> | null {
	if (!entryFilter) return null;
	const values: string[] = Array.isArray(entryFilter) ? entryFilter : Array.from(entryFilter);
	if (values.length === 0) return null;
	const normalized = new Set<string>();
	for (const value of values) {
		normalized.add(String(value).replace(/\\/g, '/'));
	}
	return normalized;
}

function readAt(fd: number, length: number, position: number): Buffer {
	const buffer = Buffer.alloc(length);
	let read = 0;
	while (read < length) {
		const n = readSync(fd, buffer, read, length - read, position + read);
		if (n <= 0) {
			throw new Error(`Unexpected end of file at offset ${position + read}`);
		}
		read += n;
	}
	return buffer;
}

// EOCD: signature + 18 bytes (diskNum, cdDisk, entriesDisk, entriesTotal,
// cdSize, cdOffset, commentLen). The record starts at the last PK\x05\x06
// within the final 65557 bytes; comment length must reach EOF exactly.
function readZipEntries(fd: number, fileSize: number): ZipEntry[] {
	const tailSize = Math.min(fileSize, 22 + 65535);
	const tail = readAt(fd, tailSize, fileSize - tailSize);
	let eocdRel = -1;
	for (let i = tail.length - 22; i >= 0; i -= 1) {
		if (tail.readUInt32LE(i) === ZIP_EOCD_SIG) {
			eocdRel = i;
			break;
		}
	}
	if (eocdRel < 0) {
		throw new Error('ZIP end-of-central-directory not found');
	}
	const eocdAbs = fileSize - tailSize + eocdRel;
	const eocd = readAt(fd, 18, eocdAbs + 4);
	const entriesTotal = eocd.readUInt16LE(6);
	const cdSize = eocd.readUInt32LE(8);
	const cdOffset = eocd.readUInt32LE(12);
	const commentLen = eocd.readUInt16LE(16);
	if (eocdAbs + 22 + commentLen !== fileSize) {
		throw new Error('ZIP end-of-central-directory is corrupt (comment length mismatch)');
	}
	if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		throw new Error('ZIP64 archives are not supported');
	}

	const central = readAt(fd, cdSize, cdOffset);
	const entries: ZipEntry[] = [];
	let pos = 0;
	for (let i = 0; i < entriesTotal; i += 1) {
		if (pos + 46 > central.length) {
			throw new Error('ZIP central directory is truncated');
		}
		if (central.readUInt32LE(pos) !== ZIP_CENTRAL_SIG) {
			throw new Error(`Bad ZIP central signature at entry ${i}`);
		}
		const header = central.subarray(pos + 4, pos + 46);
		const method = header.readUInt16LE(6);
		const crc = header.readUInt32LE(12);
		const csize = header.readUInt32LE(16);
		const usize = header.readUInt32LE(20);
		const fileNameLength = header.readUInt16LE(24);
		const extraFieldLength = header.readUInt16LE(26);
		const commentLength = header.readUInt16LE(28);
		const localOffset = header.readUInt32LE(38);
		pos += 46;
		if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
			throw new Error('ZIP64 archives are not supported');
		}
		const fileName = central.subarray(pos, pos + fileNameLength).toString('utf8');
		pos += fileNameLength + extraFieldLength + commentLength;
		entries.push({ fileName, method, crc, csize, usize, localOffset });
	}
	return entries;
}

// Reject absolute paths, drive letters and `..` segments so a malicious
// archive cannot write outside the output folder.
function safeZipDestination(outputFolder: string, entryName: string): string {
	const normalized = entryName.replace(/\\/g, '/');
	if (normalized.length === 0) {
		throw new Error('ZIP entry with empty name');
	}
	if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
		throw new Error(`Unsafe ZIP entry path: ${entryName}`);
	}
	const segments = normalized.split('/');
	const clean: string[] = [];
	for (const segment of segments) {
		if (segment === '' || segment === '.') {
			continue;
		}
		if (segment === '..') {
			throw new Error(`Unsafe ZIP entry path: ${entryName}`);
		}
		clean.push(segment);
	}
	if (clean.length === 0) {
		throw new Error('ZIP entry with empty name');
	}
	const resolvedRoot = path.resolve(outputFolder);
	const destination = path.join(resolvedRoot, ...clean);
	const resolved = path.resolve(destination);
	if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
		throw new Error(`Unsafe ZIP entry path: ${entryName}`);
	}
	return destination;
}

function inflateZipData(cdata: Buffer, method: number, entryName: string): Buffer {
	if (method === 0) {
		return Buffer.from(cdata);
	}
	if (method === 8) {
		try {
			return inflateRawSync(cdata);
		} catch {
			// Some writers emit a zlib wrapper instead of raw deflate.
			return inflateSync(cdata);
		}
	}
	throw new Error(`Unsupported ZIP compression method ${method} for ${entryName}`);
}

async function extractZipPakToFolder(
	inputPath: string,
	outputFolder: string,
	progressCallback?: UnpackProgressCallback,
	shouldAbort: ShouldAbort = () => false,
	entryFilter?: ReadonlySet<string> | string[] | null,
): Promise<void> {
	if (shouldAbort()) {
		throw new Error('Operation canceled');
	}
	mkdirSync(outputFolder, { recursive: true });
	const resolvedRoot = path.resolve(outputFolder);
	const filter = normalizeEntryFilter(entryFilter);

	const fd = openSync(inputPath, 'r');
	let entries: ZipEntry[];
	try {
		const fileSize = statSync(inputPath).size;
		entries = readZipEntries(fd, fileSize);

		const total = filter ? filter.size : entries.length;
		let current = 0;
		for (let i = 0; i < entries.length; i += 1) {
			await new Promise((resolve) => setImmediate(resolve));
			if (shouldAbort()) {
				throw new Error('Operation canceled');
			}
			const entry = entries[i];
			const normalizedName = entry.fileName.replace(/\\/g, '/');
			const isDirectory = entry.fileName.endsWith('/');
			if (filter && (isDirectory || !filter.has(normalizedName))) {
				continue;
			}
			// Sizes come from the central directory, so local headers with
			// data descriptors (flag bit 3) need no special handling.
			const localSig = readAt(fd, 4, entry.localOffset);
			if (localSig.readUInt32LE(0) !== ZIP_LOCAL_SIG) {
				throw new Error(`Bad ZIP local signature for ${entry.fileName}`);
			}
			const localHeader = readAt(fd, 26, entry.localOffset + 4);
			if ((localHeader.readUInt16LE(2) & 0x01) !== 0) {
				throw new Error(`Encrypted ZIP entry not supported: ${entry.fileName}`);
			}
			const fileNameLength = localHeader.readUInt16LE(22);
			const extraFieldLength = localHeader.readUInt16LE(24);
			const dataStart = entry.localOffset + 4 + 26 + fileNameLength + extraFieldLength;
			const cdata = entry.csize > 0 ? readAt(fd, entry.csize, dataStart) : Buffer.alloc(0);
			const fileData = inflateZipData(cdata, entry.method, entry.fileName);
			if (fileData.length !== entry.usize) {
				throw new Error(`Size mismatch for ${entry.fileName}: got ${fileData.length}, expected ${entry.usize}`);
			}
			if (entry.crc !== crc32Unsigned(fileData)) {
				throw new Error(`CRC mismatch for ${entry.fileName}`);
			}

			let fileName = entry.fileName;
			const destination = safeZipDestination(resolvedRoot, fileName.replace(/[\\/]+$/, ''));
			if (isDirectory) {
				mkdirSync(destination, { recursive: true });
			} else {
				fileName = fileName.replace(/\\/g, '/');
				mkdirSync(path.dirname(destination), { recursive: true });
				writeFileSync(destination, fileData);
			}
			current += 1;
			if (progressCallback) {
				const percent = Math.round((current / Math.max(total, 1)) * 1000) / 10;
				progressCallback({ stage: 'unpack', current, total, percent, fileName, outputFolder, bytesDelta: entry.csize });
			}
		}
	} finally {
		closeSync(fd);
	}

	if (progressCallback) {
		const total = filter ? filter.size : entries.length;
		progressCallback({
			stage: 'unpack',
			current: total,
			total,
			percent: 100,
			fileName: path.basename(inputPath),
			outputFolder,
		});
	}
}

export async function extractPakToFolder(
	inputPath: string,
	outputFolder: string,
	progressCallback?: UnpackProgressCallback,
	shouldAbort: ShouldAbort = () => false,
	entryFilter?: ReadonlySet<string> | string[] | null,
	versionHint?: number,
): Promise<void> {
	if (isZipPak(inputPath)) {
		return await extractZipPakToFolder(inputPath, outputFolder, progressCallback, shouldAbort, entryFilter);
	}

	const filter = normalizeEntryFilter(entryFilter);

	const input = openSync(inputPath, 'r');
	try {
		if (shouldAbort()) {
			throw new Error('Operation canceled');
		}
		let version: number | null = typeof versionHint === 'number' ? versionHint : null;
		const fileSize = statSync(inputPath).size;
		const total = filter ? filter.size : await countPakEntries(input, fileSize, shouldAbort);
		let current = 0;
		let offset = 0;
		let reportedOffset = 0;
		let iter = 0;

		while (offset < fileSize) {
			if ((iter++ & 63) === 0) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (shouldAbort()) {
				throw new Error('Operation canceled');
			}
			const sigBuf = Buffer.alloc(4);
			if (readSync(input, sigBuf, 0, 4, offset) !== 4) break;
			offset += 4;
			const sig = sigBuf.readUInt32LE(0);
			if (sig === 0xFBFCB4AF) {
				const header = Buffer.alloc(26);
				readSync(input, header, 0, 26, offset);
				offset += 26;
				const compMethod = header.readUInt16LE(4);
				const crc = header.readInt32LE(10);
				const compressedSize = header.readUInt32LE(14);
				const uncompressedSize = header.readUInt32LE(18);
				const fileNameLength = header.readUInt16LE(22);
				const extraFieldLength = header.readUInt16LE(24);

				const fnameBuf = Buffer.alloc(fileNameLength);
				readSync(input, fnameBuf, 0, fileNameLength, offset);
				offset += fileNameLength + extraFieldLength;

				const fileName = fnameBuf.toString('utf8').replace(/\\/g, '/');
				const isDirectory = fileName.endsWith('/') || (compMethod === 0 && uncompressedSize === 0);
				const selected = !filter || (!isDirectory && filter.has(fileName));
				const needDetect = version === null && uncompressedSize > 0;
				// Filtered parallel extraction: skip the payload of entries that
				// are not selected (the XOR version is known via `versionHint`).
				if (!selected && !needDetect) {
					offset += compressedSize;
					continue;
				}

				const cdata = Buffer.alloc(compressedSize);
				readSync(input, cdata, 0, compressedSize, offset);
				offset += compressedSize;

				if (needDetect) {
					const probe = Buffer.from(cdata);
					const detected = detectVersion(probe, uncompressedSize, crc, compMethod);
					if (detected === null) {
						throw new Error('Unknown AION version');
					}
					version = detected;
				}

				if (!selected) {
					continue;
				}

				const activeVersion = version ?? 1;
				const tbloff = activeVersion === 1 ? (compressedSize & 31) * 32 : compressedSize & 1023;
				const table = activeVersion === 1 ? TABLE1 : TABLE2;
				const prefixSize = Math.min(32, compressedSize);
				for (let i = 0; i < prefixSize; i++) {
					cdata[i] ^= table[tbloff + i];
				}

				let fileData = Buffer.from(cdata);
				if (compMethod === 8) {
					fileData = inflateRawSync(fileData);
				}

				const destination = path.join(outputFolder, fileName.replace(/[\\/]+$/, ''));

				if (isDirectory) {
					mkdirSync(destination, { recursive: true });
					current += 1;
					if (progressCallback) {
						const bytesDelta = offset - reportedOffset;
						reportedOffset = offset;
						const percent = Math.round((current / Math.max(total, 1)) * 1000) / 10;
						progressCallback({ stage: 'unpack', current, total, percent, fileName, outputFolder, bytesDelta });
					}
					continue;
				}

				mkdirSync(path.dirname(destination), { recursive: true });
				writeFileSync(destination, fileData);
				current += 1;
				if (progressCallback) {
					const bytesDelta = offset - reportedOffset;
					reportedOffset = offset;
					const percent = Math.round((current / Math.max(total, 1)) * 1000) / 10;
					progressCallback({ stage: 'unpack', current, total, percent, fileName, outputFolder, bytesDelta });
				}
				if (shouldAbort()) {
					throw new Error('Operation canceled');
				}
			} else if (sig === 0xFDFEB4AF) {
				const header = Buffer.alloc(42);
				readSync(input, header, 0, 42, offset);
				offset += 42;
				const fileNameLength = header.readUInt16LE(24);
				const extraFieldLength = header.readUInt16LE(26);
				const commentLength = header.readUInt16LE(28);
				offset += fileNameLength + extraFieldLength + commentLength;
			} else if (sig === 0xF9FAB4AF) {
				offset += 18;
			} else {
				throw new Error(`Bad signature: ${sig}`);
			}
		}

		if (version === null) {
			version = 1;
		}
	} finally {
		closeSync(input);
	}
}
