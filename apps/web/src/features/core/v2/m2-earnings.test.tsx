/**
 * The holder fee share panel (M2-53 finished by FE1; F127 claim-only): one row and one Claim button per payout (Claim
 * all moved to the page's "Your claims" panel, F128: claim-all-panel.test.tsx), the OC-01 pager, and the claim-state rule of holder-claims.ts through the real panel, query cache and
 * shared claim action. Only the RPC/wallet edge (holderActionIO) is a double.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, encodeFunctionResult, type Abi, type Address, type Hex } from 'viem';
import { AppProviders } from '../../../app-providers';
import { InsufficientGasFundsError, NotSendableError, submitWrite } from '@squarehole/chain/write';
import { coordinatorV2Abi, holderLedgerV2Abi, hookV2Abi, receiverV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { readHolderClaimV2 } from '../../../../../../packages/indexer/src/core/v2/m2-reads-v2';
import { m2Fixture } from '../../../../../../packages/indexer/src/core/v2/m2-fixture.test-support';
import * as actions from './actions-v2';
import { HolderEarningsV2 } from './HolderEarningsV2';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { publishedM2, A, B, H } from './test-support/m2-published';
import { required } from './test-support/required';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

const wallet = vi.hoisted(() => ({ account: '', status: 'connected', chainId: 31337, kind: 'injected', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async original => ({ ...await original<object>(), useWallet: () => wallet }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function rig(options: { batches?: readonly string[]; decimals?: number; patch?: Partial<actions.HolderClaimV2> } = {}) {
  const { batches = ['1'], decimals = 6 } = options;
  wallet.account = A; wallet.chainId = 31337; wallet.status = 'connected'; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x7a69' : [wallet.account]);
  const { body, source } = await publishedM2(true); const parsed = parseSnapshotV2(body, source);
  const history = required(parsed.m2?.history); const recorded = required(history.batches['1']);
  let view: V2Snapshot = { ...parsed, decimals, m2: { money: parsed.m2?.money ?? null, history: { ...history, batches: Object.fromEntries(batches.map((id) => [id, recorded])) } } };
  /** The chain as the reads see it: each batch's credit, an outage switch, and gates that hold reads of one block. */
  const chain = { credit: new Map(batches.map((id) => [BigInt(id), 60000001n])), patch: options.patch ?? {}, offline: false, gates: new Map<bigint, Promise<void>>(), head: view.block + 2n };
  const reads: bigint[] = [];
  let sent = 0;
  const submit = vi.fn<(request: unknown) => Promise<Hex>>(async () => H(80 + ++sent));
  const ioFor = (v: V2Snapshot) => ({
    feeReader: TEST_FEE_READER, chainId: async () => source.manifest.chainId, request: wallet.signer.request,
    claim: async (batch: bigint, holder: string): Promise<actions.HolderClaimV2> => {
      // The answer is fixed when the read starts; a gate only delays its arrival.
      reads.push(v.block); const offline = chain.offline; const claimableP = chain.credit.get(batch) ?? 0n; const patch = chain.patch;
      await chain.gates.get(v.block);
      if (offline) throw new Error('RPC offline');
      return { hash: v.blockHash, batchId: batch, holder: holder as typeof A, status: 'settled', hookClosed: true, fundingFinal: true, fundingP: 100000000n, complete: true,
        holderCursor: 3n, noticeCursor: 0n, residueP: 20000000n, claimableP, failedBox: true, payout: claimableP > 0n ? 'available' : 'empty', ...patch };
    },
    simulate: vi.fn(async () => undefined), estimate: async () => 100000n, submit,
    receipt: async (hash: Hex) => ({ transactionHash: hash, blockNumber: chain.head, blockHash: H(99), status: 'success' as const }),
  });
  vi.spyOn(actions, 'holderActionIO').mockImplementation((_source, v) => ioFor(v) as unknown as actions.HolderActionIO);
  let panelKey = 0;
  const tree = () => <AppProviders><MemoryRouter><HolderEarningsV2 key={panelKey} view={view} source={source} symbol="USDC" disabled={false} /></MemoryRouter></AppProviders>;
  const rendered = render(tree());
  await waitFor(() => expect(reads.length).toBeGreaterThan(0));
  return {
    chain, reads, submit, view: () => view,
    rerender: () => rendered.rerender(tree()),
    remount: () => { panelKey++; rendered.rerender(tree()); },
    /** The feed serves another snapshot; only its block number matters to the rule. */
    advance: (block: bigint, hash: Hex = H(Number(block))) => { view = { ...view, block, blockHash: hash }; rendered.rerender(tree()); },
  };
}
const panel = () => screen.getByRole('region', { name: 'Holder fee share' });
const row = (batch: number) => required(within(panel()).getByText(`Batch ${batch}`).closest('li'));
const claimButton = (batch: number) => screen.queryByRole('button', { name: `Claim batch ${batch}` });
async function claim(batch: number) {
  fireEvent.click(required(claimButton(batch)));
  fireEvent.click(within(screen.getByRole('group', { name: 'Confirm claim' })).getByRole('button', { name: 'Confirm' }));
}
async function refreshFails(r: Awaited<ReturnType<typeof rig>>) {
  r.chain.offline = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('button', { name: 'Read failed. Retry' })).toBeTruthy();
}

