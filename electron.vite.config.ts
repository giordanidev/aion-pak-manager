import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function readAppCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

const appVersion = readAppVersion()
const appCommit = readAppCommit()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_COMMIT__: JSON.stringify(appCommit),
    },
    build: {
      outDir: '.build/backend',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'backend/index.ts'),
          cli: resolve(__dirname, 'backend/cli/index.ts'),
          'workers/decrypt-task': resolve(__dirname, 'backend/workers/decrypt-task.ts'),
          'workers/unpak-task': resolve(__dirname, 'backend/workers/unpak-task.ts'),
          'workers/repak-task': resolve(__dirname, 'backend/workers/repak-task.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: '.build/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'backend/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'frontend',
    plugins: [vue(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_COMMIT__: JSON.stringify(appCommit),
    },
    build: {
      outDir: resolve(__dirname, '.build/frontend'),
      rollupOptions: {
        input: resolve(__dirname, 'frontend/index.html')
      }
    }
  }
})
