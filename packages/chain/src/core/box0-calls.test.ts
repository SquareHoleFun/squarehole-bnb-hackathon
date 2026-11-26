import { encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { boxItemStreamAbi, boxTicketsAbi } from '../abi';
import { NotSendableError } from '../write/calls';
import {
  DRAW_BOUNTY_GAS,
  DRAW_VALUE_CAP,
  EMPTY_REVEAL,
  MAX_CLAIM_IDS,
  assertSendableBox0Call,
  box0Calls,
  drawLimitFor,
  drawValueFor,
  type Box0Target,
} from './box0-calls';

const me = '0x00000000000000000000000000000000000000a1' as const;
const other = '0x00000000000000000000000000000000000000b2' as const;
const token = '0x0000000000000000000000000000000000000f17' as const;
const tickets = '0x0000000000000000000000000000000000007777' as const;
const stream = '0x0000000000000000000000000000000000005555' as const;
const service = '0x000000000000000000000000000000000000c0de' as const;
const target: Box0Target = { chainId: 11155111, token, tickets, stream, service };
const GWEI = 1_000_000_000n;
const deadline = 1_800_000_000n;

describe('SH-BOX0-ACTIONS box 0 call allowlist', () => {
  it('builds the six calls and accepts each for the caller', () => {
    const calls = [
      box0Calls.approveFit(target, 1_010n),
      box0Calls.draw(target, 1_010n, deadline, drawValueFor(GWEI)),
      box0Calls.openDraw(target, 3n),
      box0Calls.open(target, 7n),
      box0Calls.approveService(target, 7n),
      box0Calls.claim(target, [4100n, 4101n], me),
    ];
    // The draw's confirmed ETH (SH-BOX0-DRAW-VALUE); every other call ignores it.
    for (const call of calls) expect(() => assertSendableBox0Call(call, { ...target, drawValue: drawValueFor(GWEI) }, me)).not.toThrow();
    expect(calls.map((c) => c.to)).toEqual([token, tickets, tickets, tickets, tickets, stream]);
    expect(calls.map((c) => c.value)).toEqual([0n, drawValueFor(GWEI), 0n, 0n, 0n, 0n]);
  });

  it('pays the round at twice the base fee plus 1 gwei, refuses fees above the ceiling, and limits a draw to its quote plus 1%', () => {
    expect(drawValueFor(0n)).toBe(DRAW_BOUNTY_GAS * GWEI);
    expect(drawValueFor(3n * GWEI)).toBe(DRAW_BOUNTY_GAS * 7n * GWEI);
    expect(() => drawValueFor(100n * GWEI)).toThrow(/fees are too high/i);
    expect(DRAW_VALUE_CAP).toBe(DRAW_BOUNTY_GAS * 200n * GWEI);
    expect(drawLimitFor(1_000n)).toBe(1_010n);
    expect(drawLimitFor(1_001n)).toBe(1_012n);
    expect(drawLimitFor(10n ** 21n + 1n)).toBe(10n ** 21n + 1n + 10n ** 19n + 1n);
    expect(() => drawLimitFor(0n)).toThrow();
  });

  it('SH-BOX0-DRAW-VALUE: a draw carries exactly the ETH its drawer confirmed (the target’s drawValue), nothing else', () => {
    const value = drawValueFor(GWEI);
    const draw = box0Calls.draw(target, 1_010n, deadline, value);
    expect(() => assertSendableBox0Call(draw, { ...target, drawValue: value }, me)).not.toThrow();
    const wrong: Box0Target[] = [target, { ...target, drawValue: value - 1n }, { ...target, drawValue: value + 1n }, { ...target, drawValue: 0n }];
    for (const t of wrong) expect(() => assertSendableBox0Call(draw, t, me), String(t.drawValue)).toThrow(NotSendableError);
    // Within the cap only, even when confirmed.
    const over = box0Calls.draw(target, 1_010n, deadline, DRAW_VALUE_CAP + 1n);
    expect(() => assertSendableBox0Call(over, { ...target, drawValue: DRAW_VALUE_CAP + 1n }, me)).toThrow(NotSendableError);
  });

  it('opens with an empty reveal only, to the caller', () => {
    expect(EMPTY_REVEAL.proof).toEqual([]);
    const withProof = encodeFunctionData({ abi: boxTicketsAbi, functionName: 'open', args: [7n, { ...EMPTY_REVEAL, proof: [`0x${'11'.repeat(32)}`] }] });
    const toOther = encodeFunctionData({ abi: boxTicketsAbi, functionName: 'openDraw', args: [3n, other, EMPTY_REVEAL] });
    const toMe = encodeFunctionData({ abi: boxTicketsAbi, functionName: 'openDraw', args: [3n, me, EMPTY_REVEAL] });
    expect(() => assertSendableBox0Call({ to: tickets, data: withProof, value: 0n }, target, me)).toThrow(NotSendableError);
    expect(() => assertSendableBox0Call({ to: tickets, data: toOther, value: 0n }, target, me)).toThrow(NotSendableError);
    expect(() => assertSendableBox0Call({ to: tickets, data: toMe, value: 0n }, target, me)).not.toThrow();
  });

  it('refuses every other call, target, spender, recipient, value or noncanonical calldata', () => {
    const draw = box0Calls.draw(target, 1_010n, deadline, drawValueFor(GWEI));
    const claim = box0Calls.claim(target, [4100n], me);
    const bad: { to: `0x${string}`; data: Hex; value: bigint }[] = [
      { ...draw, to: stream },
      { ...draw, value: DRAW_VALUE_CAP + 1n },
      { ...draw, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'draw', args: [0n, deadline] }) },
      { ...claim, value: 1n },
      { ...claim, to: tickets },
      { ...claim, data: `${claim.data}00` as Hex },
      { ...claim, data: '0xdeadbeef' },
      { to: stream, data: encodeFunctionData({ abi: boxItemStreamAbi, functionName: 'claim', args: [[4100n], other] }), value: 0n },
      { to: stream, data: encodeFunctionData({ abi: boxItemStreamAbi, functionName: 'claim', args: [[4100n, 4100n], me] }), value: 0n },
      { to: stream, data: encodeFunctionData({ abi: boxItemStreamAbi, functionName: 'claim', args: [Array.from({ length: MAX_CLAIM_IDS + 1 }, (_, i) => BigInt(i + 1)), me] }), value: 0n },
      { to: stream, data: encodeFunctionData({ abi: boxItemStreamAbi, functionName: 'claimFor', args: [me, [4100n]] }), value: 0n },
      { to: stream, data: encodeFunctionData({ abi: boxItemStreamAbi, functionName: 'burn' }), value: 0n },
      { to: tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'settle', args: [8n] }), value: 0n },
      { to: tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'take', args: [1n, 1n, deadline] }), value: 0n },
      { to: tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'handBack', args: [[1n], 0n, deadline] }), value: 0n },
      { to: tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'transferFrom', args: [me, other, 1n] }), value: 0n },
      { to: tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'setApprovalForAll', args: [service, true] }), value: 0n },
      { to: tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'approve', args: [other, 7n] }), value: 0n },
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [other, 1n] }), value: 0n },
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [tickets, 0n] }), value: 0n },
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [other, 1n] }), value: 0n },
    ];
    for (const call of bad) expect(() => assertSendableBox0Call(call, target, me), call.data.slice(0, 10)).toThrow(NotSendableError);
  });

  it('a claim with no item pays what is already booked', () => {
    expect(() => assertSendableBox0Call(box0Calls.claim(target, [], me), target, me)).not.toThrow();
  });

  it('has no service approval when the build names no service', () => {
    const none: Box0Target = { ...target, service: null };
    expect(() => box0Calls.approveService(none, 7n)).toThrow(NotSendableError);
    const data = encodeFunctionData({ abi: boxTicketsAbi, functionName: 'approve', args: [service, 7n] });
    expect(() => assertSendableBox0Call({ to: tickets, data, value: 0n }, none, me)).toThrow(NotSendableError);
  });

  it('refuses a target whose roles are zero or repeat', () => {
    const call = box0Calls.claim(target, [4100n], me);
    expect(() => assertSendableBox0Call(call, { ...target, tickets: stream }, me)).toThrow(NotSendableError);
    expect(() => assertSendableBox0Call(call, { ...target, service: token }, me)).toThrow(NotSendableError);
    expect(() => assertSendableBox0Call(call, target, '0x0000000000000000000000000000000000000000')).toThrow(NotSendableError);
  });
});