it.each([[6, '60.000001'], [8, '0.60000001'], [18, '0.000000000060000001']] as const)('M253-CREDIT: exact %i-decimal P per payout, read without the wallet', async (decimals, expected) => {
  await rig({ decimals });
  expect(await within(panel()).findByText('1 ready')).toBeTruthy();
  expect(within(row(1)).getByText(`${expected} USDC`)).toBeTruthy();
  expect(within(panel()).getAllByText(`${expected} USDC`)).toHaveLength(2);
  expect(within(row(1)).getByText('Ready')).toBeTruthy();
  expect(wallet.signer.request).not.toHaveBeenCalled();
});

it.each([
  ['open', 'not_ready', null, 'Open'], ['awaiting_funding', 'not_ready', null, 'Awaiting funding'], ['settling', 'not_ready', null, 'Calculating'],
  ['settled', 'unavailable', 60000001n, 'Paused'], ['settled', 'unverified', 60000001n, 'Not checked'],
] as const)('M253-STATES: %s / %s shows %s and no Claim button', async (status, payout, claimableP, label) => {
  await rig({ patch: { status, payout, claimableP } });
  expect(await within(row(1)).findByText(label)).toBeTruthy();
  expect(claimButton(1)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Claim all' })).toBeNull();
  if (claimableP === null) expect(within(row(1)).getByText('—')).toBeTruthy();
});

/** SH-279: the real ledger reader over controlled chain answers for one batch paid in the price coin. */
async function chainRead(answers: { closed: boolean; paidP: bigint; complete: boolean }) {
  const f = m2Fixture(); const abi: Abi = [...hookV2Abi, ...receiverV2Abi, ...holderLedgerV2Abi, ...coordinatorV2Abi];
  const values: Record<string, unknown> = { tradeBatch: { tradeUnits: 0n, protocolUnits: 0n, netP: 150n, closed: true }, holderBatchClosed: answers.closed,
    holderBatchPaid: answers.paidP, batchState: [answers.complete, 0n, 0n, 0n], claimable: 0n, failed: false };
  const reader = { callAt: async (_to: Address, data: Hex) => {
    const { functionName } = decodeFunctionData({ abi, data });
    return encodeFunctionResult({ abi, functionName, result: values[functionName] as never });
  } };
  return actions.holderCreditOf(await readHolderClaimV2(reader, f.row, { batchId: 1n, holder: A }, H(101)));
}

it.each([
  ['final and zero (an empty batch nobody completes)', { closed: true, paidP: 0n, complete: false }, null],
  ['final, above zero, not complete', { closed: true, paidP: 40n, complete: false }, 'Calculating'],
  ['not final', { closed: false, paidP: 0n, complete: false }, 'Awaiting funding'],
] as const)('SH-279: a batch whose funding is %s', async (_case, answers, label) => {
  const read = await chainRead(answers);
  await rig({ patch: { status: read.status, payout: read.payout, claimableP: read.claimableP, fundingFinal: read.fundingFinal, fundingP: read.fundingP, complete: read.complete } });
  if (label === null) {
    expect(await within(panel()).findByText('Nothing to claim')).toBeTruthy();
    expect(within(panel()).queryByText('Batch 1')).toBeNull();
    expect(within(panel()).queryByText('Calculating')).toBeNull();
  } else {
    expect(await within(row(1)).findByText(label)).toBeTruthy();
    expect(claimButton(1)).toBeNull();
  }
});

it('M253-STATES: a settled zero is no row and “Nothing to claim”, not a dash', async () => {
  await rig({ patch: { claimableP: 0n, payout: 'empty' } });
  expect(await within(panel()).findByText('Nothing to claim')).toBeTruthy();
  expect(within(panel()).queryByText('Batch 1')).toBeNull();
  expect(within(panel()).getByText('0 USDC')).toBeTruthy();
});

it('M253-RETRY: a paused payout can be refreshed into a ready one', async () => {
  const r = await rig({ patch: { payout: 'unavailable' } });
  expect(await within(row(1)).findByText('Paused')).toBeTruthy();
  r.chain.patch = {};
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await within(row(1)).findByText('Ready')).toBeTruthy();
  expect(claimButton(1)).toBeTruthy();
});

