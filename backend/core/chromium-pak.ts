/**
 * Chromium / CEF `.pak` data-pack reader (GRIT format, versions 4 and 5).
 * Spec: tools/grit/format/data_pack.py in Chromium.
 *
 * Resources are keyed by numeric ID (no internal paths). Extracted file names
 * are `<id>.<ext>` after optional gzip/brotli decompression + content sniff.
 */
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from 'fs'
import path from 'path'
import { brotliDecompressSync, gunzipSync } from 'zlib'

export type ChromiumEncoding = 'binary' | 'utf8' | 'utf16'

export interface ChromiumPakResource {
	id: number
	/** Offset of this resource's bytes in the pack (inclusive). */
	offset: number
	/** Byte length of the packed payload (may be compressed). */
	size: number
}

export interface ChromiumPakInfo {
	version: 4 | 5
	encoding: ChromiumEncoding
	resources: ChromiumPakResource[]
}

const INDEX_ENTRY_SIZE = 6 // uint16 id + uint32 offset
const ALIAS_ENTRY_SIZE = 4 // uint16 id + uint16 index

function encodingName(code: number): ChromiumEncoding {
	if (code === 1) return 'utf8'
	if (code === 2) return 'utf16'
	return 'binary'
}

function readU16(buf: Buffer, offset: number): number {
	return buf.readUInt16LE(offset)
}

function readU32(buf: Buffer, offset: number): number {
	return buf.readUInt32LE(offset)
}

/** True when the file looks like a Chromium/CEF data-pack (version 4 or 5). */
export function isChromiumPak(inputPath: string): boolean {
	const fd = openSync(inputPath, 'r')
	try {
		const header = Buffer.alloc(4)
		if (readSync(fd, header, 0, 4, 0) !== 4) return false
		const version = readU32(header, 0)
		return version === 4 || version === 5
	} finally {
		closeSync(fd)
	}
}

function maybeDecompress(payload: Buffer): Buffer {
	if (payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
		try {
			return gunzipSync(payload)
		} catch {
			return payload
		}
	}
	if (payload.length >= 4) {
		try {
			const out = brotliDecompressSync(payload)
			if (out.length > 0) return out
		} catch {
			// keep packed bytes
		}
	}
	return payload
}

function sniffExtension(data: Buffer, encoding: ChromiumEncoding): string {
	if (data.length >= 8) {
		if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
		if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
		if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'gif'
		if (
			data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
			data.length >= 12 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
		) {
			return 'webp'
		}
		if (data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d) return 'wasm'
	}
	const head = data.subarray(0, Math.min(data.length, 256)).toString('utf8')
	const trimmed = head.trimStart().toLowerCase()
	if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) return 'html'
	if (trimmed.startsWith('<?xml')) return trimmed.includes('<svg') ? 'svg' : 'xml'
	if (trimmed.startsWith('<svg')) return 'svg'
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
	if (/:(?:hover|root|before)|@media|@font-face/.test(trimmed)) return 'css'
	if (encoding === 'utf16') return 'txt'
	if (encoding === 'utf8') {
		if (/^(?:\/\*|\/\/|"use strict"|'use strict'|import |export |function |var |let |const |\(function)/.test(trimmed)) {
			return 'js'
		}
		return 'txt'
	}
	return 'bin'
}

/** Stable logical name used in manifests / entry filters (id only). */
export function chromiumResourceKey(id: number): string {
	return String(id)
}

export function resourceFileName(id: number, data: Buffer, encoding: ChromiumEncoding): string {
	return `${id}.${sniffExtension(data, encoding)}`
}

/**
 * Parse a Chromium data-pack index (does not decompress payloads).
 */
