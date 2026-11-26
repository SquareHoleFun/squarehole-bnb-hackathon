/**
 * SH-BOX0-EXITS: box 0's panel when draws stall and once they are stopped, through the real component, model and sender.
 * F142 (desk R61-STOP "hide"): before terminal mode the page has no stop and no word about stuck draws; the ways out
 * show only once box 0 is in terminal mode on chain (someone else called `enterTerminal`). Only the chain
 * reads (`read`), the RPC edge (`ioFor`) and the wallet are doubles; `submit` records what the wallet was asked to send.
 */
import { handBackMinFor } from '@squarehole/chain';
import { boxTicketsAbi } from '@squarehole/chain/abi';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { Box0Actions } from './Box0Actions';
import { DRAW, PHASE, TAKE_DELAY } from './box0-model';
import type { Box0Reads } from './box0-reads';
import type { Box0IO, Box0Roles } from './box0-send';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

const me = '0x00000000000000000000000000000000000000a1' as Address;
const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 11155111, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } as { request: ReturnType<typeof vi.fn> } | null }));
vi.mock('../../wallet', async (original) => ({ ...(await original<object>()), useWallet: () => wallet }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
const DAY = 86_400n;
const REFUND = 999_509n * 10n ** 15n; // 999.509 FIT: shown as 999.5
const hash = `0x${'ef'.repeat(32)}` as Hex;
const requested = { id: 2n, drawer: me, status: DRAW.Requested, itemId: 0n, fallbackAt: 0n };

function reads(over: Partial<Box0Reads> = {}): Box0Reads {
  return {
    phase: PHASE.Drawing, wordAcceptedAt: NOW - 10n * DAY, now: NOW, quote: 1_010n * FIT, placeholders: [], draws: [], owed: 0n, items: [], pending: [], held: 0n,
    slots: 4n, wordRequestedAt: NOW - 11n * DAY, terminalAt: 0n, headDead: false, refund: null, take: null,
    ...over,
  };
}

function mount(state: Box0Reads) {
  let allowance = 0n;
  const submit = vi.fn(async (options: { call: { to: Address } }) => {
    if (options.call.to === roles.token) allowance = 10n ** 30n;
    return hash;
  });
  const io: Box0IO = {
    feeReader: TEST_FEE_READER, chainId: async () => 11155111,
    request: (async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0xaa36a7' : [me])) as never,
    read: async (_to, fn) => {
      if (fn === 'phase') return state.phase;
      if (fn === 'status') return { wordAcceptedAt: state.wordAcceptedAt, terminalAt: state.terminalAt };
      if (fn === 'quoteTake') return [1_000n * FIT, 10n * FIT];
      if (fn === 'quoteHandBack') return [REFUND, 0n];
      if (fn === 'allowance') return allowance;
      if (fn === 'balanceOf') return 10n ** 24n;
      if (fn === 'ownerOf') return me;
      if (fn === 'isHidden') return true;
      if (fn === 'drawTicket') return { drawer: me, status: DRAW.Requested, requestedAt: 0n, itemId: 0n, revealFallbackAt: 0n };
      throw new Error(fn);
    },
    block: async () => ({ timestamp: NOW, baseFee: 1_000_000_000n }),
    simulate: async () => undefined,
    estimate: async () => 200_000n,
    receipt: async () => ({ status: 'success', logs: [] }),
    submit: submit as never,
  };
  render(
    <MemoryRouter>
      <AppProviders>
        <Box0Actions roles={roles} rpcUrl="http://127.0.0.1:1" ticker="FIT" noun="Misfit" holdings={{ tickets: [], draws: [], items: [] }} disabled={false} read={async () => state} ioFor={() => io} />
      </AppProviders>
    </MemoryRouter>,
  );
  return { submit };
}

const sent = (submit: ReturnType<typeof vi.fn>, i: number) => (submit.mock.calls[i] as unknown as [{ call: { to: Address; data: Hex; value: bigint } }])[0].call;
const confirmIn = async (name: string | RegExp = 'Confirm') => fireEvent.click(within(await screen.findByRole('group', { name: 'Confirm transaction' })).getByRole('button', { name }));

function connect() {
  wallet.status = 'connected';
  wallet.account = me;
  wallet.signer = { request: vi.fn() };
}

describe('SH-BOX0-EXITS box 0 panel', () => {
  it('a draw and a placeholder behind a dead head: no draw, no stop, no word about it; both still wait (F142)', async () => {
    connect();
    const r = mount(reads({ phase: PHASE.AwaitingWord, wordAcceptedAt: 0n, headDead: true, refund: REFUND, draws: [requested], placeholders: [{ id: 7n, number: 0n, approved: null }] }));
    expect(await screen.findByText('Draw 2 · waiting for its number')).toBeTruthy();
    expect(screen.getByText('Placeholder 7 · waiting for numbers')).toBeTruthy();
    const panel = screen.getByRole('region', { name: 'Draw and claim' });
    expect(within(panel).queryAllByRole('button')).toEqual([]);
    expect(panel.textContent).not.toMatch(/stop|no numbers? came|stuck|deadline|get back|take one/i);
    expect(r.submit).not.toHaveBeenCalled();
  });

  it('a visitor with nothing stuck sees neither the draw nor any stop', async () => {
    connect();
    mount(reads({ headDead: true, owed: 9n * FIT, held: 10n ** 24n }));
    expect(await screen.findByRole('button', { name: 'Claim' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Draw one/ })).toBeNull();
  });

  it('after the stop: the draw’s FIT back, the placeholder handed back with its floor, and a take by number in two steps', async () => {
    connect();
    const r = mount(reads({
      phase: PHASE.Terminal, wordAcceptedAt: 0n, wordRequestedAt: NOW - 11n * DAY, terminalAt: NOW - TAKE_DELAY, refund: REFUND,
      draws: [requested], placeholders: [{ id: 7n, number: 0n, approved: null }], take: { itemId: 4123n, poolIndex: 5n },
    }));
    const drawLine = (await screen.findByText('Draw 2 · draws stopped')).closest('li') as HTMLElement;
    const placeholderLine = screen.getByText('Placeholder 7 · draws stopped').closest('li') as HTMLElement;
    expect(screen.queryByRole('button', { name: /^Draw one/ })).toBeNull();

    fireEvent.click(within(drawLine).getByRole('button', { name: 'Get back · 999.5 FIT' }));
    expect((await screen.findByRole('group', { name: 'Confirm transaction' })).textContent).toContain('Cancel draw 2 and get about 999.5 FIT back?');
    await confirmIn();
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(1));
    expect(decodeFunctionData({ abi: boxTicketsAbi, data: sent(r.submit, 0).data })).toMatchObject({ functionName: 'cancelDraw', args: [2n] });

    fireEvent.click(within(placeholderLine).getByRole('button', { name: 'Get back · 999.5 FIT' }));
    expect((await screen.findByRole('group', { name: 'Confirm transaction' })).textContent).toContain('Hand back placeholder 7 for at least 989.51 FIT?');
    await confirmIn();
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(2));
    expect(decodeFunctionData({ abi: boxTicketsAbi, data: sent(r.submit, 1).data })).toMatchObject({ functionName: 'handBack', args: [[7n], handBackMinFor(REFUND), NOW + 1_800n] });

    fireEvent.click(screen.getByRole('button', { name: 'Take one · 1,010 FIT' }));
    const take = await screen.findByRole('group', { name: 'Confirm transaction' });
    expect(take.textContent).toContain('Up to 1,020.1 FIT');
    expect(take.textContent).toContain('Misfit 4123 · its picture comes later');
    await confirmIn('Approve FIT');
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(3));
    expect(decodeFunctionData({ abi: erc20Abi, data: sent(r.submit, 2).data }).functionName).toBe('approve');
    await confirmIn('Confirm take');
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(4));
    expect(decodeFunctionData({ abi: boxTicketsAbi, data: sent(r.submit, 3).data })).toMatchObject({ functionName: 'takeByNumber', args: [4123n, 5n, 1_020_100n * 10n ** 15n, NOW + 1_800n, { proof: [] }] });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Taken · Misfit 4123'));
  });

  it('before the take opens, says when; with the word stored, a numbered placeholder is not handed back', async () => {
    connect();
    mount(reads({ phase: PHASE.Terminal, terminalAt: NOW - DAY, refund: REFUND, placeholders: [{ id: 7n, number: 77n, approved: null }], take: { itemId: 4123n, poolIndex: 5n } }));
    expect(await screen.findByText('Take one · in 2 d')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Take one/ })).toBeNull();
    const line = screen.getByText(/^Placeholder 7 · Misfit 77/).closest('li') as HTMLElement;
    expect(within(line).queryByRole('button', { name: /Get back/ })).toBeNull();
  });
});
