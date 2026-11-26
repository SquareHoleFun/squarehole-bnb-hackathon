import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // SH-252: apps/web/public/examples is the explainer generator's output, copied: its bytes are set by
  // apps/web/build/examples-copy.mjs and held to its manifest by that script's --check and by
  // apps/web/src/features/examples/explainer-files.test.ts (same scripts as the source, origin, words), not by this linter.
  { ignores: ['apps/web/public/examples/**'] },
  // SH-323: the page's BNB files are the same generated scripts with their words changed (apps/web/build/examples-bnb-check.mjs holds them).
  { ignores: ['apps/web/build/examples-bnb/**'] },
  // The bounty entries under bounties/ are projects of their own (their own packages, compilers and tests: see each
  // folder's README); this root configuration, written for the platform's workspace, does not apply to them.
  // The OpenFour rail's standalone CommonJS project, and the stack's small signing service that requires its code.
  { ignores: ['bounties/app/**', 'bounties/openfour/**', 'hackathon/stack/sign/**'] },
  { ignores: ['**/dist/**', '**/dist-chain/**', '**/dist-core-chain/**', '.local/**', 'apps/web/e2e/.chain/**', 'apps/web/e2e/.core-chain/**', 'apps/web/e2e/.artifacts-core-chain/**', '**/coverage/**', 'square-hole-handoff/**', 'square-hole-core-v2/**', '**/playwright-report/**', '**/test-results/**', '.claude/**', 'packages/contracts/lib/**', 'bounties/flap/lib/**', 'bounties/*/out/**', 'bounties/*/cache/**', 'bounties/flap/broadcast/**', '.cache/**', '**/.cache/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-console': ['error', { allow: ['error', 'warn'] }],
      // Financial amounts must never pass through JavaScript Number (AGENTS.md, Security boundaries).
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Use decimal/bigint helpers from @squarehole/domain.' }],
      'no-restricted-properties': ['error', { object: 'Number', property: 'parseFloat', message: 'Use decimal/bigint helpers from @squarehole/domain.' }],
    },
  },
);
