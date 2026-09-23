export const LOCALE_KEY = 'aion-locale'
export const SUPPORTED_LOCALES = ['pt-BR', 'es-ES', 'en-US'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: SupportedLocale = 'en-US'

const LOCALE_BY_LANGUAGE: Record<string, SupportedLocale> = {
  pt: 'pt-BR',
  es: 'es-ES',
  en: 'en-US',
}

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export function matchSupportedLocale(raw: string | null | undefined): SupportedLocale | null {
  if (!raw) return null
  const normalized = raw.trim().toLowerCase().replace(/_/g, '-')
  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === normalized)
  if (exact) return exact
  return LOCALE_BY_LANGUAGE[normalized.split('-')[0]] ?? null
}

export function detectSystemLocale(): SupportedLocale | null {
  if (typeof navigator === 'undefined') return null
  const candidates: string[] = []
  if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages)
  if (typeof navigator.language === 'string') candidates.push(navigator.language)
  for (const candidate of candidates) {
    const matched = matchSupportedLocale(candidate)
    if (matched) return matched
  }
  return null
}
