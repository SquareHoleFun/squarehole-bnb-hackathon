/** Demo publication: M2-52 factory/reader double, never a deployed box. */
import { encodeAbiParameters, keccak256 } from 'viem';
import { encodeBoxSpecV2, shopConfigV2Parameters } from '../../../../../../../packages/chain/src/core/v2';
import { m2Fixture, A, B, COLLECTION, H } from '../../../../../../../packages/indexer/src/core/v2/m2-fixture.test-support';
import { jsonV2 } from '../../../../../../../packages/indexer/src/core/core-row';
import { m2ViewV2 } from '../../../../../../../packages/indexer/src/core/v2/m2-views-v2';
import { publishedV2 } from './published-v2';
import { required } from './required';
export { A, B, H };
export async function publishedM2(failed = false) {
  const base = await publishedV2(failed); const f = m2Fixture();
  const contentsParams = encodeAbiParameters(shopConfigV2Parameters, [{ seedT: 1000n * 10n ** 18n, givePricesT: [1n, 2n, 4n, 8n].map(n => n * 10n ** 18n) as [bigint, bigint, bigint, bigint], pickBps: 15000, weeklyBps: 1000, collectionBps: 250, listDelay: 604800, curator: A, collections: [COLLECTION], tiers: [0] }]);
  const spec = { ...f.spec, contentsParams }; const encodedSpec = encodeBoxSpecV2(spec);
  const record = { ...f.record, specHash: keccak256(encodedSpec) };
  const row = { ...f.row, record, spec, encodedSpec, pDecimals: 6 };
  const history = m2ViewV2([], row.boxId, spec);
  const body = { ...base.body, chainId: row.chainId, token: f.at(1), row: jsonV2(row), verified: true,
    m2: jsonV2({ ...history, failed, batches: { '1': { fundingP: 100000000n, complete: true, holderP: 80000000n, residueP: 20000000n, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {} } },
      shop: { ...required(history.shop), failed, collections: { [COLLECTION]: { tier: 0, activeAt: 604800n } } } }),
    money: { ...required(base.body.money), m2: jsonV2({ hash: base.body.asOf.hash, holderBalanceP: 100000000n,
      shop: { budgetT: failed ? 0n : 900719925474099300000001n, failedT: failed ? 1000n * 10n ** 18n : 0n, seedReady: true, inside: 3n, collectionSize: 3n, curator: A, pendingCurator: B, nextAdditionAt: 604800n },
      starter: { loaded: 3, remainingHash: H(7), notified: false } }) } };
  return { body, source: { ...base.source, manifest: f.manifest }, row };
}
