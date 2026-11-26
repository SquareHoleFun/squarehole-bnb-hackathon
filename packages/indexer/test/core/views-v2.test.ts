import baseline from './rc6-inbox/cq11-e-baseline.json';
import { jsonV2 } from '../../src/core/core-row';
/** CQ11-0: surviving v2 view pins. C14 removed converter, cap and closing-range cases. */
import { encodeEventTopics, encodeAbiParameters, getAddress, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { RawLog } from '../../src/events';
import { decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { boxViewContextV2, boxViewV2 } from '../../src/core/v2/views-v2';
import { coordinatorV2Abi, receiverV2Abi } from '../../../chain/src/core/v2/abi-v2';
import { EVENT_ABI_V2 } from '../../../chain/src/core/v2/events-v2';
import { synthBoxV2, synthManifestV2, V2 } from '../../../chain/src/core/v2/test-support/synth-v2';

const manifest = synthManifestV2();
const release = manifest.releases[0];
if (!release) throw new Error('synthetic release');
const LINK = '0x514910771AF9Ca656af840dff83E8264EcF986CA' as Address;
const OTHER_CONTRACT = '0xc0de00000000000000000000000000000000c0de' as Address;
/** The creating address, apart from the spec's `creatorFeeRecipient`. */
const CREATING = getAddress('0xc4ea7e0000000000000000000000000000000001');
const box = synthBoxV2({ boxId: 4n, pricing: { listingId: 3, token: LINK }, raise: 2_100n * 10n ** 18n, creator: CREATING, specOf: (s) => ({ ...s, creatorFeeRecipient: V2.weth }) });
const part = (i: number): Address => box.record.contracts[i] as Address;
const [COORDINATOR, TOKEN, HOOK, RECEIVER] = [part(0), part(1), part(2), part(5)];
const route = routeV2(release, manifest, [{ id: 3 }], [box.record]);

let logIndex = 0;
/** One log as `address` emits `eventName` (the chain ABIs encode it; their shapes are pinned in abi-v2.test.ts). */
function log(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>, block = 200n): RawLog {
  const event = abi.find((x) => x.type === 'event' && x.name === eventName);
  if (!event || event.type !== 'event') throw new Error(eventName);
  const data = encodeAbiParameters(event.inputs.filter((i) => !i.indexed), event.inputs.filter((i) => !i.indexed).map((i) => args[i.name ?? '']) as never);
  const topics = encodeEventTopics({ abi: [event], eventName, args: Object.fromEntries(event.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name ?? '']])) } as never) as Hex[];
  return { address, topics, data, blockNumber: block, blockHash: keccak256(toHex(block)), transactionHash: keccak256(toHex(block + 7n)), transactionIndex: 0, logIndex: logIndex++ };
}
const ctx = boxViewContextV2(box.record, box.spec, 18);
const view = (logs: RawLog[]) => boxViewV2(decodeV2Logs(logs, route), ctx);

