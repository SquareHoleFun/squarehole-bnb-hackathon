/**
 * Box 0's real block reader (`box0IO().block()`) in unit tests (SH-BOX0-DRAW-VALUE): a node's JSON-RPC answer behind
 * `fetch`, its fields exactly as given. Callers undo the stub in `afterEach` (`vi.unstubAllGlobals()`).
 */
import { vi } from 'vitest';
import { rpcFetch } from '../../v2/test-support/rpc-fetch';
import { box0IO, type Box0IO } from '../box0-send';

/** A node's latest block at `time`; `fields` add or replace raw JSON fields, and a field set to `undefined` is left out. */
export function blockJson(time: bigint, fields: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const block: Record<string, unknown> = {
    number: '0x10', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: `0x${time.toString(16)}`,
    gasLimit: '0x1c9c380', gasUsed: '0x0', miner: `0x${'00'.repeat(20)}`, extraData: '0x', transactions: [], ...fields,
  };
  return Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined));
}

/** The real `box0IO().block()`, reading `eth_getBlockByNumber` from a node that answers `served()`. */
export function nodeBlock(served: () => unknown): Box0IO['block'] {
  vi.stubGlobal('fetch', rpcFetch(async ({ method }) => {
    if (method === 'eth_getBlockByNumber') return served();
    throw new Error(method);
  }));
  return box0IO('http://127.0.0.1:1', async () => {
    throw new Error('no wallet');
  }).block;
}
