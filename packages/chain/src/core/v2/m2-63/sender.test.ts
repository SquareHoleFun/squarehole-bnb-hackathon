import { expect, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { submitWrite } from '../../../write/executor';
import { holderLedgerV2Abi } from '../abi-v2';
import { sendHolderClaimV2, type HolderActionIO, type HolderClaimV2 } from '../../../../../../apps/web/src/features/core/v2/actions-v2';
import { parseSnapshotV2 } from '../../../../../../apps/web/src/features/core/v2/indexer-v2';
import { publishedM2, A, B, H } from '../../../../../../apps/web/src/features/core/v2/test-support/m2-published';
import { TEST_FEE_READER } from '../../../write/test-support/index';

it.each(['success', 'amount-change', 'account-change', 'reverted-receipt'] as const)('M263-SEND: real site action and shared sender enforce %s', async mode => {
  const { source, body, row } = await publishedM2(true), view = parseSnapshotV2(body, source);
  const amount = 2n ** 120n + 1n; let account = A;
  const sent: unknown[] = [];
  const credit: HolderClaimV2 = { hash: view.blockHash, batchId: 1n, holder: A, status: 'settled', payout: 'available', claimableP: mode === 'amount-change' ? amount - 1n : amount,
    complete: true, hookClosed: true, fundingFinal: true, fundingP: amount, holderCursor: 1n, noticeCursor: 0n, residueP: 0n, failedBox: true };
  const io: HolderActionIO = {
    submit: submitWrite, feeReader: TEST_FEE_READER, chainId: async () => source.manifest.chainId, claim: async () => credit,
    request: vi.fn(async r => {
      if (r.method === 'eth_chainId') return `0x${source.manifest.chainId.toString(16)}`;
      if (r.method === 'eth_accounts') return [account];
      if (r.method === 'eth_sendTransaction') { sent.push(r.params); return H(77); }
      throw new Error(`unexpected wallet call ${r.method}`);
    }),
    simulate: async (to, data, from) => {
      expect([to, from]).toEqual([row.contracts.holderLedger, A]);
      expect(decodeFunctionData({ abi: holderLedgerV2Abi, data })).toMatchObject({ functionName: 'claim', args: [1n, A] });
      if (mode === 'account-change') account = B;
    },
    estimate: async () => 200000n,
    receipt: async () => ({ transactionHash: H(77), blockNumber: view.block + 1n, blockHash: H(78), status: mode === 'reverted-receipt' ? 'reverted' : 'success' }),
  };
  const result = sendHolderClaimV2(source, view, A, 1n, amount, io);
  if (mode === 'success') await expect(result).resolves.toMatchObject({ transactionHash: H(77), status: 'success' });
  else await expect(result).rejects.toThrow();
  expect(sent).toHaveLength(mode === 'success' || mode === 'reverted-receipt' ? 1 : 0);
});
