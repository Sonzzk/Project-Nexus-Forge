import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Import boundaries from ARCHITECTURE.md sections 3 and 7: only src/main uses Node and Electron's main APIs,
// and the renderer reaches the main process only through window.api.
const nodeModules = [
  'node:*',
  'fs',
  'fs/promises',
  'path',
  'os',
  'child_process',
  'worker_threads',
  'net',
  'http',
  'https',
];
const testBan = {
  group: ['**/test/**', '**/test'],
  message: 'Production code must not import test code or mocks.',
};
const renderOnlyBans = [
  { group: ['electron', ...nodeModules], message: 'Only the main process may use Node or Electron APIs.' },
  {
    group: ['**/main/**', '**/preload/**'],
    message: 'The renderer talks to the main process through window.api only.',
  },
];

const MODULES_WITH_INDEX = ['storage', 'process', 'logging', 'settings', 'security', 'ipc'];
function mainBans({ allowChildProcess = false, allowSqlite = false } = {}) {
  return [
    testBan,
    ...MODULES_WITH_INDEX.map((name) => ({
      // Relative imports only, so `@shared/ipc/...` is not mistaken for main's ipc module.
      regex: String.raw`^\.{1,2}/(?:.*/)?${name}/(?!index$).+$`,
      message: `Import from the ${name} module's index, not its internals.`,
    })),
    ...(allowChildProcess
      ? []
      : [
          {
            group: ['child_process', 'node:child_process'],
            message: 'Only src/main/process spawns programs.',
          },
        ]),
    ...(allowSqlite ? [] : [{ group: ['node:sqlite'], message: 'Only src/main/storage uses node:sqlite.' }]),
  ];
}

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'out/',
      'dist/',
      'release/',
      'test-results/',
      'playwright-report/',
      'coverage/',
      'test/fixtures/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['scripts/*.mjs', '*.config.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts', 'test/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['scripts/*.mjs', '*.config.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': ['error', { patterns: [...renderOnlyBans, testBan] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Untrusted text is rendered as text. A sanitized Markdown preview needs an ADR first.',
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', ...nodeModules], message: 'Shared code has no Node and no DOM.' },
            testBan,
          ],
        },
      ],
    },
  },
  {
    files: ['src/preload/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [testBan] }] },
  },
  // Main-process rules (ARCHITECTURE.md section 4): other modules import only a module's index.ts, only process/ spawns,
  // only storage/ touches node:sqlite, and nothing in main uses the global fetch until providers/ollama/ exists.
  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: mainBans() }],
      'no-restricted-globals': ['error', 'fetch'],
    },
  },
  {
    files: ['src/main/process/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: mainBans({ allowChildProcess: true }) }] },
  },
  {
    files: ['src/main/storage/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: mainBans({ allowSqlite: true }) }] },
  },
  // Tests sit next to the code and may use test/helpers and Node; a renderer test still may not.
  {
    files: ['src/main/**/*.test.ts', 'src/preload/**/*.test.ts', 'src/shared/**/*.test.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/renderer/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: renderOnlyBans }] },
  },
);
