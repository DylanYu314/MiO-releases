import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import i18next from 'eslint-plugin-i18next'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // Guards the EN/ZH catalogues from the inside: user-facing copy must go
  // through t(), not be typed straight into JSX. Scoped to the screens — the
  // ui/ primitives take their text as props, and tests assert literal strings.
  {
    files: ['src/pages/**/*.tsx', 'src/components/**/*.tsx'],
    ignores: ['src/components/ui/**', '**/*.test.tsx'],
    plugins: { i18next },
    rules: { 'i18next/no-literal-string': ['error', { mode: 'jsx-text-only' }] },
  },
  // Turns off every stylistic rule that would fight Prettier. Must stay last.
  prettier,
)
