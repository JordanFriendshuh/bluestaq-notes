import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The playground is plain browser JavaScript.
    files: ['playground/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: Object.fromEntries(
        [
          'document',
          'location',
          'sessionStorage',
          'fetch',
          'WebSocket',
          'FormData',
          'URLSearchParams',
          'setTimeout',
          'clearTimeout',
          'confirm',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
);
