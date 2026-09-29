import { existsSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { countFilesInPak } from '../core/unpak'

export interface CountTaskInput {
	/** Absolute path to a folder or .pak file. */
	path: string
	mode: 'folder' | 'pak'
}

export interface CountTaskResult {
	count: number
	size: number
}

/** Synchronous recursive file count — runs inside a worker thread so the UI stays free. */
function measureFolderSync(root: string): CountTaskResult {
	let count = 0
	let size = 0
	function walk(dir: string): void {
		let names: string[]
		try {
			names = readdirSync(dir)
		} catch {
			return
		}
		for (const name of names) {
			if (name === '.pak-metadata.json' || name === '._tmp_repack') continue
			if (name.startsWith('._tmp_repack_')) continue
			if (name.toLowerCase().endsWith('.db')) continue
			const full = path.join(dir, name)
			let stat: ReturnType<typeof statSync>
			try {
				stat = statSync(full)
			} catch {
				continue
			}
			if (stat.isDirectory()) walk(full)
			else if (stat.isFile()) {
				count += 1
				size += stat.size
			}
		}
	}
	walk(root)
	return { count, size }
}

async function measurePak(filePath: string): Promise<CountTaskResult> {
	let size = 0
	try {
		size = statSync(filePath).size
	} catch {
		size = 0
	}
	try {
		const count = await countFilesInPak(filePath)
		return { count, size }
	} catch {
		return { count: 0, size }
	}
}

export default async function countTask(input: CountTaskInput): Promise<CountTaskResult> {
	const target = typeof input?.path === 'string' ? input.path : ''
	if (!target || !existsSync(target)) return { count: 0, size: 0 }
	if (input.mode === 'pak') return measurePak(target)
	try {
		if (!statSync(target).isDirectory()) return measurePak(target)
	} catch {
		return { count: 0, size: 0 }
	}
	return measureFolderSync(target)
}
