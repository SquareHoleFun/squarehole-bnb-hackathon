#!/usr/bin/env node
/**
 * F156 (SH-ALPHA-TRADE-BOX): `pnpm dev:alpha-local` (and `--e2e` for apps/web/playwright.alpha-trade.config.ts): the
 * Sepolia alpha's trade box on a fresh local 31337 chain, LOCAL ONLY. The stack itself is
 * packages/chain/scripts/alpha-local-stack.mjs, where viem and the alpha rehearsal's libraries resolve.
 */
await import('../packages/chain/scripts/alpha-local-stack.mjs');
