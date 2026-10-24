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
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [testBan] }] },
  },
);
