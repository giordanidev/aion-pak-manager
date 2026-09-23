/// <reference types="vite/client" />

import type { ElectronApi } from '../shared/api-types'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

declare global {
  interface Window {
    electronAPI: ElectronApi
  }

  const __APP_VERSION__: string
  const __APP_COMMIT__: string
}
