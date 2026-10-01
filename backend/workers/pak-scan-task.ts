import { readdirSync, statSync } from 'fs'
import path from 'path'
import { countFilesInPak, listFilesInPak, scanPakEntries } from '../core/unpak'

export type PakScanOp = 'scan' | 'count' | 'list' | 'list-folder'

export interface PakScanTaskInput {
	op: PakScanOp
	path: string
}

export interface PakScanTaskResult {
	op: PakScanOp
	files?: string[]
	version?: number | null
	count?: number
}

function listFolderRelative(root: string): string[] {
	const results: string[] = []
	const walk = (dir: string, rel: string): void => {
		let names: string[]
		try {
			names = readdirSync(dir)
		} catch {
			return
		}
		for (const name of names) {
			if (name === '.pak-metadata.json' || name === '._tmp_repack' || name.startsWith('._tmp_repack_')) continue
			const full = path.join(dir, name)
			let stat: ReturnType<typeof statSync>
			try {
				stat = statSync(full)
			} catch {
				continue
			}
			const relPath = rel ? `${rel}/${name}` : name
			if (stat.isDirectory()) walk(full, relPath)
			else if (stat.isFile()) results.push(relPath)
		}
	}
	walk(root, '')
	return results
}

/** TOC / folder listing. Always invoked from a worker thread, never the Electron main process. */
export default async function pakScanTask(input: PakScanTaskInput): Promise<PakScanTaskResult> {
	const target = typeof input?.path === 'string' ? input.path : ''
	const op = input?.op
	if (!target) return { op: op ?? 'list', files: [], count: 0 }
	if (op === 'count') {
		const count = await countFilesInPak(target)
		return { op, count }
	}
	if (op === 'list') {
		return { op, files: await listFilesInPak(target) }
	}
	if (op === 'list-folder') {
		return { op, files: listFolderRelative(target) }
	}
	const scan = await scanPakEntries(target)
	return { op: 'scan', files: scan.files, version: scan.version }
}
