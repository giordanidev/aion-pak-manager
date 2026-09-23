import os from 'os'

/**
 * Sizes the libuv threadpool to the machine's logical cores.
 *
 * RePAK compresses with async `zlib.deflateRaw`, and UnPAK/decrypt use async
 * `fs` — both run on the shared libuv threadpool, which defaults to only 4
 * threads. That default silently caps RePAK regardless of the CPU-effort
 * setting; raising it lets the effort budget actually translate into cores.
 *
 * Must run before the threadpool is first used. No module imported at load
 * time performs async fs/zlib work, so importing this first from every entry
 * point (app main + CLI) is early enough. Workers spawned later inherit the
 * value through the environment.
 */
export function configureThreadpool(): void {
	try {
		const total = Math.max(1, os.cpus().length)
		const current = Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '', 10)
		if (!Number.isFinite(current) || current < total) {
			process.env.UV_THREADPOOL_SIZE = String(total)
		}
	} catch {
		// keep the platform default
	}
}

configureThreadpool()
