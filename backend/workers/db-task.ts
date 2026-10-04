import {
	openPakDatabase,
	readChildRows,
	readLeafPaths,
	readPakManifest,
	readRowsByIds,
	searchNodeIds,
	withReadonly,
	writePakDatabase,
	type PakDbManifest,
} from '../core/pak-db'

export type PakDbTask =
	| { op: 'read-manifest'; dbPath: string }
	| { op: 'write'; dbPath: string; manifest: PakDbManifest }
	| { op: 'open'; dbPath: string }
	| { op: 'children'; dbPath: string; parentId: number }
	| { op: 'search'; dbPath: string; query: string }
	| { op: 'rows'; dbPath: string; ids: number[] }
	| { op: 'leaves'; dbPath: string; path: string }

export default function dbTask(input: PakDbTask): unknown {
	switch (input.op) {
		case 'read-manifest':
			return readPakManifest(input.dbPath)
		case 'write':
			writePakDatabase(input.dbPath, input.manifest)
			return { success: true }
		case 'open':
			return openPakDatabase(input.dbPath)
		case 'children':
			return withReadonly(input.dbPath, (db) => readChildRows(db, input.parentId))
		case 'search':
			return withReadonly(input.dbPath, (db) => searchNodeIds(db, input.query))
		case 'rows':
			return withReadonly(input.dbPath, (db) => readRowsByIds(db, input.ids.slice(0, 500)))
		case 'leaves':
			return withReadonly(input.dbPath, (db) => readLeafPaths(db, input.path))
		default:
			throw new Error('Unknown database task')
	}
}
