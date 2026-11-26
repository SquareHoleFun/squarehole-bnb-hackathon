/**
 * F128 "Claim all covers every claim a wallet has" (claim-all.ts): building the list (every kind, in run order, box
 * after box), the creator's and the hand-in's block-number rule, and the stop rule through `claimInOrder`.
 */
import { describe, expect, it } from 'vitest';
import { boxSteps, claimCount, claimList, listSignature, singleState, stepP, withSingleClaim, withSingleRead, type BoxClaimsInput, type ClaimStep, type SingleKnown } from './claim-all';
import { claimInOrder } from './holder-claims';

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const none = { kind: 'none' } as const;
const ready = (amount: bigint, extra: { pOut?: bigint; approved?: bigint; collectFirstP?: bigint } = {}) => singleState(withSingleRead(undefined, { block: 100n, amount, ...extra }));
const input = (patch: Partial<BoxClaimsInput> = {}): BoxClaimsInput => ({ holder: [], items: [], creator: none, remainder: none, handIn: none, ...patch });

describe('F128 one box: every claim, in run order', () => {
  it('holder batches and items ascending, then creator fees, the remainder, the approval and the hand-in', () => {
    const steps = boxSteps(input({
      holder: [{ batch: 3n, amount: 30n }, { batch: 1n, amount: 10n }],
      items: [{ id: 7n, amount: 70n }, { id: 2n, amount: 20n }],
      creator: ready(5n), remainder: ready(6n), handIn: ready(3n * 10n ** 18n, { pOut: 9n, approved: 0n }),
    }));
    expect(steps).toEqual([
      { kind: 'holder', batch: 1n, amount: 10n }, { kind: 'holder', batch: 3n, amount: 30n },
      { kind: 'item', id: 2n, amount: 20n }, { kind: 'item', id: 7n, amount: 70n },
      { kind: 'creator', amount: 5n }, { kind: 'remainder', amount: 6n },
      { kind: 'approve', coins: 3n * 10n ** 18n }, { kind: 'hand-in', coins: 3n * 10n ** 18n, amount: 9n },
    ]);
    // Eight signatures, seven claims (the approval pays nothing).
    expect(claimCount(steps)).toBe(7);
    expect(steps.map(stepP)).toEqual([10n, 30n, 20n, 70n, 5n, 6n, 0n, 9n]);
  });

  it('the hand-in skips its approval when the coordinator may already take every coin', () => {
    expect(boxSteps(input({ handIn: ready(4n, { pOut: 2n, approved: 4n }) }))).toEqual([{ kind: 'hand-in', coins: 4n, amount: 2n }]);
    expect(boxSteps(input({ handIn: ready(4n, { pOut: 2n, approved: 3n }) })).map((s) => s.kind)).toEqual(['approve', 'hand-in']);
  });

  it('SH-RC7 item 29: a hand-in step always carries its P out of the pot; a read without it makes no step, never a 0 or an unpriced share', () => {
    // The merged coordinator quotes the final share (pot plus the inbox's readable P); the unpriced collect-first
    // share (RC6 R1-3) is gone, so a read without its quote lists nothing to sign.
    expect(boxSteps(input({ handIn: ready(4n, { approved: 0n, collectFirstP: 7n }) }))).toEqual([]);
    expect(boxSteps(input({ handIn: ready(4n, { approved: 0n }) }))).toEqual([]);
    // RC6-RR-INBOX: a priced read stays priced, and names the inbox P its quote includes.
    const steps = boxSteps(input({ handIn: ready(4n, { approved: 0n, pOut: 9n, collectFirstP: 7n }) }));
    expect(steps).toEqual([{ kind: 'approve', coins: 4n }, { kind: 'hand-in', coins: 4n, amount: 9n, collectFirstP: 7n }]);
    expect(steps.map(stepP)).toEqual([0n, 9n]);
    const sig = (pOut: bigint) => listSignature(claimList([{ key: 'A', box: null, steps: boxSteps(input({ handIn: ready(4n, { approved: 4n, pOut, collectFirstP: 7n }) })) }]));
    expect(sig(9n)).toBe(sig(9n));
    expect(sig(9n)).not.toBe(sig(10n));
  });

  it('RC6-RR-INBOX: the creator remainder names the inbox P its quote includes; its sum counts the whole remainder', () => {
    const steps = boxSteps(input({ remainder: ready(77n, { collectFirstP: 77n }) }));
    expect(steps).toEqual([{ kind: 'remainder', amount: 77n, collectFirstP: 77n }]);
    expect(steps.map(stepP)).toEqual([77n]);
    expect(boxSteps(input({ remainder: ready(6n) }))).toEqual([{ kind: 'remainder', amount: 6n }]);
  });

  it('nothing ready, a zero amount, an unread or a claimed single claim makes no step', () => {
    const claimed = singleState(withSingleClaim(withSingleRead(undefined, { block: 100n, amount: 5n }), { tx: H(1), block: 120n, paid: 5n }));
    expect(boxSteps(input({ holder: [{ batch: 1n, amount: 0n }], creator: claimed, remainder: { kind: 'unknown' }, handIn: ready(0n) }))).toEqual([]);
  });
});

