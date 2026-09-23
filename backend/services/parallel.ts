import { cpuThreadsForWork } from './threads'

export function cpuConcurrency(): number {
	return cpuThreadsForWork()
}

export async function mapPool<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const limit = Math.max(1, Math.min(concurrency, Math.max(items.length, 1)))
	const results = new Array<R>(items.length)
	let next = 0
	const workers: Promise<void>[] = []
	for (let w = 0; w < limit; w += 1) {
		workers.push(
			(async () => {
				for (;;) {
					if (signal?.aborted) throw new Error('Operation canceled')
					const i = next
					next += 1
					if (i >= items.length) return
					results[i] = await fn(items[i] as T, i)
				}
			})(),
		)
	}
	await Promise.all(workers)
	return results
}
