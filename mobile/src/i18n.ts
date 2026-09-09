import AsyncStorage from '@react-native-async-storage/async-storage'
import { getLocales } from 'expo-localization'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from '@mio/shared/i18n/en.json'
import es from '@mio/shared/i18n/es.json'
import fr from '@mio/shared/i18n/fr.json'
import ja from '@mio/shared/i18n/ja.json'
import ko from '@mio/shared/i18n/ko.json'
import ru from '@mio/shared/i18n/ru.json'
import zh from '@mio/shared/i18n/zh.json'

/**
 * The app reads the *same* catalogue files as the web client (`shared/i18n`),
 * so a string added for one platform exists on the other and the Wave-D parity
 * guard keeps covering both.
 *
 * Only the language *detection* differs: the web sniffs the browser and
 * localStorage, while here the device locale is the honest default. The
 * catalogues, and therefore the translations, are identical.
 *
 * A deliberate choice can override the device, and is remembered — someone whose
 * phone is set to English may still want MiO in Chinese.
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

/**
 * Languages whose catalogue was produced by machine and has not been read by
 * someone who speaks it (#519).
 *
 * ⚠️ **Said out loud in the app rather than kept in a commit message.** #557 is
 * the precedent: 29 Chinese strings silently rendered in English for weeks, in
 * a language I reads. Nobody here can spot the equivalent in Korean, so the
 * honest thing is to tell the person who can.
 *
 * Remove a code from this set when a speaker has actually reviewed it — that is
 * the whole meaning of being in it.
 */
export const MACHINE_TRANSLATED: ReadonlySet<string> = new Set(['es', 'fr', 'ja', 'ko', 'ru'])

/**
 * The device's language, if MiO has it.
 *
 * ⚠️ **Matched against `SUPPORTED_LANGUAGES` rather than by hand.** This was
 * `tag === 'zh' ? 'zh' : 'en'`, so every language added after Chinese would
 * have been shipped, listed in Settings, and never selected automatically —
 * a phone set to Japanese would have opened in English with no clue why (#519).
 *
 * `languageCode` is the base tag (`es`, not `es-MX`), which is the granularity
 * the catalogues are written at.
 */
function deviceLanguage(): LanguageCode {
  const tag = getLocales()[0]?.languageCode
  const match = SUPPORTED_LANGUAGES.find((language) => language.code === tag)
  return match ? match.code : 'en'
}

// i18next's fluent API really is a method on the default export; the rule sees
// the unrelated named `use` export and cannot tell the difference.
// eslint-disable-next-line import/no-named-as-default-member
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
    fr: { translation: fr },
    ja: { translation: ja },
    ko: { translation: ko },
    ru: { translation: ru },
    zh: { translation: zh },
  },
  lng: deviceLanguage(),
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGUAGES.map((language) => language.code),
  interpolation: { escapeValue: false },
})

const LANGUAGE_KEY = 'mio-language'

function isSupported(code: string | null): code is LanguageCode {
  return SUPPORTED_LANGUAGES.some((language) => language.code === code)
}

/**
 * Apply a previously chosen language, if there is one.
 *
 * Called from the root layout rather than at init, because `i18n.init` is
 * synchronous and AsyncStorage is not. The app therefore starts in the device
 * language and switches a tick later — visible only to someone who has
 * overridden it, and only for one frame. Blocking startup on a disk read to
 * avoid that would be the worse trade.
 */
export async function loadStoredLanguage(): Promise<void> {
  const stored = await AsyncStorage.getItem(LANGUAGE_KEY)
  if (isSupported(stored) && stored !== i18n.language) {
    // eslint-disable-next-line import/no-named-as-default-member
    await i18n.changeLanguage(stored)
  }
}

/** Switch language and remember the choice. */
export async function setLanguage(code: LanguageCode): Promise<void> {
  await AsyncStorage.setItem(LANGUAGE_KEY, code)
  // eslint-disable-next-line import/no-named-as-default-member
  await i18n.changeLanguage(code)
}

export default i18n
