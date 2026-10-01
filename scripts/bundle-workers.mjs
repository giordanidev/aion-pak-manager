/**
 * Rebuild Piscina workers as self-contained CJS files (no shared `../chunks/`
 * imports). Electron worker_threads + portable/asar temp extracts break
 * relative chunk requires when only the entry file is resolved.
 */
import { builtinModules } from 'module'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workers = ['decrypt-task', 'unpak-task', 'repak-task', 'count-task', 'scan-folder-task', 'pak-scan-task']
const externals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

for (const name of workers) {
	await build({
		configFile: false,
		root,
		logLevel: 'warn',
		build: {
			outDir: resolve(root, '.build/backend/workers'),
			emptyOutDir: false,
			lib: {
				entry: resolve(root, `backend/workers/${name}.ts`),
				formats: ['cjs'],
				fileName: () => `${name}.js`,
			},
			rollupOptions: {
				external: externals,
				output: {
					inlineDynamicImports: true,
					entryFileNames: `${name}.js`,
					exports: 'auto',
					format: 'cjs',
				},
			},
			minify: false,
			sourcemap: false,
			target: 'node20',
			ssr: true,
		},
	})
	console.log(`[workers] bundled ${name}.js`)
}
