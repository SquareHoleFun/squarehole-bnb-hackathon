/**
 * BC-081 at the window's edges (review of open-at, finding 6). The phase rule moved from block numbers to the block's
 * time (open-at-clock-time.md), but no test held a block exactly at `openAt` or at `windowEndsAt`: `<` for `<=` at
 * either edge passed the whole suite. The recorded local life opens at openAt + 3 s and bonds at windowEndsAt + 8 s,
 * while on Sepolia a whole-minute openAt is met by a block exactly at it (slots at 0 mod 12). Here the edges are
 * probed one second apart, by the rule alone and through the indexer on synthetic chains whose blocks land exactly on
 * them (and one second off), against the hook's own rule (BoxHook.phase(): Upcoming while block.timestamp < openAt,
 * Window while < openAt + WINDOW_SECONDS, else Bonding; Closed and Graduated by their recorded blocks).
 */
import { WINDOW_SECONDS } from '@squarehole/box-spec';
import { labelAddress } from '@squarehole/chain/core/test-support';
import { describe, expect, it } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { phaseAt, type CorePhase } from '../../src/core/derive-core';
import type { BlockHeader } from '../../src/model';
import { getSqrtPriceAtTick } from '../../src/v4-math';
import { agreeingCalls, ev, synthBox, synthManifest, synthTimeOf, World, type SynthBox } from './core-synth';

/** BoxHook.phase() (BoxHook.sol), written out independently of the indexer's `phaseAt`. */
function hookPhase(timestamp: bigint, openAt: bigint, closed: boolean, migrated: boolean): CorePhase {
  if (migrated) return 'graduated';
  if (closed) return 'graduating';
  if (timestamp < openAt) return 'upcoming';
  return timestamp < openAt + WINDOW_SECONDS ? 'window' : 'bonding';
}

describe('BC-081: phaseAt at the window edges, to the second', () => {
  const openAt = 1_800_000_384n;
  const windowEndsAt = openAt + WINDOW_SECONDS;
  const at = (timestamp: bigint, closed: bigint | null = null, migrated: bigint | null = null) => phaseAt({ number: 100n, timestamp }, openAt, windowEndsAt, closed, migrated);

  it('BC-081: phaseAt is upcoming in the second before openAt, window from openAt to its last second, bonding from windowEndsAt', () => {
    expect(at(openAt - 1n)).toBe('upcoming');
    expect(at(openAt)).toBe('window');
    expect(at(openAt + 1n)).toBe('window');
    expect(at(windowEndsAt - 1n)).toBe('window');
    expect(at(windowEndsAt)).toBe('bonding');
    for (const t of [openAt - 1n, openAt, windowEndsAt - 1n, windowEndsAt]) expect(at(t), String(t)).toBe(hookPhase(t, openAt, false, false));
  });

  it('BC-081: in phaseAt a close or a migration recorded at or before the block wins at every edge', () => {
    for (const t of [openAt - 1n, openAt, windowEndsAt - 1n, windowEndsAt]) {
      expect(at(t, 100n), String(t)).toBe('graduating');
      expect(at(t, 99n, 100n), String(t)).toBe('graduated');
      // Recorded after this block: not yet.
      expect(at(t, 101n), String(t)).toBe(hookPhase(t, openAt, false, false));
    }
  });
});

/**
 * One box created in block 12 on a synthetic chain (block n at SYNTH_START_TIME + 12 n). Its openAt defaults to the
 * creation time + 240 s, so block 32 lands exactly on openAt and block 64 exactly on windowEndsAt; `offset` moves the
 * spec's openAt by that many seconds (1: both edges fall one second after a block).
 */
function edgeWorld(head: bigint, offset = 0n): { w: World; box: SynthBox } {
  const w = new World();
  const box = synthBox({ boxId: 0n, creationBlock: 12n, openAt: Number(synthTimeOf(32n) + offset) });
  w.block(10n);
  w.block(box.row.creationBlock, [w.created(box, [ev.initialize(box, getSqrtPriceAtTick(-30_000), -30_000), ev.mint(box, labelAddress('pool'), 10n ** 27n)])]);
  w.to(head);
  return { w, box };
}

async function indexed(w: World, box: SynthBox): Promise<{ indexer: CoreChainIndexer; chain: ReturnType<World['chain']>; token: string }> {
  const chain = w.chain();
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest(), auditEvery: 1_000 });
  await indexer.start();
  await indexer.idle();
  return { indexer, chain, token: (box.row.contracts.token as string).toLowerCase() };
}

const headerOf = (w: World, n: bigint): BlockHeader => {
  const h = w.headers.find((x) => x.number === n);
  if (!h) throw new Error(`no block ${n}`);
  return h;
};

describe('BC-081 on a synthetic chain whose blocks land on the edges', () => {
  it('BC-081: the derived phase equals the hook rule in the blocks around openAt and windowEndsAt (exactly on them, and one second off)', async () => {
    for (const offset of [0n, 1n]) {
      const { w, box } = edgeWorld(70n, offset);
      expect(box.row.openAt).toBe(synthTimeOf(32n) + offset);
      expect(box.row.windowEndsAt).toBe(synthTimeOf(64n) + offset);
      const { indexer, token } = await indexed(w, box);
      const entry = indexer.boxes.get(token);
      if (!entry) throw new Error('box 0 not indexed');
      const seen: Record<string, CorePhase | undefined> = {};
      for (const n of [31n, 32n, 33n, 63n, 64n, 65n]) {
        const h = headerOf(w, n);
        const phase = indexer.stateAt(entry, h)?.phase;
        seen[String(n)] = phase;
        expect(phase, `offset ${offset}, block ${n} (t = ${h.timestamp})`).toBe(hookPhase(h.timestamp, box.row.openAt, false, false));
      }
      // Exactly on the edges the open and the bonding start in blocks 32 and 64; one second later, a block later.
      expect(seen).toEqual(
        offset === 0n
          ? { '31': 'upcoming', '32': 'window', '33': 'window', '63': 'window', '64': 'bonding', '65': 'bonding' }
          : { '31': 'upcoming', '32': 'upcoming', '33': 'window', '63': 'window', '64': 'window', '65': 'bonding' },
      );
    }
  });

  it('BC-081: the audit at a head exactly on openAt and on windowEndsAt agrees with a hook that answers by its own rule', async () => {
    for (const head of [31n, 32n, 63n, 64n]) {
      const { w, box } = edgeWorld(head);
      const { indexer, chain, token } = await indexed(w, box);
      const t = headerOf(w, head).timestamp;
      const onChain = hookPhase(t, box.row.openAt, false, false);
      // Every other read agrees with the pipeline; the hook's phase() is the contract's rule at the head's time.
      chain.callAnswers = agreeingCalls(indexer, (tok, key, value) => (tok === token && key === 'hook.phase' ? onChain : value));
      const [result] = await indexer.audit();
      expect(result?.result.ok, `head ${head} (t = ${t}): ${JSON.stringify(result?.result.mismatches)}`).toBe(true);
      expect(indexer.boxView(token)?.phase, `head ${head}`).toBe(onChain);
    }
  });
});
