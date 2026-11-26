import { drawValueFor } from '@squarehole/chain';
import { boxTicketsAbi } from '@squarehole/chain/abi';
import { NotSendableError, WalletRejectedError, WalletRequestError, submitWrite } from '@squarehole/chain/write';
import { BaseError, ExecutionRevertedError, decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAW, PHASE, REVEAL_GRACE } from './box0-model';
import { box0ErrorText, gasLimitForBox0, prepareDraw, sendBox0, type Box0IO, type Box0Roles } from './box0-send';
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
const GWEI = 1_000_000_000n;
const hash = `0x${'ef'.repeat(32)}` as Hex;

interface Chain {
  phase: number;
  wordAcceptedAt: bigint;
  quote: [bigint, bigint];
  allowance: bigint;
  balance: bigint;
  draw: { drawer: Address; status: number; requestedAt: bigint; itemId: bigint; revealFallbackAt: bigint };
  owner: Address;
  walletChain: string;
  status: 'success' | 'reverted';
  receiptFails?: boolean;
}

function io(overrides: Partial<Chain> = {}) {
  const c: Chain = {
    phase: PHASE.Drawing,
    wordAcceptedAt: NOW - 10n,
    quote: [1_000n, 10n],
    allowance: 0n,
    balance: 10n ** 24n,
    draw: { drawer: me, status: DRAW.Settled, requestedAt: NOW - 100n, itemId: 4101n, revealFallbackAt: NOW + 1n },
    owner: me,
    walletChain: '0xaa36a7',
    status: 'success',
    ...overrides,
  };
  const submit = vi.fn(async () => hash);
  const drawLog = {
    address: roles.tickets,
    topics: encodeEventTopics({ abi: boxTicketsAbi, eventName: 'DrawRequested', args: { ticketId: 12n, drawer: me } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1_000n, 10n, 99n, 0n]),
  };
  const fake: Box0IO = {
    feeReader: TEST_FEE_READER, chainId: async () => 11155111,
    request: vi.fn(async ({ method }: { method: string }) => (method === 'eth_chainId' ? c.walletChain : [me])) as never,
    read: async (_to, fn) => {
      switch (fn) {
        case 'phase': return c.phase;
        case 'status': return { wordAcceptedAt: c.wordAcceptedAt };
        case 'quoteTake': return c.quote;
        case 'allowance': return c.allowance;
        case 'balanceOf': return c.balance;
        case 'drawTicket': return c.draw;
        case 'ownerOf': return c.owner;
        default: throw new Error(`unexpected read ${fn}`);
      }
    },
    block: async () => ({ timestamp: NOW, baseFee: GWEI }),
    simulate: vi.fn(async () => undefined),
    estimate: vi.fn(async () => 200_000n),
    receipt: async () => {
      if (c.receiptFails) throw new BaseError('Timed out while waiting for transaction with hash');
      return { status: c.status, logs: [drawLog] };
    },
    submit: submit as never,
  };
  return { c, fake, submit };
}

const sent = (submit: ReturnType<typeof vi.fn>) => (submit.mock.calls[0] as unknown as [{ call: { to: Address; data: Hex; value: bigint }; gasLimit: bigint; protocol: string }])[0];

