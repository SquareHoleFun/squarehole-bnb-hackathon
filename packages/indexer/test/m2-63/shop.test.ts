import type {} from '../../../chain/src/core/v2/m2-63/web-types';
import { expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, parseAbiItem, type Abi, type PublicClient } from 'viem';
import { poolManagerAbi } from '../../../chain/src/abi';
import { shopVaultV2Abi, starterSetLoaderV2Abi } from '../../../chain/src/core/v2';
import { A, B, COLLECTION, H, logM2, m2Fixture } from '../../src/core/v2/m2-fixture.test-support';
import { decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { m2ViewV2 } from '../../src/core/v2/m2-views-v2';
import { jsonV2 } from '../../src/core/core-row';
import { m2RpcReaderV2, readM2MoneyV2 } from '../../src/core/v2/m2-reads-v2';
import { parseM2 } from '../../../../apps/web/src/features/core/v2/m2-data';

it('M263-SHOP: history preserves exact flows and authority changes; only canonical custody reads supply budget and loading state', async () => {
  const f = m2Fixture(), amount = 2n ** 120n + 1n;
  const route = routeV2(f.release, f.manifest, [], [f.record]);
  let index = 0;
  const log = (definition: string, role: number, args: Record<string, unknown>) => {
    const event = parseAbiItem(definition);
    if (event.type !== 'event') throw new Error('fixture requires an event');
    return logM2(event, f.at(role), args, ++index);
  };
  const events = decodeV2Logs([
    log('event SeedFunded(uint256 amountT)', 3, { amountT: amount }),
    log('event Given(address indexed collection,uint256 indexed id,address indexed giver,uint256 amountT)', 3, { collection: COLLECTION, id: amount, giver: A, amountT: 7n }),
    log('event Picked(address indexed collection,uint256 indexed id,address indexed to,uint256 amountT)', 3, { collection: COLLECTION, id: amount, to: B, amountT: 11n }),
    log('event CuratorProposed(address indexed next)', 3, { next: B }),
    log('event CuratorChanged(address indexed curator)', 3, { curator: B }),
    log('event CollectionAdded(address indexed collection,uint8 tier,uint256 activeAt)', 3, { collection: COLLECTION, tier: 3, activeAt: 604800n }),
    log('event StarterLoaded(uint256 indexed index,address indexed collection,uint256 id)', 3, { index: 0n, collection: COLLECTION, id: amount }),
    log('event StarterReturned(uint256 indexed index,address indexed collection,uint256 id)', 3, { index: 0n, collection: COLLECTION, id: amount }),
    log('event FailureEntered()', 3, {}),
    log('event FailedTBurned(uint256 amount)', 3, { amount: amount + 4n }),
    log('event StarterProgress(uint32 loaded,bytes32 remainingHash)', 19, { loaded: 2, remainingHash: H(8) }),
  ], route);
  expect(events).toHaveLength(11);
  const history = m2ViewV2(events, f.row.boxId, f.spec);
  expect(history.shop).toMatchObject({ seedFundedT: amount, givenT: 7n, pickedT: 11n, burnedT: amount + 4n, failed: true,
    curator: B.toLowerCase(), pendingCurator: null, collections: { [COLLECTION.toLowerCase()]: { tier: 3, activeAt: 604800n } },
    starters: { '0': { id: amount, returned: true } } });
  expect(history.starter).toMatchObject({ loaded: 2, notified: false });
  expect(history.shop).not.toHaveProperty('budgetT');
  const seen: string[] = [];
  const client = { request: async (request: { method: string; params: [{ to: string; data: `0x${string}` }, unknown] }) => {
    expect(request.method).toBe('eth_call'); expect(request.params[1]).toEqual({ blockHash: H(101), requireCanonical: true });
    const { to, data } = request.params[0];
    const abi: Abi = to === f.at(3) ? shopVaultV2Abi : to === f.at(19) ? starterSetLoaderV2Abi : poolManagerAbi;
    const { functionName: fn } = decodeFunctionData({ abi, data }); seen.push(fn);
    const result = ({ balanceOf: amount, budgetT: 0n, failedT: amount + 4n, seedReady: true, inside: 0n, collectionSize: 1n,
      curator: B, pendingCurator: A, nextAdditionAt: 604801n, progress: [2, H(8), false] } as Record<string, unknown>)[fn];
    return encodeFunctionResult({ abi, functionName: fn, result });
  } } as unknown as Pick<PublicClient, 'request'>;
  const money = await readM2MoneyV2(m2RpcReaderV2(client), f.row, H(101));
  expect(seen).toHaveLength(10);
  expect(money).toMatchObject({ holderBalanceP: amount, shop: { budgetT: 0n, failedT: amount + 4n }, starter: { loaded: 2, notified: false } });
  const published = parseM2(jsonV2(history), jsonV2(money), H(101));
  expect(published.money).toEqual(money);
  expect(published.history?.shop?.starters['0']?.id).toBe(amount);
  expect(() => parseM2(jsonV2(history), jsonV2(money), H(102))).toThrow('different block');
  expect(() => parseM2(jsonV2(history), jsonV2({ ...money, shop: { ...money.shop, budgetT: 42 } }), H(101))).toThrow();
});