export function readChromiumPak(inputPath: string): ChromiumPakInfo & { data: Buffer } {
	const data = readFileSync(inputPath)
	if (data.length < 9) throw new Error('Chromium pak too small')
	const version = readU32(data, 0)
	let encodingCode = 0
	let resourceCount = 0
	let aliasCount = 0
	let headerSize = 0

	if (version === 4) {
		resourceCount = readU16(data, 4)
		encodingCode = data[6] ?? 0
		aliasCount = 0
		headerSize = 9
	} else if (version === 5) {
		encodingCode = data[4] ?? 0
		resourceCount = readU16(data, 8)
		aliasCount = readU16(data, 10)
		headerSize = 12
	} else {
		throw new Error(`Unsupported Chromium pak version: ${version}`)
	}

	const encoding = encodingName(encodingCode)
	const indexBytes = (resourceCount + 1) * INDEX_ENTRY_SIZE
	const aliasBytes = aliasCount * ALIAS_ENTRY_SIZE
	if (data.length < headerSize + indexBytes + aliasBytes) {
		throw new Error('Chromium pak truncated (index/alias table)')
	}

	const resources: ChromiumPakResource[] = []
	const idByIndex: number[] = []
	const offsetByIndex: number[] = []

	for (let i = 0; i <= resourceCount; i += 1) {
		const at = headerSize + i * INDEX_ENTRY_SIZE
		idByIndex.push(readU16(data, at))
		offsetByIndex.push(readU32(data, at + 2))
	}

	for (let i = 0; i < resourceCount; i += 1) {
		const id = idByIndex[i] as number
		const offset = offsetByIndex[i] as number
		const nextOffset = offsetByIndex[i + 1] as number
		if (nextOffset < offset || nextOffset > data.length) {
			throw new Error(`Chromium pak bad offsets for resource ${id}`)
		}
		resources.push({ id, offset, size: nextOffset - offset })
	}

	for (let i = 0; i < aliasCount; i += 1) {
		const at = headerSize + indexBytes + i * ALIAS_ENTRY_SIZE
		const aliasId = readU16(data, at)
		const index = readU16(data, at + 2)
		const primary = resources[index]
		if (!primary) {
			throw new Error(`Chromium pak alias ${aliasId} references missing index ${index}`)
		}
		resources.push({ id: aliasId, offset: primary.offset, size: primary.size })
	}

	return { version: version as 4 | 5, encoding, resources, data }
}

/** Logical entry names (`"102"`, …), sorted by id — cheap (no decompress). */
export function listChromiumPakFiles(inputPath: string): string[] {
	const pack = readChromiumPak(inputPath)
	return pack.resources
		.slice()
		.sort((a, b) => a.id - b.id)
		.map((r) => chromiumResourceKey(r.id))
}

export function countChromiumPakFiles(inputPath: string): number {
	const pack = readChromiumPak(inputPath)
	return pack.resources.length
}

export type ChromiumExtractProgress = (info: {
	current: number
	total: number
	percent: number
	fileName: string
	bytesDelta?: number
}) => void

/**
 * Extract every (or filtered) Chromium resource into `outputFolder`.
 * Filter keys are logical ids (`"102"`). Written files use sniffed extensions.
 */
export async function extractChromiumPakToFolder(
	inputPath: string,
	outputFolder: string,
	progressCallback?: ChromiumExtractProgress,
	shouldAbort: () => boolean = () => false,
	entryFilter?: ReadonlySet<string> | string[] | null,
): Promise<void> {
	const pack = readChromiumPak(inputPath)
	const filter =
		entryFilter == null
			? null
			: new Set(
					(Array.isArray(entryFilter) ? entryFilter : Array.from(entryFilter)).map((v) => {
						const s = String(v).replace(/\\/g, '/')
						const base = path.basename(s)
						const dot = base.indexOf('.')
						return dot > 0 ? base.slice(0, dot) : base
					}),
				)
	const targets = filter
		? pack.resources.filter((r) => filter.has(chromiumResourceKey(r.id)))
		: pack.resources
	const total = targets.length
	mkdirSync(outputFolder, { recursive: true })

	let current = 0
	for (const resource of targets) {
		if (shouldAbort()) throw new Error('Operation canceled')
		const packed = pack.data.subarray(resource.offset, resource.offset + resource.size)
		const payload = maybeDecompress(packed)
		const fileName = resourceFileName(resource.id, payload, pack.encoding)
		writeFileSync(path.join(outputFolder, fileName), payload)
		current += 1
		if (progressCallback) {
			const percent = Math.round((current / Math.max(total, 1)) * 1000) / 10
			progressCallback({
				current,
				total,
				percent,
				fileName,
				bytesDelta: payload.length,
			})
		}
		if ((current & 63) === 0) {
			await new Promise<void>((r) => setImmediate(r))
		}
	}
}

export function peekChromiumPakVersion(inputPath: string): 4 | 5 | null {
	const fd = openSync(inputPath, 'r')
	try {
		const header = Buffer.alloc(4)
		if (readSync(fd, header, 0, 4, 0) !== 4) return null
		const version = readU32(header, 0)
		if (version === 4 || version === 5) return version
		return null
	} finally {
		closeSync(fd)
	}
}

export function chromiumPakLooksValid(inputPath: string): boolean {
	try {
		const st = statSync(inputPath)
		if (!st.isFile() || st.size < 9) return false
		return peekChromiumPakVersion(inputPath) != null
	} catch {
		return false
	}
}
