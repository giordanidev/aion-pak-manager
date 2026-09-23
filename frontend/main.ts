import './assets/app.css'

const LOCALE_KEY = 'aion-locale'
const SHOW_FILE_NAMES_KEY = 'aion-show-file-names'
const DIR_KEYS = { pak: 'aion-dir-pak', unpaked: 'aion-dir-unpaked', repaked: 'aion-dir-repaked' } as const

async function seedFromSettings(): Promise<void> {
  try {
    const result = await window.electronAPI.getSettings()
    const settings = result?.settings
    if (!result?.success || !settings) return
    if (typeof settings.locale === 'string') {
      localStorage.setItem(LOCALE_KEY, settings.locale)
    }
    if (typeof settings.showFileNames === 'boolean') {
      localStorage.setItem(SHOW_FILE_NAMES_KEY, settings.showFileNames ? '1' : '0')
    }
    if (settings.customDirs) {
      for (const key of ['pak', 'unpaked', 'repaked'] as const) {
        const value = settings.customDirs[key]
        if (typeof value !== 'string') continue
        if (value) localStorage.setItem(DIR_KEYS[key], value)
        else localStorage.removeItem(DIR_KEYS[key])
      }
    }
  } catch {
    // Settings are optional — boot with defaults/existing localStorage.
  }
}

async function bootstrap(): Promise<void> {
  await seedFromSettings()
  // Import after seeding so module-level initializers (i18n locale,
  // useAppState customDirs) read the seeded localStorage values.
  const [{ createApp }, { default: App }, { i18n }, { appTitle }] = await Promise.all([
    import('vue'),
    import('./App.vue'),
    import('./i18n'),
    import('./directives/appTitle'),
  ])
  const app = createApp(App)
  app.use(i18n)
  app.directive('app-title', appTitle)
  app.mount('#app')
}

void bootstrap()
