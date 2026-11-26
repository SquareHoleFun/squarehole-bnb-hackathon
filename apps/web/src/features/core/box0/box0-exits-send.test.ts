/**
 * SH-BOX0-EXITS: the checked sends for the ways out of a stopped draw. Each re-reads the contract's own guard after the
 * click, before the simulation and the one wallet request; a guard that no longer holds stops the send.
 */
import { boxTicketsAbi } from '@squarehole/chain/abi';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAW, PHASE, TAKE_DELAY } from './box0-model';
import { prepareTake, sendBox0, type Box0IO, type Box0Roles } from './box0-send';
import { blockJson, nodeBlock } from './test-support/node-block';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

afterEach(() => {
  vi.unstubAllGlobals();
});

const me = '0x00000000000000000000000000000000000000a1' as Address;
const other = '0x00000000000000000000000000000000000000b2' as Address;
const roles: Box0Roles = {
  chainId: 11155111,
  token: '0x0000000000000000000000000000000000000f17',
  tickets: '0x0000000000000000000000000000000000007777',
  stream: '0x0000000000000000000000000000000000005555',
  vault: '0x0000000000000000000000000000000000003333',
  service: null,
};
const NOW = 1_800_000_000n;
const hash = `0x${'ef'.repeat(32)}` as Hex;

interface Chain {
  phase: number;
  wordAcceptedAt: bigint;
  terminalAt: bigint;
  quote: [bigint, bigint];
  handBack: [bigint, bigint];
  allowance: bigint;
  balance: bigint;
  drawer: Address;
  drawStatus: number;
  owner: Address;
  hidden: boolean;
}

