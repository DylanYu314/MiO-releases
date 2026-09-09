import { useTranslation } from 'react-i18next'

import { SUPPORTED_LANGUAGES } from '../i18n'
import { Select } from './ui'

/** A minimal language picker. Lives in the header for now; the Settings page
 *  (a later PR) will host the permanent version. */
export function LanguageSwitcher() {
  const { i18n, t } = useTranslation()

  return (
    <Select
      value={i18n.resolvedLanguage}
      onChange={(event) => void i18n.changeLanguage(event.target.value)}
      aria-label={t('common.language')}
    >
      {SUPPORTED_LANGUAGES.map((language) => (
        <option key={language.code} value={language.code}>
          {language.label}
        </option>
      ))}
    </Select>
  )
}
