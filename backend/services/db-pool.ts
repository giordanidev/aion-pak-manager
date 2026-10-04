import { Piscina } from 'piscina'
import { resolveDbWorkerFile } from './decrypt-pool'
import type { PakDbManifest } from '../core/pak-db'
import type { DbOpenResult, DbTreeRow } from '../../shared/api-types'
import type { PakDbTask } from '../workers/db-task'

let pool: Piscina<PakDbTask, unknown> | null = null

function dbPool(): Piscina<PakDbTask, unknown> {
	if (!pool) {
		pool = new Piscina({
			filename: resolveDbWorkerFile(),
			maxThreads: 1,
			resourceLimits: {
				maxOldGenerationSizeMb: 2048,
				maxYoungGenerationSizeMb: 256,
			},
		})
	}
	return pool
}

export function runPakDb<T>(task: PakDbTask): Promise<T> {
	return dbPool().run(task) as Promise<T>
}

export function readPakManifestOffThread(dbPath: string): Promise<Record<string, unknown> | null> {
	return runPakDb({ op: 'read-manifest', dbPath })
}

export function writePakDatabaseOffThread(dbPath: string, manifest: PakDbManifest): Promise<{ success: boolean }> {
	return runPakDb({ op: 'write', dbPath, manifest })
}

export function openPakDatabaseOffThread(dbPath: string): Promise<DbOpenResult> {
	return runPakDb({ op: 'open', dbPath })
}

export function dbChildrenOffThread(dbPath: string, parentId: number): Promise<DbTreeRow[]> {
	return runPakDb({ op: 'children', dbPath, parentId })
}

export function dbSearchOffThread(dbPath: string, query: string): Promise<number[]> {
	return runPakDb({ op: 'search', dbPath, query })
}

export function dbRowsOffThread(dbPath: string, ids: number[]): Promise<DbTreeRow[]> {
	return runPakDb({ op: 'rows', dbPath, ids })
}

export function dbLeavesOffThread(dbPath: string, nodePath: string): Promise<string[]> {
	return runPakDb({ op: 'leaves', dbPath, path: nodePath })
}
