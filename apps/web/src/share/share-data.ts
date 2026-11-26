/**
 * Which box a shared link names, and what its card says (`ShareBox`): a Demo box (chain 31337) from the app's own Demo
 * data, saying Demo; any other box read by @squarehole/cards (`loadCoreBox`: the indexer gateway's snapshot, else the
 * registry row through a keyless public RPC, only for the registries of the build's core manifest), the same code the
 * card service on the droplet reads the box with, so the page's tags and its picture name the same state.
 *
 * The route params are untrusted: `parseBoxRoute` (the site's own rule) checks them before anything is fetched.
 */
import { loadCoreBox, type ShareBox, type ShareConfig, type ShareLookup, type ShareReaders, type ShareState } from '@squarehole/cards';
import { DEMO_CHAIN_ID } from '@squarehole/domain';
import { parseBoxRoute } from '../features/boxes/box-id';
import type { BoxState } from '../features/boxes/box-model';
import { DEMO_BOXES } from '../features/boxes/demo-boxes';
import { DEMO_FIT_TARGET } from '../features/fit-pair/fit-target';

function demoState(state: BoxState | null): ShareState {
  switch (state) {
    case 'window':
    case 'bonding':
      return { kind: 'open' };
    case 'graduating':
      return { kind: 'graduating' };
    case 'graduated':
      return { kind: 'graduated' };
    case 'failed':
      return { kind: 'failed' };
    default:
      // The Demo's upcoming boxes count from the visit ("~2 h"): no fixed time to name.
      return { kind: 'upcoming', opensAt: null, approx: false };
  }
}

/** A Demo box (the five Demo boxes and the Demo Misfits, in its default state), or null. */
export function demoBox(token: `0x${string}`): ShareBox | null {
  const base = { chainId: DEMO_CHAIN_ID, token, chainLabel: 'Local chain', demo: true, logoSha256: null } as const;
  const record = DEMO_BOXES.find((box) => box.token.toLowerCase() === token);
  if (record) return { ...base, name: record.name, ticker: record.ticker, state: demoState(record.demoState) };
  if (DEMO_FIT_TARGET.token.toLowerCase() === token) {
    // The Demo Misfits open on their curve unless a `?scenario=` asks for another state (BoxPage).
    return { ...base, name: DEMO_FIT_TARGET.names.collectionName, ticker: DEMO_FIT_TARGET.names.tokenSymbol, state: { kind: 'open' } };
  }
  return null;
}

/**
 * The box a `/box/:chain/:address` link names, and what its card says. Never throws. `demo: false` (the production
 * site's function, `SH_BUILD=production` among its variables) knows no Demo box: the Demo chain's links are unknown.
 */
export async function loadShareBox(chain: string | undefined, address: string | undefined, config: ShareConfig, readers: ShareReaders, { demo = true }: { readonly demo?: boolean } = {}): Promise<ShareLookup> {
  const parsed = parseBoxRoute(chain, address);
  if (parsed === null) return { status: 'invalid' };
  const token = parsed.token as `0x${string}`;
  if (parsed.chainId === DEMO_CHAIN_ID) {
    if (!demo) return { status: 'unknown', reason: 'not a box on this site' };
    const box = demoBox(token);
    return box ? { status: 'box', box, via: 'demo' } : { status: 'unknown', reason: 'not a box on this site' };
  }
  return loadCoreBox(parsed.chainId, token, config, readers);
}
