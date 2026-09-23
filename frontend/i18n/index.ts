import { createI18n } from 'vue-i18n'
import ptBR from './locales/pt-BR.json'
import esES from './locales/es-ES.json'
import enUS from './locales/en-US.json'
import flagBR from '../assets/flags/br.svg'
import flagES from '../assets/flags/es.svg'
import flagUS from '../assets/flags/us.svg'

export const LOCALE_KEY = 'aion-locale'
export const SUPPORTED_LOCALES = ['pt-BR', 'es-ES', 'en-US'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_FLAG_ICONS: Record<SupportedLocale, string> = {
  'pt-BR': flagBR,
  'es-ES': flagES,
  'en-US': flagUS,
}

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  'pt-BR': 'Português (pt-BR)',
  'es-ES': 'Español (es-ES)',
  'en-US': 'English (en-US)',
}

export function getInitialLocale(): SupportedLocale {
	try {
		const saved = localStorage.getItem(LOCALE_KEY)
		if (saved && (SUPPORTED_LOCALES as readonly string[]).includes(saved)) {
			return saved as SupportedLocale
		}
	} catch {
		// ignore
	}
	return 'pt-BR'
}

export const i18n = createI18n({
	locale: getInitialLocale(),
	fallbackLocale: 'en-US',
	legacy: false,
	messages: {
		'pt-BR': ptBR,
		'es-ES': esES,
		'en-US': enUS,
	},
})

export function setLocale(locale: SupportedLocale): void {
	;(i18n.global.locale as unknown as { value: SupportedLocale }).value = locale
	try {
		localStorage.setItem(LOCALE_KEY, locale)
	} catch {
		// ignore
	}
	try {
		void window.electronAPI?.setSettings({ locale })
	} catch {
		// ignore persistence errors
	}
}