it('M253-WALLET: another account and back drops the open confirmation', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  fireEvent.click(required(claimButton(1)));
  expect(screen.getByRole('group', { name: 'Confirm claim' }).textContent).toContain(A);
  wallet.account = B; await act(async () => r.rerender());
  wallet.account = A; await act(async () => r.rerender());
  expect(screen.queryByRole('group', { name: 'Confirm claim' })).toBeNull();
});

it('F127: one claim per payout, to the caller, through the shared action; no wallet request before the click', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  expect(wallet.signer.request).not.toHaveBeenCalled();
  await claim(1);
  await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(1));
  expect(r.submit.mock.calls[0]?.[0]).toMatchObject({ from: A, call: { value: 0n } });
});

it('FE1 (a): mined while the feed still serves an older block, the payout shows Claimed and no Claim button', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  await claim(1);
  expect(await within(row(1)).findByText('Claimed')).toBeTruthy();
  expect(row(1).getAttribute('data-state')).toBe('claimed');
  expect(within(panel()).queryByText('Ready')).toBeNull();
  expect(claimButton(1)).toBeNull();
  // The old snapshot is read again and still shows the credit: nothing changes.
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(r.reads.filter((block) => block === r.view().block).length).toBeGreaterThan(2));
  expect(within(row(1)).getByText('Claimed')).toBeTruthy(); expect(claimButton(1)).toBeNull();
  expect(within(panel()).getByText('None ready')).toBeTruthy();
});

it('FE1: a read at the receipt block showing the credit gone keeps Claimed', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  await claim(1); await within(row(1)).findByText('Claimed');
  r.chain.credit.set(1n, 0n);
  await act(async () => r.advance(r.chain.head));
  await waitFor(() => expect(r.reads).toContain(r.chain.head));
  expect(within(row(1)).getByText('Claimed')).toBeTruthy(); expect(claimButton(1)).toBeNull();
  expect(within(panel()).queryByText('Not confirmed, claim again')).toBeNull();
});

it('FE1: a read at or after the receipt block still showing the credit brings back the amount, Claim and one note', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  await claim(1); await within(row(1)).findByText('Claimed');
  await act(async () => r.advance(r.chain.head + 1n));
  expect(await within(row(1)).findByText('Not confirmed, claim again')).toBeTruthy();
  expect(within(row(1)).getByText('60.000001 USDC')).toBeTruthy();
  expect((required(claimButton(1)) as HTMLButtonElement).disabled).toBe(false);
  expect(within(panel()).getAllByText('Not confirmed, claim again')).toHaveLength(1);
});

