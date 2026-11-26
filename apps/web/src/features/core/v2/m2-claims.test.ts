import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem';
import { expect, it, vi } from 'vitest';
import { holderLedgerV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { submitWrite } from '@squarehole/chain/write';
import * as actions from './actions-v2';
import { parseSnapshotV2 } from './indexer-v2';
import type { WriteTargetV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { publishedM2, A, B, H } from './test-support/m2-published';
import { required } from './test-support/required';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

type Target = WriteTargetV2;
const claimData = (batch: bigint, to: Address): Hex => encodeFunctionData({ abi: holderLedgerV2Abi, functionName: 'claim', args: [batch, to] });

async function rig() {
  const { body, source, row } = await publishedM2(true); const view = parseSnapshotV2(body, source);
  const credit = { hash: view.blockHash, batchId: 1n, holder: A, status: 'settled', payout: 'available', claimableP: 60000000n, failedBox: true };
  const io = { feeReader: TEST_FEE_READER, chainId: async (): Promise<number> => source.manifest.chainId, request: vi.fn(async ({ method }: { method: string }) => method === 'eth_chainId' ? `0x${source.manifest.chainId.toString(16)}` : [A]),
    claim: vi.fn(async () => credit), simulate: vi.fn(async () => {}), estimate: async () => 200000n,
    receipt: vi.fn(async () => ({ transactionHash: H(77), blockNumber: view.block + 2n, blockHash: H(79), status: 'success' })), submit: vi.fn(async () => H(77)) };
  return { source, row, view, credit, io };
}
const send = async (...args: unknown[]) => {
  const fn = (actions as unknown as Record<string, (...args: unknown[]) => Promise<actions.HolderReceiptV2>>).sendHolderClaimV2;
  expect(fn, 'M253 holder action').toBeTypeOf('function');
  return fn?.(...args);
};
it('M253-CLAIM: self-claims the named batch in P after failure, without a T approval or tip', async () => {
  const { source, row, view, io } = await rig();
  const confirmed = await send(source, view, A, 1n, 60000000n, io);
  expect(confirmed).toEqual({ transactionHash: H(77), blockNumber: view.block + 2n, blockHash: H(79), status: 'success' });
  expect(io.claim).toHaveBeenCalledWith(1n, A);
  const submitted = io.submit.mock.calls[0] as unknown as [ { call: { to: Address; data: Hex; value: bigint }; target: { holderLedger: Address }; from: Address } ];
  expect(submitted[0].target.holderLedger).toBe(row.contracts.holderLedger);
  expect(submitted[0].call.to).toBe(row.contracts.holderLedger);
  expect(submitted[0].from).toBe(A); expect(submitted[0].call.value).toBe(0n);
  expect(decodeFunctionData({ abi: holderLedgerV2Abi, data: submitted[0].call.data })).toMatchObject({ functionName: 'claim', args: [1n, A] });
  expect(io.receipt).toHaveBeenCalledWith(H(77));
});
it.each(['paused', 'pending', 'zero', 'credit-changed', 'hash', 'holder', 'batch', 'stale', 'unverified', 'wrong-chain', 'wallet-changed', 'simulation', 'receipt'])('M253-CLAIM: %s never confirms a payout', async mode => {
  const r = await rig();
  if (mode === 'paused') r.credit.payout = 'unavailable';
  if (mode === 'pending') r.credit.status = 'settling';
  if (mode === 'zero') r.credit.claimableP = 0n;
  if (mode === 'credit-changed') r.credit.claimableP = 59n;
  if (mode === 'hash') r.credit.hash = H(9);
  if (mode === 'holder') r.credit.holder = B;
  if (mode === 'batch') r.credit.batchId = 2n;
  if (mode === 'stale') r.view = { ...r.view, stale: true };
  if (mode === 'unverified') r.view = { ...r.view, verified: false };
  if (mode === 'wrong-chain') r.io.chainId = async () => 1;
  if (mode === 'wallet-changed') r.io.request.mockImplementation(async ({ method }) => method === 'eth_chainId' ? `0x${r.source.manifest.chainId.toString(16)}` : [B]);
  if (mode === 'simulation') r.io.simulate.mockRejectedValue(new Error('P paused'));
  if (mode === 'receipt') r.io.receipt.mockResolvedValue({ transactionHash: H(77), blockNumber: r.view.block + 2n, blockHash: H(79), status: 'reverted' });
  await expect(send(r.source, r.view, A, 1n, 60000000n, r.io)).rejects.toThrow();
  expect(r.io.submit).toHaveBeenCalledTimes(mode === 'receipt' ? 1 : 0);
});
it('M253-CLAIM: rechecks wallet identity after simulation, before the shared submitter', async () => {
  const r = await rig();
  r.io.simulate.mockImplementation(async () => { r.io.request.mockResolvedValue([B]); });
  await expect(send(r.source, r.view, A, 1n, 60000000n, r.io)).rejects.toThrow();
  expect(r.io.submit).not.toHaveBeenCalled();
});
it('M253-AF1: a replacement receipt cannot confirm the submitted holder claim', async () => {
  const r = await rig();
  r.io.receipt.mockResolvedValue({ transactionHash: H(78), blockNumber: r.view.block + 2n, blockHash: H(79), status: 'success' });
  await expect(send(r.source, r.view, A, 1n, 60000000n, r.io)).rejects.toThrow();
});
it('M253-INTEGRATION: the shared submitter admits the holder claim to role 17; the wallet is asked to send exactly it', async () => {
  const r = await rig();
  r.io.request.mockImplementation(async ({ method }: { method: string }) => method === 'eth_chainId' ? `0x${r.source.manifest.chainId.toString(16)}` : method === 'eth_sendTransaction' ? H(77) : [A]);
  const confirmed = await send(r.source, r.view, A, 1n, 60000000n, { ...r.io, submit: submitWrite });
  expect(confirmed).toMatchObject({ transactionHash: H(77), status: 'success' });
  const sends = r.io.request.mock.calls.map(([call]) => call as { method: string; params?: [{ to: Address; data: Hex; value: Hex; from: Address }] }).filter((call) => call.method === 'eth_sendTransaction');
  expect(sends).toHaveLength(1);
  const tx = sends[0]?.params?.[0];
  expect(tx?.to).toBe(r.row.contracts.holderLedger); expect(tx?.from).toBe(A); expect(tx?.value).toBe('0x0');
  expect(decodeFunctionData({ abi: holderLedgerV2Abi, data: required(tx).data })).toMatchObject({ functionName: 'claim', args: [1n, A] });
});
it.each([
  ['another target', (t: Target) => ({ to: t.receiver, data: claimData(1n, A) }), /prepared box role/],
  ['a recipient other than the caller', (t: Target) => ({ to: required(t.holderLedger), data: claimData(1n, B) }), /pay the caller/],
  ['batch 0', (t: Target) => ({ to: required(t.holderLedger), data: claimData(0n, A) }), /name a batch/],
] as const)('M253-INTEGRATION: the shared submitter still refuses a holder claim to %s, before the wallet', async (_name, make, why) => {
  const { source, row, view } = await rig();
  const wallet = vi.fn(async ({ method }: { method: string }) => method === 'eth_chainId' ? `0x${source.manifest.chainId.toString(16)}` : method === 'eth_sendTransaction' ? H(77) : [A]);
  const target: Target = { chainId: source.manifest.chainId, coordinator: required(row.contracts.coordinator), receiver: required(row.contracts.receiver), token: view.token, p: view.record.q, holderLedger: required(row.contracts.holderLedger) };
  await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', target, call: { ...make(target), value: 0n }, wallet, from: A, gasLimit: 200000n })).rejects.toThrow(why);
  expect(wallet).not.toHaveBeenCalled();
});
