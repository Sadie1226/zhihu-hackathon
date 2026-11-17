import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: {
    console: 'readonly', process: 'readonly', Buffer: 'readonly',
    URL: 'readonly', Response: 'readonly', Request: 'readonly', AbortController: 'readonly',
  } } },
  globalIgnores(['.next/**', '.local/**', 'data/**', 'node_modules/**', 'next-env.d.ts']),
])