it('FE1 (b): after a proven reorg, a failed read keeps the unpaid amount, Claim and the note, and adds a retry chip', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  await claim(1); await within(row(1)).findByText('Claimed');
  await act(async () => r.advance(r.chain.head + 1n));
  await within(row(1)).findByText('Not confirmed, claim again');
  await refreshFails(r);
  expect(within(row(1)).getByText('Not confirmed, claim again')).toBeTruthy();
  expect(within(row(1)).getByText('60.000001 USDC')).toBeTruthy();
  expect(claimButton(1)).toBeTruthy();
  expect(within(panel()).queryByText('Claimed')).toBeNull();
  // A failed read of a newer snapshot changes nothing either.
  await act(async () => r.advance(r.chain.head + 5n));
  await waitFor(() => expect(r.reads).toContain(r.chain.head + 5n));
  expect(within(row(1)).getByText('Not confirmed, claim again')).toBeTruthy();
  r.chain.offline = false;
  fireEvent.click(screen.getByRole('button', { name: 'Read failed. Retry' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Read failed. Retry' })).toBeNull());
});

it('FE1 (b): a failed read never flips Claimed back either; it only shows the retry chip', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  await claim(1); await within(row(1)).findByText('Claimed');
  await refreshFails(r);
  expect(within(row(1)).getByText('Claimed')).toBeTruthy(); expect(claimButton(1)).toBeNull();
});

it('FE1 (c): an older check finishing after a newer one cannot overwrite the reorg proof', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  await claim(1); await within(row(1)).findByText('Claimed');
  const older = r.chain.head; const newer = r.chain.head + 3n; const held = gate();
  r.chain.gates.set(older, held.promise);
  r.chain.credit.set(1n, 0n);
  await act(async () => r.advance(older));
  await waitFor(() => expect(r.reads).toContain(older));
  // The newer snapshot answers first and still shows the credit: reorged out.
  r.chain.credit.set(1n, 60000001n);
  await act(async () => r.advance(newer));
  expect(await within(row(1)).findByText('Not confirmed, claim again')).toBeTruthy();
  // The older check (credit gone) lands last and is ignored: its block is lower.
  await act(async () => { held.open(); await held.promise; });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(within(row(1)).getByText('Not confirmed, claim again')).toBeTruthy();
  expect(claimButton(1)).toBeTruthy();
});

it('FE1: claiming again after the reorg starts over from the new receipt', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  await claim(1); await within(row(1)).findByText('Claimed');
  await act(async () => r.advance(r.chain.head + 1n));
  await within(row(1)).findByText('Not confirmed, claim again');
  r.chain.head += 4n;
  await claim(1);
  expect(await within(row(1)).findByText('Claimed')).toBeTruthy();
  expect(r.submit).toHaveBeenCalledTimes(2);
});

it('FE1: Claimed survives a panel remount for the session', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  await claim(1); await within(row(1)).findByText('Claimed');
  await act(async () => r.remount());
  expect(await within(row(1)).findByText('Claimed')).toBeTruthy(); expect(claimButton(1)).toBeNull();
});

it('FE1: a reverted receipt confirms nothing and keeps the Claim button', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  vi.mocked(actions.holderActionIO).mockImplementationOnce(() => ({
    ...actions.holderActionIO(undefined as never, r.view(), wallet.signer.request),
    receipt: async (hash: Hex) => ({ transactionHash: hash, blockNumber: r.chain.head, blockHash: H(99), status: 'reverted' as const }),
  }));
  await claim(1);
  expect(await within(panel()).findByText('Batch 1 not confirmed. Refresh, then try again.')).toBeTruthy();
  expect(within(row(1)).getByText('Ready')).toBeTruthy(); expect(claimButton(1)).toBeTruthy();
});

