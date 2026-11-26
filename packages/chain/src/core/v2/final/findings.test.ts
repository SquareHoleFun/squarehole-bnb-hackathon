import type {} from '../m2-63/web-types';
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { coordinatorV2Abi, receiverV2Abi } from '../abi-v2';
import { transactionGas } from '../../../../../keeper/src/gas';
import { creatorFeesOf, readCreatorFeesV2, sendCreatorFeesV2, type ClaimAllIO } from '../../../../../../apps/web/src/features/core/v2/claim-all-actions';
import { parseSnapshotV2 } from '../../../../../../apps/web/src/features/core/v2/indexer-v2';
import { publishedM2, A, H } from '../../../../../../apps/web/src/features/core/v2/test-support/m2-published';
import { submitWrite } from '../../../write/executor';
import { TEST_FEE_READER } from '../../../write/test-support/index';

const CAP = 4n * ((1n << 127n) - 1n);

describe('FINAL-OC01: the site offers the same next creator payment as the receiver', () => {
  it.each([
    ['lazy royalties after graduation', 0n, 1234n],
    ['settled credit above the four-part cap', CAP + 7n, CAP],
  ] as const)('%s reaches the guarded sender', async (_name, stored, nextPayment) => {
    const { body, source } = await publishedM2();
    const base = parseSnapshotV2(body, source);
    if (!base.money) throw new Error('missing published money fixture');
    const view = { ...base, graduated: true, failed: null,
      money: { ...base.money, creatorPayee: A, creatorOwed: stored } };
    const sends: unknown[] = [];
    const io: ClaimAllIO = {
      feeReader: TEST_FEE_READER, chainId: async () => source.manifest.chainId,
      request: async request => {
        if (request.method === 'eth_chainId') return `0x${source.manifest.chainId.toString(16)}`;
        if (request.method === 'eth_accounts') return [A];
        if (request.method === 'eth_sendTransaction') { sends.push(request); return H(7); }
        throw new Error('unexpected wallet request');
      },
      at: async (_to, _abi, fn) => {
        const answers: Record<string, unknown> = { creatorPayee: A, graduated: true, failed: false, creatorOwed: [stored, 0n] };
        if (!(fn in answers)) throw new Error(`unscripted ${fn}`);
        return answers[fn];
      },
      as: async (from, _to, _abi, fn, args) => {
        expect(from).toBe(A);
        expect(fn).toBe('claimCreator');
        expect(args).toEqual([view.record.q, A]);
        return nextPayment;
      },
      now: async () => { throw new Error('unexpected latest read'); },
      simulate: async () => undefined,
      estimate: async () => 500_000n,
      receipt: async hash => ({ transactionHash: hash, blockNumber: view.block + 1n, blockHash: H(9), status: 'success' }),
      submit: submitWrite,
    };
    // Agreement.t.sol independently establishes both payable amounts with the real receiver and PM.
    // The displayed amount is the site's quote read at the snapshot's hash (FE11): the snapshot alone cannot say
    // (lazy royalties, the four-part bound), so it must give no figure rather than a wrong one.
    const raw = async (data: Hex): Promise<Hex> => {
      for (const abi of [receiverV2Abi, coordinatorV2Abi]) {
        try {
          const { functionName } = decodeFunctionData({ abi, data });
          const result = ({ creatorPayee: A, graduated: true, failed: false, claimCreator: nextPayment } as Record<string, unknown>)[functionName];
          return encodeFunctionResult({ abi, functionName, result } as never);
        } catch { /* the other ABI */ }
      }
      throw new Error('unscripted call');
    };
    // Soft assertions keep the sender check live even when the displayed amount is already wrong.
    expect.soft(creatorFeesOf(view, A)).toBeNull();
    expect.soft(await readCreatorFeesV2(view, A, { callAt: (_to, data) => raw(data), callFromAt: (_from, _to, data) => raw(data) }))
      .toEqual({ block: view.block, amount: nextPayment });
    await expect(sendCreatorFeesV2(source, view, A, nextPayment, io)).resolves.toMatchObject({ status: 'success' });
    expect(sends).toHaveLength(1);
  });
});

describe('FINAL-ACCESS-G01: optional starter return must activate', () => {
  it('the keeper floor covers the measured 2M envelope after the 800k NFT stipend change', () => {
    // Agreement.t.sol and access/Recovery.t.sol prove the 2M envelope against real custody.
    expect(transactionGas('shopReturn', 30_000n)).toBeGreaterThanOrEqual(2_000_000n);
  });
});
