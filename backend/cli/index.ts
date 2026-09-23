// Standalone CLI entry (built to .build/backend/cli.js).
//
//   node .build/backend/cli.js <command> [args]
//
// The packaged app also exposes the same commands via `<app>.exe cli <command>`
// (see backend/index.ts). Logic lives in backend/cli/run.ts.
import '../bin/threadpool'
import { runCli } from './run'

runCli(process.argv.slice(2)).then((code) => {
	if (code !== 0) process.exit(code)
})