describe('v2 views after C14', () => {
  it('M1-52 loaded chunks and whether the gate is still closed', () => {
    const chunk = (part: number, index: bigint, partDone: boolean) => log(coordinatorV2Abi as Abi, COORDINATOR, 'ChunkLoaded', { part, index, pointer: V2.weth, length: 24_576n, partDone });
    const closed = view([chunk(1, 0n, false), chunk(1, 1n, true), chunk(2, 0n, false)]);
    expect(closed.gate).toEqual({ open: false, effectiveOpenAt: null, deadline: null, chunks: { Table: { loaded: 2, done: true }, Texts: { loaded: 1, done: false } } });
    const open = view([chunk(1, 0n, true), chunk(2, 0n, true), log(coordinatorV2Abi as Abi, COORDINATOR, 'BoxOpenSet', { effectiveOpenAt: 1_800_000_000n, deadline: 1_800_000_000n + 30n * 86_400n })]);
    expect(open.gate).toMatchObject({ open: true, effectiveOpenAt: 1_800_000_000n, deadline: 1_802_592_000n });
  });

  it("M1-52 the creator's addresses never take in a known contract: the box's own parts, its PoolManager, or one the caller names", () => {
    const claim = (to: Address) => log(receiverV2Abi as Abi, RECEIVER, 'CreatorClaimed', { payee: CREATING, token: TOKEN, to, amount: 1n });
    const out = (from: Address) => log(EVENT_ABI_V2.token as Abi, TOKEN, 'Transfer', { from, to: V2.weth, amount: 9n });
    const PM = box.record.poolManager;
    expect(ctx.notCreator).toEqual(expect.arrayContaining([COORDINATOR, HOOK, RECEIVER, PM]));
    const v = boxViewV2(decodeV2Logs([claim(HOOK), claim(PM), claim(OTHER_CONTRACT), out(HOOK), out(PM), out(OTHER_CONTRACT)], route), { ...ctx, notCreator: [...ctx.notCreator, OTHER_CONTRACT] });
    expect(v.creatorClaims.map((c) => c.to)).toEqual([HOOK, PM, getAddress(OTHER_CONTRACT)]);
    expect(v.creatorAddresses.map((c) => c.namedBy)).toEqual(['creator', 'creatorFeeRecipient']);
    expect(v.creatorTOut).toEqual([]);
    // Without the caller's list a claim to another contract is followed: the caller names the release's contracts.
    expect(view([claim(OTHER_CONTRACT), out(OTHER_CONTRACT)]).creatorTOut.map((o) => o.from)).toEqual([getAddress(OTHER_CONTRACT)]);
  });

  it('CQ11-E: replacement failure and fee projections', () => {
    const event = (source: keyof typeof EVENT_ABI_V2, address: Address, name: string, args: Record<string, unknown>) =>
      log(EVENT_ABI_V2[source] as Abi, address, name, args);
    const got = view([
      event('hook', HOOK, 'MigratedV2', { poolId: box.record.poolId, liquidity: 400n, qLeft: 25n, tBurned: 3n }),
      event('hook', HOOK, 'Deepened', { poolId: box.record.poolId, liquidity: 12n, qUsed: 20n, tUsed: 10n, tip: 1n }),
      event('receiver', RECEIVER, 'Collected', { caller: CREATING, tipTo: CREATING, buyersP: 150n, sellersP: 300n, qToReserve: 7n, tip: 2n }),
      event('receiver', RECEIVER, 'FitPaid', { safe: V2.executor, amount: 60n }),
      event('receiver', RECEIVER, 'PlatformPaid', { safe: V2.platformSafe, amount: 30n }),
      event('receiver', RECEIVER, 'RoyaltyFunded', { token: V2.weth, destination: 1, amount: 80n }),
      event('royaltyRouter', part(8), 'InKindClaimed', { token: V2.weth, payee: CREATING, amount: 50n }),
      event('receiver', RECEIVER, 'BoughtBack', { pSpent: 100n, tBought: 70n, tBurned: 0n, tip: 5n }),
      event('token', TOKEN, 'Transfer', { from: RECEIVER, to: '0x0000000000000000000000000000000000000000', amount: 70n }),
      event('coordinator', COORDINATOR, 'BoxFailed', { caller: CREATING, cause: 3, timestamp: 2_000_000_000n }),
      event('coordinator', COORDINATOR, 'PotFixed', { pot: 10n ** 30n + 7n, tLeft: 3n * 10n ** 18n, tip: 5n, closer: CREATING }),
      event('coordinator', COORDINATOR, 'Claimed', { holder: CREATING, to: CREATING, t: 10n ** 18n, p: (10n ** 30n + 7n) / 3n }),
    ]);
    const { vaultItems, ...legacyView } = got;
    expect(vaultItems).toEqual({ firstId: 1n, n: 100n, known: [], owners: {} });
    expect(JSON.stringify(jsonV2(legacyView))).toBe(JSON.stringify(baseline));
    expect(got).toMatchObject({
      position: { kind: 'full_range', liquidity: 412n, tickLower: -887220, tickUpper: 887220, salt: 3n },
      fees: { buyersP: 150n, sellersP: 300n, qToReserve: 7n, tipsP: 2n },
      safePaid: { fit: { [LINK.toLowerCase()]: 60n }, platform: { [LINK.toLowerCase()]: 30n } },
      royaltyInKind: { [V2.weth.toLowerCase()]: 50n },
      buyBack: { pSpent: 100n, tBought: 70n, tBurned: 70n, tipsP: 5n },
      claim: { initialPot: 10n ** 30n + 7n, initialT: 3n * 10n ** 18n, tLeft: 2n * 10n ** 18n, claimedT: 10n ** 18n, claimedP: (10n ** 30n + 7n) / 3n, tip: 5n },
    });
    expect(got).not.toHaveProperty('humble');
    expect(got).not.toHaveProperty('eaten');
  });
});
