import { createPublicClient, encodeEventTopics, type Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { squareHoleTokenAbi, dn404MirrorAbi } from '../abi';
import { createChainConfig } from '../config/config';
import { ChainReader } from '../reads/reader';
import { toRegistryPair } from '../reads/registry-pair';
import { ALICE, buildScenario, recordOf } from '../test-support/scenario';
import { decodeApprovedLog, EVENT_TOPICS } from './events';
import { LogIndexer } from './indexer';
import { claimRecordsFromLogs, holderCount, turnover24h } from './metrics';
import type { IndexedLog } from './store';

async function indexed() {
  const scenario = buildScenario();
  const config = createChainConfig({ chainId: 31_337, manifest: scenario.manifestJson, rpcUrls: ['http://127.0.0.1:8551'] });
  const client = createPublicClient({ transport: scenario.chain.transport() });
  const reader = new ChainReader(config, client as never);
  const indexer = new LogIndexer(config, client as never, reader);
  await indexer.sync(await reader.block('latest'));
  const fit = toRegistryPair(recordOf(scenario.manifest, scenario.fit), 31_337);
  const misfits = toRegistryPair(recordOf(scenario.manifest, scenario.misfits), 31_337);
  return { scenario, indexer, fit, misfits };
}

describe('holder count (Transfer replay)', () => {
  it('counts positive balances outside the excluded roles', async () => {
    const { indexer, fit, scenario } = await indexed();
    const excluded = [scenario.manifest.contracts.poolManager.address, scenario.manifest.contracts.hook.address, scenario.fit.contracts.feeCollector.address];
    expect(holderCount(indexer, fit, 40n, 10n ** 27n - 10n ** 21n, excluded)).toEqual({ available: true, count: 1, basis: 'transfer_replay_positive_eligible_balances' });
  });

  it('is unavailable (not a number) when the replay does not reproduce the on-chain supply, or the index is behind', async () => {
    const { indexer, fit } = await indexed();
    expect(holderCount(indexer, fit, 40n, 10n ** 27n, [])).toEqual({ available: false, reason: 'replay_mismatch' });
    expect(holderCount(indexer, fit, 41n, 10n ** 27n - 10n ** 21n, [])).toEqual({ available: false, reason: 'not_indexed' });
  });
});

describe('24h turnover (canonical pool, one leg, rolling window)', () => {
  it('uses the Q leg of each swap once and tags converter swaps', async () => {
    const { indexer, misfits, scenario } = await indexed();
    const end = scenario.chain.timestampOf(40n);
    expect(turnover24h(indexer, misfits, 40n, end)).toMatchObject({ available: true, totalQRaw: 32n * 10n ** 14n, protocolQRaw: 10n ** 14n, otherQRaw: 31n * 10n ** 14n, swaps: 2 });
  });

  it('excludes swaps at or before end − 24h and after the snapshot block time', async () => {
    const { indexer, misfits, scenario } = await indexed();
    const conversionTime = scenario.chain.timestampOf(28n);
    // Window ending exactly 24h after the first swap (block 25): that swap is at the boundary and excluded.
    const firstSwap = scenario.chain.timestampOf(25n);
    expect(turnover24h(indexer, misfits, 40n, firstSwap + 86_400n)).toMatchObject({ available: true, swaps: 1, totalQRaw: 10n ** 14n });
    // A window ending before the conversion's block time counts only the first swap.
    expect(turnover24h(indexer, misfits, 40n, conversionTime - 1n)).toMatchObject({ available: true, swaps: 1, totalQRaw: 31n * 10n ** 14n });
  });
});

describe('claim history joins', () => {
  const base = { blockHash: `0x${'aa'.repeat(32)}` as const, address: '0x0', pairId: null, key: 'k' };
  const log = (partial: Partial<IndexedLog>): IndexedLog => ({ ...base, blockNumber: '10', txHash: `0x${'01'.repeat(32)}`, logIndex: 0, role: 'ledger', event: 'Claimed', args: {}, ...partial }) as IndexedLog;

  it('R = Q: each Claimed event is a settled Q payout of the account', async () => {
    const { fit } = await indexed();
    const records = claimRecordsFromLogs(fit, ALICE, [log({ args: { account: ALICE, recipient: ALICE, amount: '5' } }), log({ args: { account: '0x0000000000000000000000000000000000000001', recipient: ALICE, amount: '7' } })]);
    expect(records).toEqual([expect.objectContaining({ qConsumed: 5n, payout: 5n, payoutAsset: 'Q', route: 'claim_q' })]);
  });

  it('R = T: joins the converter event of the same transaction (T payout or the labelled Q fallback), and refuses an orphan', async () => {
    const { misfits, scenario } = await indexed();
    const converter = scenario.manifest.contracts.claimConverter?.address as Address;
    const token = misfits.token;
    const tx2 = `0x${'02'.repeat(32)}` as const;
    const logs = [
      log({ args: { account: ALICE, recipient: converter, amount: '100' } }),
      log({ role: 'converter', event: 'ClaimConverted', logIndex: 3, args: { token, holder: ALICE, qIn: '100', tOut: '900' } }),
      log({ txHash: tx2, blockNumber: '12', args: { account: ALICE, recipient: converter, amount: '40' } }),
      log({ txHash: tx2, blockNumber: '12', role: 'converter', event: 'ClaimPaidInQSoldOut', logIndex: 2, args: { token, holder: ALICE, qOut: '40' } }),
    ];
    expect(claimRecordsFromLogs(misfits, ALICE, logs)).toEqual([
      expect.objectContaining({ qConsumed: 100n, payout: 900n, payoutAsset: 'T', route: 'convert_to_t' }),
      expect.objectContaining({ qConsumed: 40n, payout: 40n, payoutAsset: 'Q', route: 'sold_out_q_fallback' }),
    ]);
    expect(() => claimRecordsFromLogs(misfits, ALICE, [logs[0] as IndexedLog])).toThrow('without its converter settlement');
  });
});

describe('approved event decoding', () => {
  it('decodes an approved event for its role and ignores the same topic from another role', () => {
    const topics = encodeEventTopics({ abi: squareHoleTokenAbi as Abi, eventName: 'Transfer', args: { from: ALICE, to: ALICE } } as never) as Hex[];
    const data = `0x${'00'.repeat(31)}05` as const;
    expect(decodeApprovedLog('token', { topics, data })).toEqual({ event: 'Transfer', args: { from: ALICE, to: ALICE, amount: '5' } });
    expect(decodeApprovedLog('ledger', { topics, data })).toBeNull();
    expect(EVENT_TOPICS.token.Transfer).toBe(topics[0]);
  });

  it('never decodes the mirror’s ERC-721 Transfer (4 topics) as an ERC-20 transfer', () => {
    const topics = encodeEventTopics({ abi: dn404MirrorAbi as Abi, eventName: 'Transfer', args: { from: ALICE, to: ALICE, id: 7n } } as never) as Hex[];
    expect(decodeApprovedLog('token', { topics, data: '0x' })).toBeNull();
  });
});
