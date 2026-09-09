import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import en from '@mio/shared/i18n/en.json'
import es from '@mio/shared/i18n/es.json'
import fr from '@mio/shared/i18n/fr.json'
import ja from '@mio/shared/i18n/ja.json'
import ko from '@mio/shared/i18n/ko.json'
import ru from '@mio/shared/i18n/ru.json'
import zh from '@mio/shared/i18n/zh.json'

/**
 * The languages the UI can display.
 *
 * Each is a file in `shared/i18n`, read by the web client and the app alike,
 * and `frontend/src/i18n/parity.test.ts` discovers them from disk — so adding
 * one is a catalogue plus two lines here, and the guard covers it immediately
 * (#519).
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'ru', label: 'Русский' },
] as const

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code']

const STORAGE_KEY = 'mio-language'

// Resources are bundled (imported above), not fetched, so init is synchronous —
// components (and tests) can call t() immediately with no loading state.
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
      fr: { translation: fr },
      ja: { translation: ja },
      ko: { translation: ko },
      ru: { translation: ru },
      zh: { translation: zh },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES.map((language) => language.code),
    // Language mismatch (e.g. detecting "en-GB") falls back to the base "en".
    nonExplicitSupportedLngs: true,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false }, // React already escapes.
  })

// Keep the document's lang attribute in step, for accessibility and CSS.
function syncHtmlLang(language: string): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
  }
}
syncHtmlLang(i18n.resolvedLanguage ?? 'en')
i18n.on('languageChanged', syncHtmlLang)

export default i18n
