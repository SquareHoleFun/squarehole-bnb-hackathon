import { readFileSync } from 'node:fs';
import { decodeEventLog, decodeFunctionData, encodeFunctionResult, parseAbiItem, type Address, type Hex } from 'viem';
import { expect, it } from 'vitest';
import { poolManagerAbi } from '@squarehole/chain/abi';
import { createClaimsServiceV2 } from '../../../src/core/v2/claims-service-v2';
import { holderLedgerV2Abi } from '../../../src/core/v2/chain-v2';
import { m2Fixture, logM2 } from '../../../src/core/v2/m2-fixture.test-support';
import { World } from '../core-synth';
import { boxLogsV2, serviceChainV2, V2 } from '../scripted-core-chain';
import type { WalletClaimV2 } from '../../../../chain/src/core/v2/claims-types';

const fixtures = JSON.parse(readFileSync(new URL('./events.json', import.meta.url), 'utf8')) as Record<string, { address: Address; topics: [Hex, ...Hex[]]; data: Hex }>;
const paid = fixtures.holder;
if (!paid) throw new Error('missing real holder receipt');
const receipt = decodeEventLog({ abi: holderLedgerV2Abi, ...paid });
if (receipt.eventName !== 'HolderPaid') throw new Error('wrong receipt');
const holder = receipt.args.holder;
const recipient = receipt.args.to;
const funded = parseAbiItem('event HolderBatchFunded(uint256 indexed batchId,uint256 netP)');
const settled = parseAbiItem('event BatchSettled(uint256 indexed batchId,uint256 fundingP,uint256 holderP,uint256 residueP)');

it.each([false, true])('CLAIMS-05 reload and canonical replay replace payment history with unpaid credit (deep=%s)', async deep => {
  const f = m2Fixture(false);
  const old = new World('claims-old'); old.block(10n);
  old.block(100n, [boxLogsV2(f), logM2(funded, f.at(5), { batchId: 1n, netP: 1000n }, 0),
    logM2(settled, f.at(17), { batchId: 1n, fundingP: 1000n, holderP: 1000n, residueP: 0n }, 0)]);
  old.block(101n, [{ ...logM2(funded, f.at(17), { batchId: 1n, netP: 0n }, 0), topics: [...paid.topics], data: paid.data }]);
  old.to(deep ? 260n : 105n);
  const make = (world: World) => {
    const chain = serviceChainV2(world, [f], (_box, key) => {
      if (key === 'receiver.buyersChoice') return 4;
      if (key === 'receiver.holderBatchClosed') return true;
      if (key === 'receiver.holderBatchPaid') return 1000n;
      if (key === 'hook.tradeBatch') return { tradeUnits: 100n, protocolUnits: 0n, netP: 2000n, closed: true };
      return undefined;
    });
    const didPay = (hash: Hex) => {
      let h = chain.byHash.get(hash.toLowerCase());
      while (h) {
        if ((chain.logsOf.get(h.hash.toLowerCase()) ?? []).some(l => l.address.toLowerCase() === f.at(17).toLowerCase() && l.topics[0] === paid.topics[0])) return true;
        h = chain.byHash.get(h.parentHash.toLowerCase());
      }
      return false;
    };
    const original = chain.callAt;
    chain.callAt = async (to, data, hash) => {
      if (to.toLowerCase() === f.at(17).toLowerCase()) {
        const call = decodeFunctionData({ abi: holderLedgerV2Abi, data });
        if (call.functionName === 'claimable') return encodeFunctionResult({ abi: holderLedgerV2Abi, functionName: 'claimable', result: didPay(hash) ? 0n : 1000n });
        if (call.functionName === 'batchState') return encodeFunctionResult({ abi: holderLedgerV2Abi, functionName: 'batchState', result: [true, 1n, 1n, 0n] });
      }
      if (to.toLowerCase() === V2.poolManager.toLowerCase()) {
        const call = decodeFunctionData({ abi: poolManagerAbi, data });
        if (call.functionName === 'balanceOf' && call.args?.[0].toLowerCase() === f.at(17).toLowerCase()) return encodeFunctionResult({ abi: poolManagerAbi, functionName: 'balanceOf', result: didPay(hash) ? 0n : 1000n });
      }
      return original(to, data, hash);
    };
    const service = createClaimsServiceV2({ reader: chain, claimsReader: chain, manifest: f.manifest, auditEvery: 10_000, host: '127.0.0.1', port: 5391 });
    return { chain, service };
  };
  const load = async (world: World) => {
    const instance = make(world);
    // Exercise the real pipeline and service wiring without opening a forbidden localhost listener.
    await instance.service.indexer.start(); await instance.service.indexer.idle();
    expect(instance.service.indexer.metrics.errors).toBe(0);
    return instance;
  };
  const rows = async (service: ReturnType<typeof createClaimsServiceV2>, wallet = holder) => {
    const items: WalletClaimV2[] = []; let after: string | null = null;
    do { const p = await service.claims.page(wallet, { limit: 1, after }); items.push(...p.items); after = p.next; } while (after);
    return items;
  };
  const got = await load(old);
  expect(await rows(got.service)).toEqual([expect.objectContaining({ kind: 'holder', status: 'claimed', amountP: '1000', payment: expect.objectContaining({ block: '101', to: recipient.toLowerCase() }) })]);
  const restarted = await load(old);
  expect(await rows(restarted.service)).toEqual(await rows(got.service));
  expect(await rows(got.service, recipient)).toEqual([]);
  const canonical = old.fork(100n, 'claims-new'); canonical.to(deep ? 350n : 110n);
  got.chain.setBranch(canonical.headers.filter(h => h.number > 100n), canonical.logs.filter(l => l.blockNumber > 100n));
  await got.service.indexer.enqueue(got.chain.header(got.chain.tip)); await got.service.indexer.idle();
  expect(got.service.indexer.metrics.errors).toBe(0);
  expect(await rows(got.service)).toEqual([expect.objectContaining({ kind: 'holder', status: 'claimable', amountP: '1000', payment: null })]);
  const rebuilt = await load(canonical);
  expect(await rows(got.service)).toEqual(await rows(rebuilt.service));
  for (const s of [got, restarted, rebuilt]) s.service.indexer.stop();
});
