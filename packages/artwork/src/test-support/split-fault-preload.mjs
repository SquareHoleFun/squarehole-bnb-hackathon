/**
 * TEST ONLY (cli.test.ts): a `node --import` preload that puts split-fault-shamir.mjs in place of
 * shamir-secret-sharing for the box 0 CLI, so a test can act in the middle of a trustee split: after the three share
 * files are written and before the split has proven recovery. What it does is set by BOX0_TEST_AT_COMBINE (see the
 * wrapper). Never loaded outside the tests.
 */
import { registerHooks } from 'node:module';

const wrapper = new URL('./split-fault-shamir.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (specifier !== 'shamir-secret-sharing' || context.parentURL?.startsWith(wrapper)) return resolved;
    return { url: `${wrapper}?real=${encodeURIComponent(resolved.url)}`, format: 'module', shortCircuit: true };
  },
});
