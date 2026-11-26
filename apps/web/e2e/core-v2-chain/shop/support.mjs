/**
 * SH-V21-FE13's chain-backed shop life: where its stack keeps the run (chain description, anvil log) and the pictures
 * of the box the browser creates, apart from the core-v2-chain suite's and the examples suite's. No TypeScript import:
 * the Playwright config, the stack and the spec all load it.
 */
import { join } from 'node:path';
import { ROOT } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';

export const RUN = join(ROOT, '.cache/core-v2-shop/run');
/** The box the test creates commits its logo by SHA-256; the stack's art gateway serves what the test writes here. */
export const ART = join(RUN, 'art');
export const CHAIN_FILE = join(RUN, 'local-core-v2-chain.json');