describe('SH-BOX0-ACTIONS box 0 sender', () => {
  it('prepares a draw from the chain: quote, 1% limit, the approval it needs and the round payment', async () => {
    const { fake } = io();
    await expect(prepareDraw(roles, me, fake)).resolves.toEqual({ quote: 1_010n, limit: 1_021n, needsApproval: true, short: false, value: drawValueFor(GWEI) });
    const { fake: closed } = io({ phase: PHASE.Terminal });
    await expect(prepareDraw(roles, me, closed)).rejects.toThrow(/not drawing/i);
  });

  it('draws with the checked value and a wide gas margin, and returns the ticket from the receipt', async () => {
    const { fake, submit } = io({ allowance: 1_021n });
    await expect(sendBox0(roles, me, { kind: 'draw', limit: 1_021n, value: drawValueFor(GWEI) }, fake)).resolves.toEqual({ hash, ticketId: 12n });
    const options = sent(submit);
    expect(options.protocol).toBe('core-v1-box0');
    expect(options.call.to).toBe(roles.tickets);
    expect(options.call.value).toBe(drawValueFor(GWEI));
    expect(decodeFunctionData({ abi: boxTicketsAbi, data: options.call.data })).toMatchObject({ functionName: 'draw', args: [1_021n, NOW + 1_800n] });
    expect(options.gasLimit).toBe(500_000n);
  });

  it('refuses a draw whose price moved above the limit, without approval or FIT, before the wallet', async () => {
    for (const [o, why] of [[{ allowance: 1_021n, quote: [1_100n, 11n] as [bigint, bigint] }, /price moved/i], [{ allowance: 0n }, /approve/i], [{ allowance: 1_021n, balance: 1n }, /not enough/i]] as const) {
      const { fake, submit } = io(o);
      await expect(sendBox0(roles, me, { kind: 'draw', limit: 1_021n, value: drawValueFor(GWEI) }, fake)).rejects.toThrow(why);
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it('opens the drawer’s own settled draw only from its fallback time', async () => {
    const early = io();
    await expect(sendBox0(roles, me, { kind: 'open-draw', ticket: 12n }, early.fake)).rejects.toThrow(/not yet/i);
    const notMine = io({ draw: { drawer: other, status: DRAW.Settled, requestedAt: 0n, itemId: 4101n, revealFallbackAt: NOW } });
    await expect(sendBox0(roles, me, { kind: 'open-draw', ticket: 12n }, notMine.fake)).rejects.toThrow(/not your draw/i);
    const ready = io({ draw: { drawer: me, status: DRAW.Settled, requestedAt: 0n, itemId: 4101n, revealFallbackAt: NOW } });
    await sendBox0(roles, me, { kind: 'open-draw', ticket: 12n }, ready.fake);
    expect(decodeFunctionData({ abi: boxTicketsAbi, data: sent(ready.submit).call.data })).toMatchObject({ functionName: 'openDraw' });
  });

  it('opens the holder’s placeholder only from 30 days after the numbers, and approves only a named service after them', async () => {
    const early = io();
    await expect(sendBox0(roles, me, { kind: 'open', tokenId: 7n }, early.fake)).rejects.toThrow(/not yet/i);
    const ready = io({ wordAcceptedAt: NOW - REVEAL_GRACE });
    await sendBox0(roles, me, { kind: 'open', tokenId: 7n }, ready.fake);
    expect(ready.submit).toHaveBeenCalledTimes(1);
    const noService = io();
    await expect(sendBox0(roles, me, { kind: 'approve-service', tokenId: 7n }, noService.fake)).rejects.toThrow(/no reveal service/i);
    const service = '0x000000000000000000000000000000000000c0de' as Address;
    const beforeWord = io({ wordAcceptedAt: 0n });
    await expect(sendBox0({ ...roles, service }, me, { kind: 'approve-service', tokenId: 7n }, beforeWord.fake)).rejects.toThrow(/numbers/i);
    const notMine = io({ owner: other });
    await expect(sendBox0({ ...roles, service }, me, { kind: 'approve-service', tokenId: 7n }, notMine.fake)).rejects.toThrow(/not yours/i);
  });

  it('claims for the caller, and refuses a wrong network and a reverted receipt', async () => {
    const ok = io();
    await sendBox0(roles, me, { kind: 'claim', ids: [4100n] }, ok.fake);
    expect(sent(ok.submit).call.to).toBe(roles.stream);
    const wrong = io({ walletChain: '0x1' });
    await expect(sendBox0(roles, me, { kind: 'claim', ids: [4100n] }, wrong.fake)).rejects.toThrow(/wrong network/i);
    expect(wrong.submit).not.toHaveBeenCalled();
    const reverted = io({ status: 'reverted' });
    await expect(sendBox0(roles, me, { kind: 'claim', ids: [4100n] }, reverted.fake)).rejects.toThrow(/nothing confirmed/i);
  });

  it('keeps a gas margin of at least 300,000 and never passes the 16,777,216 cap', () => {
    expect(gasLimitForBox0(200_000n)).toBe(500_000n);
    expect(gasLimitForBox0(10_000_000n)).toBe(12_000_000n);
    // SH-258 round 3: never clipped; the sender's guard refuses a limit above 16,777,216.
    expect(gasLimitForBox0(16_000_000n)).toBe(19_200_000n);
  });
});

describe('SH-BOX0-ACTIONS review: plain lines and the price check', () => {
  it('turns every failure into one plain line, never a library message', () => {
    expect(box0ErrorText(new NotSendableError('calldata is not a canonical box 0 action'))).toBe('Not sent. Nothing reached your wallet.');
    expect(box0ErrorText(new WalletRejectedError())).toBe('Declined in your wallet. Nothing was sent.');
    const revert = new BaseError('The contract function "openDraw" reverted. Contract Call: address 0x7777 function openDraw(uint256 ticketId, address to, ItemReveal r)', { cause: new ExecutionRevertedError({ message: 'RevealRequired(4101, 1800000000)' }) });
    expect(box0ErrorText(revert)).toBe('The box refused this now. Nothing was sent.');
    expect(box0ErrorText(new BaseError('HTTP request failed. URL: http://127.0.0.1:8545 Request body: {"method":"eth_call"}'))).toBe('Nothing confirmed. Try again.');
    expect(box0ErrorText(new WalletRequestError('Internal JSON-RPC error. {"code":-32603}'))).toBe('Not confirmed. Check your wallet before trying again.');
    expect(box0ErrorText(new Error('Not your draw'))).toBe('Not your draw');
    expect(box0ErrorText('boom')).toBe('Nothing confirmed. Try again.');
  });

  it('after the wallet sent, a failed receipt wait says "sent, not confirmed", so nobody draws twice by mistake', async () => {
    const { fake, submit } = io({ allowance: 1_021n, receiptFails: true });
    const failure = await sendBox0(roles, me, { kind: 'draw', limit: 1_021n, value: drawValueFor(GWEI) }, fake).catch((error: unknown) => error);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(box0ErrorText(failure)).toBe('Sent, but not confirmed. Check your wallet before trying again.');
  });

  it('counts the FIT balance against the price the draw takes, not the 1% limit above it', async () => {
    const exact = io({ allowance: 1_021n, balance: 1_010n });
    await expect(prepareDraw(roles, me, exact.fake)).resolves.toMatchObject({ short: false });
    await sendBox0(roles, me, { kind: 'draw', limit: 1_021n, value: drawValueFor(GWEI) }, exact.fake);
    expect(exact.submit).toHaveBeenCalledTimes(1);
    const below = io({ allowance: 1_021n, balance: 1_009n });
    await expect(prepareDraw(roles, me, below.fake)).resolves.toMatchObject({ short: true });
    await expect(sendBox0(roles, me, { kind: 'draw', limit: 1_021n, value: drawValueFor(GWEI) }, below.fake)).rejects.toThrow(/not enough/i);
    expect(below.submit).not.toHaveBeenCalled();
  });
});

describe('SH-BOX0-DRAW-VALUE box 0 sender: a draw sends exactly the ETH it showed, and no base fee is never 0', () => {
  // Bug 1 (box0-send.ts:87, `block.baseFeePerGas ?? 0n`): a node without a base fee gave a draw priced at a fee of 0.
  it('a block without a valid base fee prepares and sends no draw; an explicit 0 (a local chain) is a fee', async () => {
    let block = blockJson(NOW);
    const read = nodeBlock(() => block);
    const { fake, submit } = io({ allowance: 10n ** 30n });
    const real: Box0IO = { ...fake, block: read };
    for (const bad of [undefined, null, '0xzz']) {
      block = blockJson(NOW, { baseFeePerGas: bad });
      await expect(prepareDraw(roles, me, real), `prepare, base fee ${String(bad)}`).rejects.toThrow('Network fee unavailable. Try again.');
      await expect(sendBox0(roles, me, { kind: 'draw', limit: 1_021n, value: drawValueFor(GWEI) }, real), `send, base fee ${String(bad)}`).rejects.toThrow('Network fee unavailable. Try again.');
    }
    expect(fake.simulate).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    // anvil's --base-fee 0 is a fee: 600,000 × 1 gwei. 2 gwei: 600,000 × 5 gwei.
    block = blockJson(NOW, { baseFeePerGas: '0x0' });
    expect((await prepareDraw(roles, me, real)).value).toBe(600_000n * GWEI);
    block = blockJson(NOW, { baseFeePerGas: '0x77359400' });
    expect((await prepareDraw(roles, me, real)).value).toBe(3_000_000_000_000_000n);
    // Only a draw needs the fee: an open reads the block's time alone, with or without one.
    block = blockJson(NOW);
    const open = io({ draw: { drawer: me, status: DRAW.Settled, requestedAt: 0n, itemId: 4101n, revealFallbackAt: NOW } });
    await sendBox0(roles, me, { kind: 'open-draw', ticket: 12n }, { ...open.fake, block: read });
    expect(open.submit).toHaveBeenCalledTimes(1);
  });

  // Bug 2 (box0-send.ts:229): the draw's ETH was drawValueFor(the base fee at sending), not the amount confirmed.
  it('the plan’s ETH is the amount the page shows: rounded up to 0.0001 ETH, never below the round’s basis nor above the cap', async () => {
    const fee = { now: 1_234_567_891n };
    const { fake } = io({ allowance: 10n ** 30n });
    const live: Box0IO = { ...fake, block: async () => ({ timestamp: NOW, baseFee: fee.now }) };
    // 600,000 × (2 × 1.234567891 + 1) gwei = 0.0020814814692 ETH; the page shows four decimals: 0.0021 ETH.
    expect(drawValueFor(fee.now)).toBe(2_081_481_469_200_000n);
    expect((await prepareDraw(roles, me, live)).value).toBe(2_100_000_000_000_000n);
    const cases = [[0n, 600_000_000_000_000n], [1n, 700_000_000_000_000n], [GWEI, 1_800_000_000_000_000n], [99_499_999_999n, 120_000_000_000_000_000n]] as const;
    for (const [baseFee, shown] of cases) {
      fee.now = baseFee;
      expect((await prepareDraw(roles, me, live)).value, `base fee ${baseFee}`).toBe(shown);
    }
  });

  it('the draw sends exactly the confirmed ETH, in the call and in the guard’s target, also when less is needed at sending', async () => {
    const fee = { now: 1_234_567_891n };
    const { fake } = io({ allowance: 10n ** 30n });
    const asked: bigint[] = [];
    const targets: unknown[] = [];
    const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_accounts') return [me];
      if (method !== 'eth_sendTransaction') throw new Error(method);
      asked.push(BigInt((params as [{ value: Hex }])[0].value));
      return hash;
    });
    const live: Box0IO = {
      ...fake,
      request: request as never,
      block: async () => ({ timestamp: NOW, baseFee: fee.now }),
      // The real sender's guard (`submitWrite`) runs, then the wallet double answers.
      submit: ((options: Parameters<typeof submitWrite>[0]) => {
        targets.push((options as { target?: { drawValue?: unknown } }).target?.drawValue);
        return submitWrite(options);
      }) as typeof submitWrite,
    };
    const plan = await prepareDraw(roles, me, live);
    fee.now = GWEI; // 0.0018 ETH would do now: the confirmed amount is still the one sent, the rest comes back
    await sendBox0(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, live);
    expect(asked).toEqual([plan.value]);
    expect(targets).toEqual([plan.value]);
  });

  it('a fee that needs more than the confirmed ETH sends nothing; prepared again, the new amount is the one sent', async () => {
    const fee = { now: 2n * GWEI };
    const { fake, submit } = io({ allowance: 10n ** 30n });
    const live: Box0IO = { ...fake, block: async () => ({ timestamp: NOW, baseFee: fee.now }) };
    const plan = await prepareDraw(roles, me, live);
    expect(plan.value).toBe(3_000_000_000_000_000n); // 600,000 × 5 gwei: 0.003 ETH shown and confirmed
    fee.now = 20n * GWEI; // 600,000 × 41 gwei = 0.0246 ETH needed now
    await expect(sendBox0(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, live)).rejects.toThrow('The network fee rose. Check the new amount and confirm again.');
    expect(fake.simulate).not.toHaveBeenCalled();
    expect(fake.estimate).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    const again = await prepareDraw(roles, me, live);
    expect(again.value).toBe(24_600_000_000_000_000n);
    await sendBox0(roles, me, { kind: 'draw', limit: again.limit, value: again.value }, live);
    expect(sent(submit).call.value).toBe(again.value);
  });
});

/**
 * Fix round 1 (XR-SH-BOX0-DRAW-VALUE F1): base fees a node may send that are not a JSON-RPC quantity in its canonical
 * form ("0x0", or "0x" and lowercase hex digits without a leading zero). viem's block formatter turned the first
 * eight into numbers (`true` → 1n, " " → 0n, the JSON number as it is, "0x01", " 0x1", "0x1 " → 1n, "0X1" → 1n, "0xA" → 10n).
 */
const MALFORMED_FEES: readonly (readonly [string, unknown])[] = [
  ['true', true], ['" "', ' '], ['the JSON number 1000000000', 1_000_000_000], ['"0x01"', '0x01'], ['" 0x1"', ' 0x1'], ['"0x1 "', '0x1 '],
  ['"0X1"', '0X1'], ['"0xA"', '0xA'], ['"0x"', '0x'], ['"-0x1"', '-0x1'], ['"0xzz"', '0xzz'], ['null', null], ['absent', undefined],
];

describe('SH-BOX0-DRAW-VALUE fix round 1 (XR-SH-BOX0-DRAW-VALUE F1): only a canonical base fee prices a draw', () => {
  /** The real block reader and the real `submitWrite`; the wallet double records every send it is asked for. */
  function rigged(baseFeePerGas: unknown, overrides: Partial<Chain> = {}) {
    const read = nodeBlock(() => blockJson(NOW, { baseFeePerGas }));
    const { fake } = io({ allowance: 10n ** 30n, ...overrides });
    const asked: bigint[] = [];
    const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_accounts') return [me];
      if (method !== 'eth_sendTransaction') throw new Error(method);
      asked.push(BigInt((params as [{ value: Hex }])[0].value));
      return hash;
    });
    const real: Box0IO = { ...fake, request: request as never, block: read, submit: submitWrite };
    return { real, asked, fake };
  }

  it.each(MALFORMED_FEES)('a base fee given as %s prepares no draw, and a confirmed draw never reaches the wallet', async (_label, baseFeePerGas) => {
    const { real, asked, fake } = rigged(baseFeePerGas);
    await expect(prepareDraw(roles, me, real)).rejects.toThrow('Network fee unavailable. Try again.');
    await expect(sendBox0(roles, me, { kind: 'draw', limit: 1_021n, value: 1_800_000_000_000_000n }, real)).rejects.toThrow('Network fee unavailable. Try again.');
    expect(fake.simulate).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('controls: 0x0 (a local chain) and a normal fee prepare the draw, and exactly the confirmed amount reaches the wallet', async () => {
    for (const [baseFeePerGas, value] of [['0x0', 600_000_000_000_000n], ['0x77359400', 3_000_000_000_000_000n]] as const) {
      const { real, asked } = rigged(baseFeePerGas);
      const plan = await prepareDraw(roles, me, real);
      expect(plan.value, baseFeePerGas).toBe(value);
      await sendBox0(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, real);
      expect(asked, baseFeePerGas).toEqual([value]);
    }
  });

  it('a malformed base fee does not stop the steps that need only the block’s time (opening a draw or a placeholder)', async () => {
    for (const baseFeePerGas of [' ', true, '0x01', null]) {
      const draw = rigged(baseFeePerGas, { draw: { drawer: me, status: DRAW.Settled, requestedAt: 0n, itemId: 4101n, revealFallbackAt: NOW } });
      await sendBox0(roles, me, { kind: 'open-draw', ticket: 12n }, draw.real);
      expect(draw.asked, `open-draw, base fee ${String(baseFeePerGas)}`).toEqual([0n]);
      const placeholder = rigged(baseFeePerGas, { wordAcceptedAt: NOW - REVEAL_GRACE });
      await sendBox0(roles, me, { kind: 'open', tokenId: 7n }, placeholder.real);
      expect(placeholder.asked, `open, base fee ${String(baseFeePerGas)}`).toEqual([0n]);
    }
  });

  it('a block time that is not a canonical quantity stops every step with one plain line; nothing is sent', async () => {
    for (const timestamp of [true, ' ', 1_800_000_000, '0x06b49d200', null, undefined]) {
      const open = rigged('0x0', { draw: { drawer: me, status: DRAW.Settled, requestedAt: 0n, itemId: 4101n, revealFallbackAt: 0n } });
      const draw = rigged('0x0');
      // Stubbed last: every reader now gets this block (the `fetch` behind them is global).
      const read = nodeBlock(() => blockJson(NOW, { baseFeePerGas: '0x0', timestamp }));
      const failure = await sendBox0(roles, me, { kind: 'open-draw', ticket: 12n }, { ...open.real, block: read }).catch((error: unknown) => error);
      expect(box0ErrorText(failure), `open-draw, time ${String(timestamp)}`).toBe('Nothing confirmed. Try again.');
      await expect(prepareDraw(roles, me, { ...draw.real, block: read }), `prepare, time ${String(timestamp)}`).rejects.toThrow('Nothing confirmed. Try again.');
      expect([...open.asked, ...draw.asked]).toEqual([]);
    }
  });
});