describe('F128 the whole wallet: box after box', () => {
  it('keeps each box’s steps together and the boxes in the order given', () => {
    const a: ClaimStep[] = [{ kind: 'holder', batch: 1n, amount: 1n }, { kind: 'hand-in', coins: 2n, amount: 3n }];
    const b: ClaimStep[] = [{ kind: 'item', id: 1n, amount: 4n }, { kind: 'creator', amount: 5n }];
    const list = claimList([{ key: 'A', box: 'box A', steps: a }, { key: 'B', box: 'box B', steps: b }, { key: 'C', box: 'box C', steps: [] }]);
    expect(list.map((e) => `${e.key}:${e.step.kind}`)).toEqual(['A:holder', 'A:hand-in', 'B:item', 'B:creator']);
    expect(list[2]?.box).toBe('box B');
  });

  it('the signature changes with any box, step or amount, so a changed list is never sent as confirmed', () => {
    const list = (amount: bigint) => claimList([{ key: 'A', box: null, steps: [{ kind: 'holder', batch: 1n, amount }] }]);
    expect(listSignature(list(1n))).toBe(listSignature(list(1n)));
    expect(listSignature(list(1n))).not.toBe(listSignature(list(2n)));
    expect(listSignature(claimList([{ key: 'B', box: null, steps: [{ kind: 'holder', batch: 1n, amount: 1n }] }]))).not.toBe(listSignature(list(1n)));
  });
});

describe('F128 the creator’s claims and the hand-in follow the block-number rule', () => {
  const read = (known: SingleKnown | undefined, block: bigint, amount: bigint) => withSingleRead(known, { block, amount });
  const claim = { tx: H(9), block: 120n, paid: 5n };

  it('mined at block R: Claimed until a read at R or later decides; an older read changes nothing', () => {
    const claimed = withSingleClaim(read(undefined, 100n, 5n), claim);
    expect(singleState(claimed)).toEqual({ kind: 'claimed', amount: 5n });
    expect(singleState(read(claimed, 119n, 5n))).toEqual({ kind: 'claimed', amount: 5n });
  });

  it('a deciding read with nothing left keeps Claimed; one with something left is what can be claimed now', () => {
    const claimed = withSingleClaim(read(undefined, 100n, 5n), claim);
    expect(singleState(read(claimed, 120n, 0n))).toEqual({ kind: 'claimed', amount: 5n });
    expect(singleState(read(claimed, 121n, 2n))).toMatchObject({ kind: 'ready', read: { block: 121n, amount: 2n } });
  });

  it('keeps the newest read: an older read arriving late is ignored', () => {
    const newer = read(undefined, 130n, 0n);
    expect(read(newer, 125n, 7n)).toBe(newer);
    expect(singleState(undefined)).toEqual({ kind: 'unknown' });
    expect(singleState(read(undefined, 1n, 0n))).toEqual({ kind: 'none' });
  });
});

describe('F128 the stop rule', () => {
  it('runs one step at a time and stops at the first that does not confirm; the rest is never started', async () => {
    const steps = boxSteps(input({ holder: [{ batch: 1n, amount: 1n }, { batch: 2n, amount: 2n }], creator: ready(5n), handIn: ready(4n, { pOut: 2n }) }));
    const started: string[] = [];
    const result = await claimInOrder(steps, async (step, index) => {
      started.push(`${index}:${step.kind}`);
      await Promise.resolve();
      if (step.kind === 'creator') throw new Error('not confirmed');
    });
    expect(started).toEqual(['0:holder', '1:holder', '2:creator']);
    expect(result).toMatchObject({ done: 2, stoppedAt: { kind: 'creator', amount: 5n }, error: new Error('not confirmed') });
  });

  it('a hand-in whose approval does not confirm never sends the hand-in', async () => {
    const steps = boxSteps(input({ handIn: ready(4n, { pOut: 2n }) }));
    const started: string[] = [];
    const result = await claimInOrder(steps, async (step) => { started.push(step.kind); if (step.kind === 'approve') throw new Error('rejected'); });
    expect(started).toEqual(['approve']);
    expect(result.done).toBe(0);
  });

  it('every step confirmed: done is the whole list', async () => {
    const steps = boxSteps(input({ items: [{ id: 1n, amount: 1n }, { id: 2n, amount: 1n }] }));
    expect(await claimInOrder(steps, async () => undefined)).toEqual({ done: 2, stoppedAt: null, error: null });
  });
});
