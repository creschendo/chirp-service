// ESLint config (flat config, ESLint 9). Catches bugs (unused variables, undefined names, unreachable code);
// formatting is Prettier's job, so no style rules here.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'coverage/'] },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // Jest provides describe/test/expect/beforeEach... as globals in test files.
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: globals.jest },
  },
];
