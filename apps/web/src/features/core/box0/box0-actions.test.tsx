/**
 * SH-BOX0-ACTIONS: box 0's panel through the real component, model and sender. Only the chain reads (`read`), the RPC
 * edge (`ioFor`) and the wallet are doubles; `submit` records what the wallet was asked to send.
 */
import { boxItemStreamAbi, boxTicketsAbi } from '@squarehole/chain/abi';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { BaseError, ExecutionRevertedError, decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { Box0Actions } from './Box0Actions';
import { DRAW, PHASE, REVEAL_GRACE } from './box0-model';
import type { Box0Reads } from './box0-reads';
import type { Box0IO, Box0Roles } from './box0-send';
import { blockJson, nodeBlock } from './test-support/node-block';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

const me = '0x00000000000000000000000000000000000000a1' as Address;
const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 11155111, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } as { request: ReturnType<typeof vi.fn> } | null }));
vi.mock('../../wallet', async (original) => ({ ...(await original<object>()), useWallet: () => wallet }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const roles: Box0Roles = {
  chainId: 11155111,
  token: '0x0000000000000000000000000000000000000f17',
  tickets: '0x0000000000000000000000000000000000007777',
  stream: '0x0000000000000000000000000000000000005555',
  vault: '0x0000000000000000000000000000000000003333',
  service: null,
};
const FIT = 10n ** 18n;
const NOW = 1_800_000_000n;
const hash = `0x${'ef'.repeat(32)}` as Hex;

function reads(over: Partial<Box0Reads> = {}): Box0Reads {
  return { phase: PHASE.Drawing, wordAcceptedAt: NOW - 100n, now: NOW, quote: 1_010n * FIT, placeholders: [], draws: [], owed: 0n, items: [], pending: [], held: 0n, slots: 0n, wordRequestedAt: 0n, terminalAt: 0n, headDead: false, refund: null, take: null, ...over };
}

/** `block`: the latest block the sends read (default: NOW at a base fee of 1 gwei). */
function rig(state: Box0Reads, chain: { allowance?: bigint; simulateError?: Error; block?: Box0IO['block'] } = {}) {
  let allowance = chain.allowance ?? 0n;
  const submit = vi.fn(async (options: { call: { to: Address; data: Hex; value: bigint } }) => {
    if (options.call.to === roles.token) allowance = 10n ** 30n;
    return hash;
  });
  const drawLog = {
    address: roles.tickets,
    topics: encodeEventTopics({ abi: boxTicketsAbi, eventName: 'DrawRequested', args: { ticketId: 12n, drawer: me } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1_000n * FIT, 10n * FIT, 99n, 0n]),
  };
  const io: Box0IO = {
    feeReader: TEST_FEE_READER, chainId: async () => 11155111,
    request: (async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0xaa36a7' : [me])) as never,
    read: async (_to, fn, args) => {
      if (fn === 'phase') return state.phase;
      if (fn === 'status') return { wordAcceptedAt: state.wordAcceptedAt };
      if (fn === 'quoteTake') return [1_000n * FIT, 10n * FIT];
      if (fn === 'allowance') return allowance;
      if (fn === 'balanceOf') return 10n ** 24n;
      if (fn === 'ownerOf') return me;
      if (fn === 'drawTicket') return { drawer: me, status: DRAW.Settled, requestedAt: 0n, itemId: 4101n, revealFallbackAt: args?.[0] === 5n ? NOW : NOW + 10n };
      throw new Error(fn);
    },
    block: chain.block ?? (async () => ({ timestamp: NOW, baseFee: 1_000_000_000n })),
    simulate: async () => {
      if (chain.simulateError) throw chain.simulateError;
    },
    estimate: async () => 200_000n,
    receipt: async () => ({ status: 'success', logs: [drawLog] }),
    submit: submit as never,
  };
  const read = vi.fn(async () => state);
  const ioFor = vi.fn(() => io);
  return { submit, read, ioFor };
}

function mount(state: Box0Reads, options: { disabled?: boolean; allowance?: bigint; simulateError?: Error; block?: Box0IO['block'] } = {}) {
  const r = rig(state, options);
  render(
    <MemoryRouter>
      <AppProviders>
        <Box0Actions roles={roles} rpcUrl="http://127.0.0.1:1" ticker="FIT" noun="Misfit" holdings={{ tickets: [], draws: [], items: [] }} disabled={options.disabled ?? false} read={r.read} ioFor={r.ioFor} />
      </AppProviders>
    </MemoryRouter>,
  );
  return r;
}

/** The call the wallet was asked to send at position `i`. */
function sentAt(submit: ReturnType<typeof rig>['submit'], i: number): { to: Address; data: Hex; value: bigint } {
  const call = submit.mock.calls[i]?.[0]?.call;
  if (!call) throw new Error(`no send ${i}`);
  return call;
}

const fn = (data: Hex, abi: typeof boxTicketsAbi | typeof boxItemStreamAbi | typeof erc20Abi) => decodeFunctionData({ abi, data }).functionName;

describe('SH-BOX0-ACTIONS box 0 panel', () => {
  it('shows nothing before graduation', async () => {
    wallet.status = 'disconnected';
    wallet.account = null;
    const r = mount(reads({ phase: PHASE.Curve }));
    await waitFor(() => expect(r.read).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /draw/i })).toBeNull();
  });

  it('offers a draw with its price; without a wallet the click only opens the wallet dialog', async () => {
    wallet.status = 'disconnected';
    wallet.account = null;
    wallet.signer = null;
    const r = mount(reads());
    const button = await screen.findByRole('button', { name: 'Draw one · 1,010 FIT' });
    fireEvent.click(button);
    expect(r.ioFor).not.toHaveBeenCalled();
    expect(r.submit).not.toHaveBeenCalled();
  });

  it('draws in two steps: the FIT approval up to the limit, then the draw with its round payment', async () => {
    wallet.status = 'connected';
    wallet.account = me;
    wallet.signer = { request: vi.fn() };
    const r = mount(reads());
    fireEvent.click(await screen.findByRole('button', { name: 'Draw one · 1,010 FIT' }));
    const confirm = await screen.findByRole('group', { name: 'Confirm transaction' });
    expect(confirm.textContent).toContain('Up to 1,020.1 FIT');
    // Fix round 1 (F2): DrandWords.payRound gives the whole payment to the round's pot when the wallet refuses the refund.
    expect(within(confirm).getByText('+ up to 0.0018 ETH for the random number, the unused part comes back if your wallet accepts ETH')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve FIT' }));
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(1));
    expect(fn(sentAt(r.submit, 0).data, erc20Abi)).toBe('approve');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm draw' }));
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(2));
    const draw = sentAt(r.submit, 1);
    expect(fn(draw.data, boxTicketsAbi)).toBe('draw');
    expect(draw.value).toBe(600_000n * 3_000_000_000n);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Drawn · waiting for its number'));
  });

  it('lists draws, placeholders and the claim, and sends each action after its confirmation', async () => {
    wallet.status = 'connected';
    wallet.account = me;
    wallet.signer = { request: vi.fn() };
    const r = mount(reads({
      wordAcceptedAt: NOW - REVEAL_GRACE,
      draws: [{ id: 5n, drawer: me, status: DRAW.Settled, itemId: 4101n, fallbackAt: NOW }, { id: 6n, drawer: me, status: DRAW.Requested, itemId: 0n, fallbackAt: 0n }],
      placeholders: [{ id: 7n, number: 77n, approved: null }],
      owed: 0n, items: [4100n], pending: [5n * FIT], held: 10n ** 24n,
    }));
    expect(await screen.findByText('Draw 6 · waiting for its number')).toBeTruthy();
    expect(screen.getByText('Placeholder 7 · Misfit 77')).toBeTruthy();
    expect(screen.getByText('Claimable · 4.99 FIT')).toBeTruthy();
    const drawRow = screen.getByText('Draw 5 · Misfit 4101').closest('li') as HTMLElement;
    fireEvent.click(within(drawRow).getByRole('button', { name: 'Open without picture' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Confirm transaction' })).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(1));
    expect(fn(sentAt(r.submit, 0).data, boxTicketsAbi)).toBe('openDraw');
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Confirm transaction' })).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(2));
    const claim = sentAt(r.submit, 1);
    expect(claim.to).toBe(roles.stream);
    const [ids, to] = decodeFunctionData({ abi: boxItemStreamAbi, data: claim.data }).args as [bigint[], string];
    expect([ids, to.toLowerCase()]).toEqual([[4100n], me]);
  });

  it('disables every action while the box view is stale or unverified', async () => {
    wallet.status = 'connected';
    wallet.account = me;
    const r = mount(reads({ owed: 9n * FIT, held: 10n ** 24n }), { disabled: true });
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Draw one · 1,010 FIT' })).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Claim' }).disabled).toBe(true);
    await act(async () => undefined);
    expect(r.submit).not.toHaveBeenCalled();
  });

  it('shows a refusal from the chain as one plain line, not the library’s message', async () => {
    wallet.status = 'connected';
    wallet.account = me;
    wallet.signer = { request: vi.fn() };
    const refusal = new BaseError('The contract function "openDraw" reverted. Contract Call: address 0x7777', { cause: new ExecutionRevertedError({ message: 'RevealRequired' }) });
    const r = mount(reads({ draws: [{ id: 5n, drawer: me, status: DRAW.Settled, itemId: 4101n, fallbackAt: NOW }] }), { simulateError: refusal });
    const drawRow = (await screen.findByText('Draw 5 · Misfit 4101')).closest('li') as HTMLElement;
    fireEvent.click(within(drawRow).getByRole('button', { name: 'Open without picture' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Confirm transaction' })).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The box refused this now. Nothing was sent.'));
    expect(r.submit).not.toHaveBeenCalled();
  });
});

describe('SH-BOX0-DRAW-VALUE box 0 panel: the draw sends the ETH its confirmation shows', () => {
  const connect = () => {
    wallet.status = 'connected';
    wallet.account = me;
    wallet.signer = { request: vi.fn() };
  };
  const GWEI = 1_000_000_000n;

  // Bug 2: the page showed one amount and the wallet was asked for another, worked out again at sending.
  it('Confirm draw sends exactly the ETH the confirmation shows', async () => {
    connect();
    // 600,000 × (2 × 1.234567891 + 1) gwei = 0.0020814814692 ETH: shown as 0.0021 ETH.
    const r = mount(reads(), { allowance: 10n ** 30n, block: async () => ({ timestamp: NOW, baseFee: 1_234_567_891n }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Draw one · 1,010 FIT' }));
    const confirm = await screen.findByRole('group', { name: 'Confirm transaction' });
    expect(within(confirm).getByText('+ up to 0.0021 ETH for the random number, the unused part comes back if your wallet accepts ETH')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm draw' }));
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(1));
    expect(sentAt(r.submit, 0).value).toBe(2_100_000_000_000_000n);
  });

  it('a fee that needs more sends nothing, shows the new amount and sends it only after a new Confirm draw', async () => {
    connect();
    const fee = { now: 2n * GWEI };
    const r = mount(reads(), { allowance: 10n ** 30n, block: async () => ({ timestamp: NOW, baseFee: fee.now }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Draw one · 1,010 FIT' }));
    const first = await screen.findByRole('group', { name: 'Confirm transaction' });
    expect(first.textContent).toContain('+ up to 0.003 ETH for the random number');
    fee.now = 20n * GWEI;
    fireEvent.click(within(first).getByRole('button', { name: 'Confirm draw' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The network fee rose. Check the new amount and confirm again.'));
    expect(r.submit).not.toHaveBeenCalled();
    const second = screen.getByRole('group', { name: 'Confirm transaction' });
    expect(second.textContent).toContain('+ up to 0.0246 ETH for the random number');
    fireEvent.click(within(second).getByRole('button', { name: 'Confirm draw' }));
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(1));
    expect(sentAt(r.submit, 0).value).toBe(24_600_000_000_000_000n);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Drawn · waiting for its number'));
  });

  // Bug 1: a node without a base fee gave a confirmation priced at a fee of 0 (+ up to 0.0006 ETH). Fix round 1 (F1):
  // so did " " (viem's formatter read it as 0n), and `true` as 1 wei.
  it.each([['absent', undefined], ['" "', ' '], ['true', true]] as const)('with a base fee given as %s there is no confirmation: one plain line, nothing sent', async (_label, baseFeePerGas) => {
    connect();
    const block = nodeBlock(() => blockJson(NOW, { baseFeePerGas }));
    const r = mount(reads(), { allowance: 10n ** 30n, block });
    fireEvent.click(await screen.findByRole('button', { name: 'Draw one · 1,010 FIT' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Network fee unavailable. Try again.'));
    expect(screen.queryByRole('group', { name: 'Confirm transaction' })).toBeNull();
    expect(r.submit).not.toHaveBeenCalled();
  });
});
