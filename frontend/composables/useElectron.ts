import type { ElectronApi } from '../../shared/api-types'

const SHOW_FILE_NAMES_KEY = 'aion-show-file-names'

export function useElectron(): ElectronApi {
  return window.electronAPI
}

export function getShowFileNames(): boolean {
  return localStorage.getItem(SHOW_FILE_NAMES_KEY) !== '0'
}

export function setShowFileNames(enabled: boolean): void {
  try {
    localStorage.setItem(SHOW_FILE_NAMES_KEY, enabled ? '1' : '0')
  } catch {
    // ignore
  }
  try {
    void window.electronAPI?.setSettings({ showFileNames: enabled })
  } catch {
    // ignore persistence errors
  }
}
