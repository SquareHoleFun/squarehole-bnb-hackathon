/**
 * SH-EXISTING-NFTS-E08C: a set box's five states, derived from the raw state the indexer publishes (design § 4.10:
 * no new protocol state), with their numbers, the page's line and the card's figure. Wire rows are E-08A's schema.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { setBoxDataSchema, setStarterSetLoaderV2Abi } from '@squarehole/chain/core/set-v2';
import { readSetState } from '../../../../../packages/indexer/src/core/set-v2/state';
import { readTrading } from './set-actions';
import { sdkCall } from './set-calls';
import { readSetIdentity } from './set-identity';
import { CREATOR, FakeSetChain, asOfOf, sparseIds, specFor, wireOf } from './test-support/set-chain';
import { SET_PHASES, bpsOf, countsOf, memberRows, phaseLine, phaseOf, recoveryOf, setRecord, setSummary, tradingOf, type SetPhase } from './set-model';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

const ids = sparseIds(40);
async function rowIn(phase: SetPhase) {
  const chain = new FakeSetChain({ ids });
  const spec = specFor(chain, ids);
  const state = { pending: { loaded: 16 }, open: {}, graduated: { graduated: true, picked: 3 }, failed: { failed: true, loaded: 24 }, recovering: { failed: true, released: 10 } }[phase];
  const box = chain.seed(spec, ids, state);
  // The trading gate as the page and the feed read it on chain (the wire does not carry it).
  return { chain, row: setBoxDataSchema.parse(wireOf(chain)), trading: await readTrading(chain, box.coordinator) };
}

describe('a set box’s state', () => {
  it('names five states from the raw state and the trading gate read on chain, numbers first', async () => {
    const expected: Record<SetPhase, { line: string; counts: Partial<ReturnType<typeof countsOf>> }> = {
      pending: { line: 'Loading 16/40', counts: { loaded: 16n, inside: 16n } },
      open: { line: 'Open', counts: { loaded: 40n, inside: 40n } },
      graduated: { line: 'Graduated', counts: { inside: 37n, outside: 3n, released: 0n } },
      failed: { line: 'Failed', counts: { loaded: 24n, released: 0n } },
      recovering: { line: 'Failed · 10/40 back', counts: { released: 10n, inside: 30n } },
    };
    for (const phase of SET_PHASES) {
      const { row, trading } = await rowIn(phase);
      expect(phaseOf(row, trading), phase).toBe(phase);
      expect(phaseLine(row, trading), phase).toBe(expected[phase].line);
      expect(countsOf(row), phase).toMatchObject({ count: 40n, ...expected[phase].counts });
    }
    // Without the gate read (not answered yet, or failed), an open box shows loading, never a guessed Open.
    const { row } = await rowIn('open');
    expect({ phase: phaseOf(row), line: phaseLine(row) }).toEqual({ phase: 'pending', line: 'Loading 40/40' });
  });

  it('the trading gate: open once a trade sent now lands at or after its opening (the next block is at least now + 1)', () => {
    expect(tradingOf({ gateOpen: true, effectiveOpenAt: 101n, now: 100n })).toEqual({ open: true });
    expect(tradingOf({ gateOpen: true, effectiveOpenAt: 100n, now: 100n })).toEqual({ open: true });
    expect(tradingOf({ gateOpen: true, effectiveOpenAt: 102n, now: 100n })).toEqual({ open: false });
    expect(tradingOf({ gateOpen: false, effectiveOpenAt: 0n, now: 100n })).toEqual({ open: false });
  });

  it('a failed box with every loaded item back says so; one with none back is plain Failed', () => {
    const chain = new FakeSetChain({ ids });
    chain.seed(specFor(chain, ids), ids, { failed: true, released: 40 });
    const row = setBoxDataSchema.parse(wireOf(chain));
    expect(phaseOf(row)).toBe('failed');
    expect(phaseLine(row)).toBe('Failed · all back');
  });

  it('a fully loaded box waiting for complete is still loading (40/40), not open, on E-08B’s real wire (XR F1)', async () => {
    const chain = new FakeSetChain({ ids });
    const box = chain.seed(specFor(chain, ids), ids, { complete: false });
    expect(box.notified).toBe(false);
    // The indexer's own readSetState over the chain: SetVaultV2.seedReady() is true once every id is loaded.
    const read = async () => readSetState({ callAt: async (to: Address, data: Hex) => chain.chain.call({ to, data }) },
      { contracts: { vault: box.vault, starterSetLoader: box.loader } } as never, asOfOf(chain).hash as Hex, box.supply.toString());
    const state = await read();
    expect(state.seedReady).toBe(true);
    const row = setBoxDataSchema.parse({ ...wireOf(chain), state });
    const trading = await readTrading(chain, box.coordinator);
    expect(trading.open).toBe(false);
    expect({ phase: phaseOf(row, trading), line: phaseLine(row, trading) }).toEqual({ phase: 'pending', line: 'Loading 40/40' });
    // The loader's complete() (through E-08B's guard) opens the coordinator's trading gate: now Open.
    const identity = await readSetIdentity(chain, chain.source, box.coordinator, box.encoded);
    const complete = sdkCall('complete', { to: box.loader, data: encodeFunctionData({ abi: setStarterSetLoaderV2Abi, functionName: 'complete' }), value: 0n });
    await chain.submit({ feeReader: TEST_FEE_READER, wallet: async () => null, target: { kind: 'box', identity }, call: complete, from: CREATOR, gasLimit: 100_000n });
    const opened = await readTrading(chain, box.coordinator);
    expect(opened.open).toBe(true);
    const after = setBoxDataSchema.parse({ ...wireOf(chain), state: await read() });
    expect({ phase: phaseOf(after, opened), line: phaseLine(after, opened) }).toEqual({ phase: 'open', line: 'Open' });
  });

  it('cards: the feed’s state chip and one figure per state; a bar while loading and while items go back', async () => {
    const figures: Record<SetPhase, { state: string; text: string; bar: number | null }> = {
      pending: { state: 'upcoming', text: 'Loading 16/40', bar: 4000 },
      open: { state: 'bonding', text: 'Raise 4.206980085 ETH', bar: null },
      graduated: { state: 'graduated', text: '37/40 inside', bar: null },
      failed: { state: 'failed', text: 'Failed', bar: null },
      recovering: { state: 'failed', text: '10/40 back', bar: 2500 },
    };
    for (const phase of SET_PHASES) {
      const { chain, row, trading } = await rowIn(phase);
      const record = setRecord(row, chain.source, asOfOf(chain));
      expect(record).toMatchObject({ kind: 'existing', itemCount: 40n, name: 'Outside Set', ticker: 'OUT', rehearsal: true, networkLabel: 'Local chain' });
      expect(record.set?.box).toBe(row);
      const summary = setSummary(record, row, false, trading);
      expect({ state: summary.state, text: summary.figure.text, bar: summary.figure.barBps }, phase).toEqual(figures[phase]);
      expect(summary.notice).toBeNull();
      expect(setSummary(record, row, true).notice).toBe('Stale');
      expect(summary.mcapRaw).toBeNull();
      expect(summary.volumeRaw).toBeNull();
    }
  });

  it('members keep accepted order and full-width ids; recovery sends items never tried first, refused ones apart (XR F2)', () => {
    const rows = memberRows([
      { index: '0', id: '0', state: 'Inside' },
      { index: '1', id: ((1n << 256n) - 1n).toString(), state: 'Deferred' },
      { index: '2', id: '7', state: 'Released' },
    ]);
    expect(rows.map((row) => [row.index, row.id])).toEqual([[0, 0n], [1, (1n << 256n) - 1n], [2, 7n]]);
    expect(recoveryOf(rows, 32)).toEqual({ untried: [0n], retry: [(1n << 256n) - 1n] });
    // 32 refused ahead of 8 never tried: the next page is the 8, the 32 wait in their own retry.
    const many = memberRows(Array.from({ length: 40 }, (_, i) => ({ index: String(i), id: String(i), state: i < 32 ? 'Deferred' as const : 'Inside' as const })));
    expect(recoveryOf(many, 32)).toEqual({ untried: Array.from({ length: 8 }, (_, i) => BigInt(32 + i)), retry: Array.from({ length: 32 }, (_, i) => BigInt(i)) });
    // More than 32 refused: retries take turns from after the last one sent, wrapping round (XR2 F2).
    const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => BigInt(from + i));
    const deferred70 = memberRows(Array.from({ length: 70 }, (_, i) => ({ index: String(i), id: String(i), state: 'Deferred' as const })));
    expect(recoveryOf(deferred70, 32).retry).toEqual(range(0, 32));
    expect(recoveryOf(deferred70, 32, 31).retry).toEqual(range(32, 64));
    expect(recoveryOf(deferred70, 32, 63).retry).toEqual([...range(64, 70), ...range(0, 26)]);
    expect(recoveryOf(deferred70, 32, 69).retry).toEqual(range(0, 32));
    // Items that went back meanwhile drop out of the turn; the order stays the accepted one.
    const later = memberRows(Array.from({ length: 70 }, (_, i) => ({ index: String(i), id: String(i), state: i >= 32 && i < 64 ? 'Released' as const : 'Deferred' as const })));
    expect(recoveryOf(later, 32, 31).retry).toEqual([...range(64, 70), ...range(0, 26)]);
    expect(bpsOf(1n, 3n)).toBe(3333);
    expect(bpsOf(5n, 0n)).toBe(0);
    expect(bpsOf(9n, 9n)).toBe(10_000);
  });
});
