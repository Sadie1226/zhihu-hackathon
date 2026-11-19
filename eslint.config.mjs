import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// a4-v25 是纯静态预览：直接在浏览器里跑的脚本 + CommonJS 复验脚本，
// 不经打包。给它单独一套 globals，而不是把整个目录 ignore 掉——
// ignore 会让这个目录以后写错也没人发现。
const browserGlobals = {
  window: 'readonly', document: 'readonly', location: 'readonly', events: 'readonly',
  sessionStorage: 'readonly', localStorage: 'readonly', matchMedia: 'readonly',
  innerWidth: 'readonly', innerHeight: 'readonly', getComputedStyle: 'readonly',
  Event: 'readonly', CustomEvent: 'readonly', URLSearchParams: 'readonly',
  requestAnimationFrame: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  fetch: 'readonly', Image: 'readonly', HTMLElement: 'readonly', Node: 'readonly',
  HomeAdapters: 'writable', HomeScene: 'writable', WARDROBE: 'writable',
  KanshanMotion: 'writable', PreviewService: 'writable', ADOPTION_CONFIG: 'writable',
  adapterCalls: 'writable', dispose: 'writable',
}
const commonjsGlobals = { require: 'readonly', __dirname: 'readonly', module: 'readonly', exports: 'writable' }

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: {
    console: 'readonly', process: 'readonly', Buffer: 'readonly',
    URL: 'readonly', Response: 'readonly', Request: 'readonly', AbortController: 'readonly',
  } } },
  {
    files: ['app/(a)/_design/**/*.js'],
    languageOptions: { globals: browserGlobals },
  },
  {
    files: ['app/(a)/_design/**/*.cjs', 'scripts/a5/**/*.cjs'],
    languageOptions: { globals: { ...commonjsGlobals, ...browserGlobals } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  globalIgnores(['.next/**', '.local/**', 'data/**', 'node_modules/**', 'next-env.d.ts']),
])
