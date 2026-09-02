import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The dependency rule of §5, enforced by the linter rather than by review:
 *
 *   domain/  imports nothing from the project
 *   app/     imports domain/ and db/
 *   http/    imports app/
 *   nothing  imports http/
 *
 * `domain/` is the part that must stay pure — no database, no clock, no
 * network, no randomness that is not passed in — because those are the four
 * modules with the highest correctness risk and the only ones covered by unit
 * tests. A single convenience import of `db/client` from a domain module is
 * enough to make them untestable, and it is exactly the kind of edit that gets
 * waved through at 2am.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/*.tsbuildinfo',
      'apps/web/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Deliberate `catch {}` blocks are documented where they appear.
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // ── The layer rule ─────────────────────────────────────────────────────────
  {
    files: ['apps/api/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../*', './*/', '~/*', '**/db/*', '**/app/*', '**/http/*', '**/sim/*', '**/ml/*', '**/lib/*'],
              message:
                'domain/ is pure: no database, no clock, no network, no project imports. Take what you need as an argument (§5, §7).',
            },
          ],
          paths: [
            { name: 'postgres', message: 'domain/ must not touch the database (§5).' },
            { name: 'ai', message: 'domain/ must not call an LLM (§5, §7.8).' },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/api/src/app/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/http/*'],
              message: 'app/ must not import http/ — nothing imports http/ (§5).',
            },
          ],
        },
      ],
    },
  },

  // Domain unit tests are allowed to import the domain modules they cover.
  {
    files: ['apps/api/src/domain/**/*.test.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