function io(overrides: Partial<Chain> = {}) {
  const c: Chain = {
    phase: PHASE.Terminal,
    wordAcceptedAt: 0n,
    terminalAt: NOW - TAKE_DELAY,
    quote: [1_000n, 10n],
    handBack: [999n, 0n],
    allowance: 0n,
    balance: 10n ** 24n,
    drawer: me,
    drawStatus: DRAW.Requested,
    owner: me,
    hidden: true,
    ...overrides,
  };
  const submit = vi.fn(async () => hash);
  const fake: Box0IO = {
    feeReader: TEST_FEE_READER, chainId: async () => 11155111,
    request: vi.fn(async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0xaa36a7' : [me])) as never,
    read: async (_to, fn) => {
      switch (fn) {
        case 'phase': return c.phase;
        case 'status': return { wordAcceptedAt: c.wordAcceptedAt, terminalAt: c.terminalAt };
        case 'quoteTake': return c.quote;
        case 'quoteHandBack': return c.handBack;
        case 'allowance': return c.allowance;
        case 'balanceOf': return c.balance;
        case 'drawTicket': return { drawer: c.drawer, status: c.drawStatus, requestedAt: 0n, itemId: 0n, revealFallbackAt: 0n };
        case 'ownerOf': return c.owner;
        case 'isHidden': return c.hidden;
        default: throw new Error(`unexpected read ${fn}`);
      }
    },
    block: async () => ({ timestamp: NOW, baseFee: 1_000_000_000n }),
    simulate: vi.fn(async () => undefined),
    estimate: vi.fn(async () => 200_000n),
    receipt: async () => ({ status: 'success', logs: [] }),
    submit: submit as never,
  };
  return { fake, submit };
}

const sentCall = (submit: ReturnType<typeof vi.fn>) => (submit.mock.calls[0] as unknown as [{ call: { to: Address; data: Hex; value: bigint } }])[0].call;
const decoded = (submit: ReturnType<typeof vi.fn>) => decodeFunctionData({ abi: boxTicketsAbi, data: sentCall(submit).data });

describe('SH-BOX0-EXITS sender', () => {
  it('has no stop step: the page never sends enterTerminal (F142), whatever the box is doing', async () => {
    for (const phase of [PHASE.Drawing, PHASE.AwaitingWord, PHASE.Terminal]) {
      const r = io({ phase });
      await expect(sendBox0(roles, me, { kind: 'stop' } as never, r.fake)).rejects.toThrow(/not a box 0 step/i);
      expect(r.fake.simulate).not.toHaveBeenCalled();
      expect(r.submit).not.toHaveBeenCalled();
    }
  });

  it('cancels only the caller’s own draw that is still requested, once draws stopped', async () => {
    const ok = io();
    await sendBox0(roles, me, { kind: 'cancel-draw', ticket: 2n }, ok.fake);
    expect(decoded(ok.submit)).toMatchObject({ functionName: 'cancelDraw', args: [2n] });
    for (const [o, why] of [[{ phase: PHASE.Drawing }, /not stopped/i], [{ drawer: other }, /not your draw/i], [{ drawStatus: DRAW.Settled }, /no FIT to give back/i]] as const) {
      const r = io(o);
      await expect(sendBox0(roles, me, { kind: 'cancel-draw', ticket: 2n }, r.fake)).rejects.toThrow(why);
      expect(r.submit).not.toHaveBeenCalled();
    }
  });

  it('hands back the holder’s placeholder with its floor and a deadline, only in terminal mode before any word', async () => {
    const ok = io();
    await sendBox0(roles, me, { kind: 'hand-back', tokenId: 7n, min: 989n }, ok.fake);
    expect(decoded(ok.submit)).toMatchObject({ functionName: 'handBack', args: [[7n], 989n, NOW + 1_800n] });
    for (const [o, why] of [[{ phase: PHASE.Drawing }, /not stopped/i], [{ wordAcceptedAt: NOW - 1n }, /has a number/i], [{ owner: other }, /not yours/i], [{ handBack: [900n, 0n] as [bigint, bigint] }, /amount moved/i]] as const) {
      const r = io(o);
      await expect(sendBox0(roles, me, { kind: 'hand-back', tokenId: 7n, min: 989n }, r.fake)).rejects.toThrow(why);
      expect(r.submit).not.toHaveBeenCalled();
    }
  });

  it('prepares a take like a draw (quote, 1% limit, approval), and takes the named item with an empty reveal', async () => {
    const plan = io();
    await expect(prepareTake(roles, me, plan.fake)).resolves.toEqual({ quote: 1_010n, limit: 1_021n, needsApproval: true, short: false });
    const ok = io({ allowance: 1_021n });
    await sendBox0(roles, me, { kind: 'take', itemId: 4123n, poolIndex: 5n, limit: 1_021n }, ok.fake);
    expect(decoded(ok.submit)).toMatchObject({ functionName: 'takeByNumber', args: [4123n, 5n, 1_021n, NOW + 1_800n, { proof: [] }] });
    expect(sentCall(ok.submit).value).toBe(0n);
  });

  it('refuses a take before its three days, above the limit, without approval or FIT, or of an item already gone', async () => {
    for (const [o, why] of [
      [{ terminalAt: NOW - TAKE_DELAY + 1n, allowance: 1_021n }, /not yet/i],
      [{ phase: PHASE.Drawing, allowance: 1_021n }, /not stopped/i],
      [{ quote: [1_100n, 11n] as [bigint, bigint], allowance: 1_021n }, /price moved/i],
      [{ allowance: 0n }, /approve/i],
      [{ allowance: 1_021n, balance: 1n }, /not enough/i],
      [{ allowance: 1_021n, hidden: false }, /just taken/i],
    ] as const) {
      const r = io(o);
      await expect(sendBox0(roles, me, { kind: 'take', itemId: 4123n, poolIndex: 5n, limit: 1_021n }, r.fake)).rejects.toThrow(why);
      expect(r.submit).not.toHaveBeenCalled();
    }
  });

  // SH-BOX0-DRAW-VALUE fix round 1: the base fee matters only to a draw. A take or a hand-back reads the block's time alone.
  it('a malformed or missing base fee stops neither a take nor a hand-back (the real block reader)', async () => {
    for (const baseFeePerGas of [' ', true, '0x01', null, undefined]) {
      const read = nodeBlock(() => blockJson(NOW, { baseFeePerGas }));
      const take = io({ allowance: 1_021n });
      await sendBox0(roles, me, { kind: 'take', itemId: 4123n, poolIndex: 5n, limit: 1_021n }, { ...take.fake, block: read });
      expect(decoded(take.submit), `take, base fee ${String(baseFeePerGas)}`).toMatchObject({ functionName: 'takeByNumber', args: [4123n, 5n, 1_021n, NOW + 1_800n, { proof: [] }] });
      const back = io();
      await sendBox0(roles, me, { kind: 'hand-back', tokenId: 7n, min: 989n }, { ...back.fake, block: read });
      expect(decoded(back.submit), `hand-back, base fee ${String(baseFeePerGas)}`).toMatchObject({ functionName: 'handBack', args: [[7n], 989n, NOW + 1_800n] });
    }
  });
});
