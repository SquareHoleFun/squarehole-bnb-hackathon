/**
 * F156 (SH-ALPHA-TRADE-BOX): what the local alpha stack (../alpha-local-stack.mjs) and its browser suite
 * (apps/web/e2e/alpha-trade) both do to the 31337 alpha chain: run one of the alpha's Forge entries, make a box, move the
 * chain's clock, wait for the indexer to publish a box verified. LOCAL ONLY: every call is checked to go to a loopback
 * anvil with chain id 31337 (core-v2-local-runtime.mjs `assertLocalRpc`), signed by its unlocked test accounts.
 * No TypeScript and no trade module is loaded here, so a browser suite can use it as it is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ALPHA_CHAIN_ID, CONTRACTS, ROOT, assertLocalRpc, delay, rpc, run } from './core-v2-local-runtime.mjs';

export const ALPHA_FORGE_OUT = join(ROOT, '.cache/alpha-forge-out');
export const ALPHA_FORGE_CACHE = join(ROOT, '.cache/alpha-forge-cache');
/** Names the newest stack's run file (written to a new file and renamed over this one). */
export const ALPHA_STACK_POINTER = join(ROOT, '.cache/alpha-local/current.json');

/** The value a Forge entry printed as `ALPHA|<name>|0x…` (AlphaRehearsalSetup, CoreV2LocalGenesis, DeployCoreV2Local). */
export function printed(output, name) {
  const value = output.match(new RegExp(`ALPHA\\|${name}\\|\\s*(0x[0-9a-fA-F]+)`))?.[1];
  if (!value) throw new Error(`forge omitted ${name}`);
  return value;
}

/** One of the alpha's Forge entries, broadcast to the alpha's anvil by an unlocked test account (as AlphaRun.forge). */
export async function forgeAlpha(url, target, signature, args, from) {
  await assertLocalRpc(url, rpc, { alpha: true });
  return run('forge', ['script', `script/local/${target}.s.sol:${target}`, '--sig', signature, ...args.map(String),
    '--rpc-url', url, '--broadcast', '--unlocked', '--sender', from, '--slow', '--isolate', '--no-storage-caching', '--hardfork', 'osaka',
    '--out', relative(CONTRACTS, ALPHA_FORGE_OUT), '--cache-path', relative(CONTRACTS, ALPHA_FORGE_CACHE)],
  { cwd: CONTRACTS, env: { FOUNDRY_OFFLINE: 'true', FOUNDRY_THREADS: '4' }, timeoutMs: 900_000 });
}

/**
 * A box of the alpha, made by `from` (AlphaRehearsalSetup.runBox: the local plain recipe, 30 days to fill; listing 0
 * is native ETH with a 0.1 ETH raise, listing 1 tETH with 1 tETH). Its coordinator.
 */
export async function createAlphaBox(url, { factory, listingId, openAt, from }) {
  return printed(await forgeAlpha(url, 'AlphaRehearsalSetup', 'runBox(address,uint32,uint32)', [factory, listingId, openAt], from), 'box');
}

/** Mines `blocks` blocks, one second apart (a new box is audited by the indexer every 32 blocks). */
export async function mineAlpha(url, blocks) {
  await assertLocalRpc(url, rpc, { alpha: true });
  await rpc(url, 'anvil_mine', [`0x${blocks.toString(16)}`, '0x1']);
}

/** The indexer's v2 cards of these coordinators, once every one is published, verified and current. */
export async function waitForAlphaFeed(origin, coordinators, { timeoutMs = 120_000 } = {}) {
  const wanted = coordinators.map((c) => c.toLowerCase());
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${origin}/v2/feed?chain=${ALPHA_CHAIN_ID}`, { signal: AbortSignal.timeout(2000) });
      const cards = ((await response.json()).cards ?? []).filter((card) => wanted.includes(card.row?.record?.contracts?.[0]?.toLowerCase()));
      if (cards.length === wanted.length && cards.every((card) => card.verified === true && card.stale === false)) return cards;
    } catch { /* The indexer may still be starting or catching up. */ }
    if (Date.now() > until) throw new Error(`the indexer did not publish ${wanted.join(', ')} verified and current`);
    await delay(150);
  }
}

/** The newest stack's run file: addresses, accounts, ports and its manifests. */
export function readAlphaStack() {
  if (!existsSync(ALPHA_STACK_POINTER)) throw new Error('no alpha stack has run yet (pnpm dev:alpha-local)');
  return JSON.parse(readFileSync(JSON.parse(readFileSync(ALPHA_STACK_POINTER, 'utf8')).stack, 'utf8'));
}
