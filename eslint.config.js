/**
 * ESLint flat config. The goal is to catch mistakes (undefined names, unused
 * code, unreachable branches), not to restyle: the upstream files pass as
 * they are, so the rules are tuned rather than the code reformatted
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'data/**', 'dev/.mock-certs/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      // `_req`, `_next`… mark arguments a signature needs but the body ignores
      // Positions skipped in an array pattern (`[key, value]`) are not mistakes either
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '.', caughtErrors: 'none' }],
      // `try { … } catch { /* why */ }` is used on purpose, always with a comment
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Terminal streams are full of control characters (ESC, BEL, NUL…)
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**', 'dev/**', 'scripts/**', 'test/**', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['public/js/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Upstream test, kept as it is: one destructured helper is not used
    files: ['test/cliAutomation.test.js'],
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^(_|ios$)', destructuredArrayIgnorePattern: '.', caughtErrors: 'none' }] },
  },
  {
    // Browser tests hand functions to the page: their bodies run in the browser
    files: ['test/e2e/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
