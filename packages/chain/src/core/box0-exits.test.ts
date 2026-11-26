/**
 * SH-BOX0-EXITS: the ways out of a stopped draw on box 0's page (core v1 terminal mode, BoxTickets.sol `cancelDraw`,
 * the number-less `handBack`, `takeByNumber`). Each is one more entry in the box 0 allowlist, bound to its contract's
 * arguments: no value, an empty reveal, a positive floor and a deadline. `enterTerminal` is not one (F142, desk R61-STOP
 * "hide"): the site never sends it; the exits show only once someone else has.
 */
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { boxTicketsAbi } from '../abi';
import { NotSendableError } from '../write/calls';
import { EMPTY_REVEAL, MAX_HAND_BACK_IDS, assertSendableBox0Call, box0Calls, handBackMinFor, type Box0Target } from './box0-calls';

const me = '0x00000000000000000000000000000000000000a1' as const;
const token = '0x0000000000000000000000000000000000000f17' as const;
const tickets = '0x0000000000000000000000000000000000007777' as const;
const stream = '0x0000000000000000000000000000000000005555' as const;
const target: Box0Target = { chainId: 11155111, token, tickets, stream, service: null };
const deadline = 1_800_000_000n;
const t = (data: Hex, value = 0n) => ({ to: tickets, data, value });

describe('SH-BOX0-EXITS box 0 exit calls', () => {
  it('builds the three exits on the tickets contract, with no value, and accepts each for the caller', () => {
    const calls = [
      box0Calls.cancelDraw(target, 2n),
      box0Calls.handBack(target, [7n], 990n, deadline),
      box0Calls.takeByNumber(target, 4123n, 5n, 1_021n, deadline),
    ];
    for (const call of calls) expect(() => assertSendableBox0Call(call, target, me)).not.toThrow();
    expect(calls.map((c) => [c.to, c.value])).toEqual(calls.map(() => [tickets, 0n]));
    // The take sends the empty reveal: the item leaves without its picture (the contract's fallback from TAKE_DELAY).
    const take = decodeFunctionData({ abi: boxTicketsAbi, data: (calls[2] as { data: Hex }).data });
    expect(take).toMatchObject({ functionName: 'takeByNumber', args: [4123n, 5n, 1_021n, deadline, { traitsPacked: 0n, proof: [] }] });
    // Item 0 and pool index 0 are valid numbers (a box may start its ids at 0).
    expect(() => assertSendableBox0Call(box0Calls.takeByNumber(target, 0n, 0n, 1n, deadline), target, me)).not.toThrow();
  });

  it('has no stop: enterTerminal is neither built nor sendable (F142)', () => {
    expect('enterTerminal' in box0Calls).toBe(false);
    const stop = encodeFunctionData({ abi: boxTicketsAbi, functionName: 'enterTerminal' });
    for (const to of [tickets, stream, token]) expect(() => assertSendableBox0Call({ to, data: stop, value: 0n }, target, me)).toThrow(NotSendableError);
  });

  it('keeps a hand-back floor at the quote less 1%, never zero', () => {
    expect(handBackMinFor(1_000n)).toBe(990n);
    expect(handBackMinFor(1_099n)).toBe(1_089n);
    expect(handBackMinFor(1n)).toBe(1n);
    expect(() => handBackMinFor(0n)).toThrow();
  });

  it('refuses value, a zero floor or deadline, repeats, too many ids, a proof and a zero ticket', () => {
    const bad = [
      { ...box0Calls.cancelDraw(target, 2n), value: 1n },
      { ...box0Calls.cancelDraw(target, 2n), to: stream },
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'cancelDraw', args: [0n] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'handBack', args: [[7n], 0n, deadline] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'handBack', args: [[7n], 990n, 0n] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'handBack', args: [[], 990n, deadline] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'handBack', args: [[7n, 7n], 990n, deadline] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'handBack', args: [[0n], 990n, deadline] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'handBack', args: [Array.from({ length: MAX_HAND_BACK_IDS + 1 }, (_, i) => BigInt(i + 1)), 990n, deadline] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'takeByNumber', args: [4123n, 5n, 0n, deadline, EMPTY_REVEAL] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'takeByNumber', args: [4123n, 5n, 1_021n, 0n, EMPTY_REVEAL] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'takeByNumber', args: [4123n, 5n, 1_021n, deadline, { ...EMPTY_REVEAL, proof: [`0x${'11'.repeat(32)}`] }] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'takeByNumber', args: [4123n, 5n, 1_021n, deadline, { ...EMPTY_REVEAL, traitsPacked: 1n }] })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'requestGraduationWord' })),
      t(encodeFunctionData({ abi: boxTicketsAbi, functionName: 'acceptGraduationWord' })),
    ];
    for (const call of bad) expect(() => assertSendableBox0Call(call, target, me), call.data.slice(0, 10)).toThrow(NotSendableError);
  });

  it('refuses to build a hand-back of no placeholder or with a zero floor', () => {
    expect(() => box0Calls.handBack(target, [], 990n, deadline)).toThrow(NotSendableError);
    expect(() => box0Calls.handBack(target, [7n], 0n, deadline)).toThrow(NotSendableError);
  });
});