it('M253-INTEGRATION: the shared sender admits the holder claim, so the wallet is asked to send it and the payout shows Claimed', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_sendTransaction' ? H(90) : [wallet.account]);
  r.submit.mockImplementationOnce(submitWrite as never);
  await claim(1);
  expect(await within(row(1)).findByText('Claimed')).toBeTruthy();
  const sends = wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: [{ to: string; data: Hex; from: string }] }).filter((call) => call.method === 'eth_sendTransaction');
  expect(sends).toHaveLength(1);
  expect(sends[0]?.params?.[0].to).toBe(r.view().claimRow?.contracts.holderLedger);
  expect(sends[0]?.params?.[0].from).toBe(A);
  expect(decodeFunctionData({ abi: holderLedgerV2Abi, data: required(sends[0]?.params?.[0].data) })).toMatchObject({ functionName: 'claim', args: [1n, A] });
  expect(claimButton(1)).toBeNull();
});

it('M253-INTEGRATION: a guard refusal sends nothing, and the note says nothing reached the wallet', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  r.submit.mockImplementationOnce(async () => { throw new NotSendableError('holder claim must name a batch and pay the caller'); });
  await claim(1);
  expect(await within(panel()).findByText('Batch 1 not sent. Nothing reached your wallet.')).toBeTruthy();
  expect(wallet.signer.request.mock.calls.map(([call]) => (call as { method: string }).method)).not.toContain('eth_sendTransaction');
  expect(within(row(1)).getByText('Ready')).toBeTruthy();
  expect(within(panel()).queryByText(/cannot send/)).toBeNull();
});

const thirteen = Array.from({ length: 13 }, (_, i) => String(i + 1));

it('OC-01: thirteen unpaid batches read twelve per page; More batches reads the rest and every row stays', async () => {
  const r = await rig({ batches: thirteen });
  expect(await within(panel()).findByText('12 ready')).toBeTruthy();
  expect(within(panel()).queryByText('Batch 1')).toBeNull();
  expect(new Set(r.reads).size).toBe(1); expect(r.reads).toHaveLength(12);
  fireEvent.click(screen.getByRole('button', { name: 'More batches, page 2 of 2' }));
  expect(await within(row(1)).findByText('Ready')).toBeTruthy();
  expect(within(panel()).getByText('13 ready')).toBeTruthy();
  expect(row(13)).toBeTruthy();
  expect(r.reads).toHaveLength(13);
});

it('OC-01: a batch typed in Details is read at once, whatever the backlog', async () => {
  const r = await rig({ batches: thirteen });
  await within(panel()).findByText('12 ready');
  fireEvent.change(screen.getByLabelText('Check a batch'), { target: { value: '1' } });
  expect(await within(row(1)).findByText('Ready')).toBeTruthy();
  expect(r.reads.length).toBeLessThanOrEqual(12 + 12);
});

it('M253-WALLET: a demo wallet or another network cannot claim', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  wallet.chainId = 1; await act(async () => r.rerender());
  expect((required(claimButton(1)) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Use a browser wallet on this box’s network.')).toBeTruthy();
  wallet.chainId = 31337; wallet.kind = 'demo'; await act(async () => r.rerender());
  expect((required(claimButton(1)) as HTMLButtonElement).disabled).toBe(true);
});

it('SH-SEND-FEES: a wallet short of gas: the note says not sent and the gas line, and nothing reaches the wallet', async () => {
  const r = await rig(); await within(panel()).findByText('1 ready');
  r.submit.mockImplementationOnce(async () => { throw new InsufficientGasFundsError(2n, 1n, 11_155_111); });
  await claim(1);
  expect(await within(panel()).findByText('Batch 1 not sent. Needs a little more SepETH for gas.')).toBeTruthy();
  expect(wallet.signer.request.mock.calls.map(([call]) => (call as { method: string }).method)).not.toContain('eth_sendTransaction');
});
