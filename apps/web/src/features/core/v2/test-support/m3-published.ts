/**
 * Synthetic M3-52 publications for the box page: an every-item box (buyers Keep, sellers Burn) and a coin pile, on the
 * M3-52 creation double (`m3Fixture`), never a deployed box. History is given as the published JSON; current credit
 * and custody come from the RPC double (m3-rpc.ts), as on a live page.
 */
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address } from 'viem';
import { encodeBoxSpecV2, type SideV2 } from '../../../../../../../packages/chain/src/core/v2';
import { m3Fixture, A, B, H } from '../../../../../../../packages/indexer/src/core/v2/m3-fixture.test-support';
import { jsonV2 } from '../../../../../../../packages/indexer/src/core/core-row';
import { publishedV2 } from './published-v2';
import { required } from './required';
export { A, B, H };

export const ETH = 10n ** 18n;
/** The Keep side's graduation receipt (4 ETH over 4 items: 1 ETH base each) and the live index (0.25 ETH per item). */
export const KEEP_BASE = 4n * ETH;
export const LIVE_INDEX = ETH / 4n;

export interface ItemsOptions {
  readonly failed?: boolean;
  readonly graduated?: boolean;
  /** P decimals (6/8/18); the synthetic price coin stays the zero address, so the page names it ETH. */
  readonly decimals?: number;
  /** Items recorded outside or back in the vault, by id. */
  readonly known?: Readonly<Record<string, { readonly inside: boolean; readonly sequence: bigint }>>;
  /** v2.1 step 2: the sides as chosen (BuyT / Items pays items in T); the record's spec hash follows them. */
  readonly sides?: { readonly buyers?: SideV2; readonly sellers?: SideV2 };
  /** The item ledger's T claims at the displayed hash (published as `money.payInT`) when a side pays items in T. */
  readonly itemBalanceT?: bigint;
  /** v2.1 step 5: the history's inside policies (Keep 1, Burn 2, Depth 3), receipts and the depth total a Depth side publishes. */
  readonly history?: { readonly policies: { readonly buyers: number; readonly sellers: number }; readonly funding?: Readonly<Record<string, unknown>>; readonly depthP?: bigint };
  /** T06: the collection's size N (default the creation double's 4); the record's spec hash follows it. */
  readonly n?: number;
  /** SH-BOX-PICTURE-FIT: other spec fields (its name, ticker and pictures); the record's spec hash follows them. */
  readonly spec?: Readonly<Record<string, unknown>>;
}

export async function publishedItems(options: ItemsOptions = {}) {
  const base = await publishedV2(options.failed ?? false); const f = m3Fixture();
  const spec = { ...f.spec, ...options.sides, ...(options.n !== undefined ? { n: options.n } : {}), ...options.spec } as typeof f.spec; const encodedSpec = encodeBoxSpecV2(spec); const record = { ...f.record, specHash: keccak256(encodedSpec) };
  const row = { ...f.row, record, specHash: record.specHash, spec, encodedSpec, pDecimals: options.decimals ?? 18 };
  const inT = [spec.buyers, spec.sellers].some((side) => side.a.leg === 2 && side.a.dest === 8);
  const items = {
    policies: { buyers: 1, sellers: 2 }, choiceP: KEEP_BASE + 2n * ETH, fundedP: KEEP_BASE + ETH + ETH / 2n, retainedBurnP: ETH / 2n, flushedP: 0n,
    fundingCursor: 3n, lifecycleCursor: 4n, outsideIndex: LIVE_INDEX, noticesFailed: 0n,
    funding: {
      '1': { batchId: 0n, side: 1, source: 3, choiceP: KEEP_BASE, ledgerP: KEEP_BASE },
      '2': { batchId: 0n, side: 2, source: 3, choiceP: 0n, ledgerP: 0n },
      '3': { batchId: 1n, side: 2, source: 1, choiceP: ETH, ledgerP: ETH / 2n },
    },
    operations: {},
    tickets: { [H(11)]: { fundingStart: 3n, start: LIVE_INDEX, requestedAt: 900n, state: 'open', itemId: null } },
    items: options.known ?? { '1': { inside: false, sequence: 2n }, '2': { inside: false, sequence: 3n }, '3': { inside: true, sequence: 4n } },
    ...(options.history ? { policies: options.history.policies, ...(options.history.funding ? { funding: options.history.funding } : {}), ...(options.history.depthP !== undefined ? { depthP: options.history.depthP } : {}) } : {}),
  };
  const body = { ...base.body, chainId: row.chainId, token: f.at(1), row: jsonV2(row), verified: true, graduated: options.graduated ?? !options.failed,
    m3: jsonV2({ items, pile: null }),
    money: { ...required(base.body.money), m3: jsonV2({ hash: base.body.asOf.hash, itemBalanceP: KEEP_BASE + ETH + ETH / 2n, pile: null }),
      ...(inT ? { payInT: jsonV2({ pendingP: 0n, holdersP: 0n, buyersItemsP: 0n, sellersItemsP: 0n, burnPendingT: 0n, holderBalanceT: 0n, itemBalanceT: options.itemBalanceT ?? 0n, receiverBalanceT: 0n }) } : {}) } };
  return { body, source: { ...base.source, manifest: f.manifest }, row, at: f.at };
}

export interface PileOptions {
  readonly failed?: boolean;
  readonly graduated?: boolean;
  /** The seed coin: the native coin (zero address) by default. */
  readonly asset?: Address;
  readonly seed?: bigint;
  readonly loaded?: boolean;
  readonly returned?: boolean;
  /** Live pile balance at the displayed hash; null for a zero-supply read. */
  readonly balance?: bigint | null;
  readonly supply?: bigint;
  /** v2.1 step 3: the fixed leave-behind (500 encodes the 96-byte PileParamsV21). */
  readonly leaveBehindBps?: 0 | 500;
  /** v2.1 step 3: buyers chose To the pile, with these receiver reads (null: the read is unavailable). */
  readonly pileFees?: { readonly pendingP: bigint; readonly movedP: bigint } | null;
}

export async function publishedPile(options: PileOptions = {}) {
  const failed = options.failed ?? false; const graduated = options.graduated ?? !failed;
  const base = await publishedV2(failed); const f = m3Fixture(true);
  const asset = options.asset ?? '0x0000000000000000000000000000000000000000'; const seed = options.seed ?? 1000n * ETH;
  // The seed coin and amount are the spec's PileParams; the record's spec hash follows them.
  const leave = options.leaveBehindBps ?? 0;
  const contentsParams = leave === 0 ? encodeAbiParameters(parseAbiParameters('address,uint256'), [asset, seed]) : encodeAbiParameters(parseAbiParameters('address,uint256,uint16'), [asset, seed, leave]);
  const pileSide = { a: { leg: 1, dest: 7, legParams: '0x' as const, destParams: '0x' as const }, b: { leg: 0, dest: 0, legParams: '0x' as const, destParams: '0x' as const }, split: 1, splitParams: '0x' as const };
  const spec = { ...f.spec, tokenSymbol: 'HOARD', tokenName: "Dragon's Hoard", contentsParams, ...(options.pileFees !== undefined ? { buyers: pileSide } : {}) };
  const encodedSpec = encodeBoxSpecV2(spec); const record = { ...f.record, specHash: keccak256(encodedSpec) };
  const row = { ...f.row, record, specHash: record.specHash, spec, encodedSpec };
  const loaded = options.loaded ?? true; const supply = options.supply ?? 1_000_000n * ETH;
  const balance = options.balance === undefined ? seed + 20n : options.balance;
  const returned = options.returned ?? false;
  const pile = { asset, seeder: f.record.creator, seedAmount: seed, seedLoaded: loaded || seed === 0n, loadedAmount: loaded ? seed : 0n, seedReturned: returned, returnedAmount: returned && loaded ? seed : 0n,
    graduated, failed, redeemedT: 0n, redeemedAsset: 0n };
  const money = { asset, seeder: f.record.creator, seedAmount: seed, balance, balanceStatus: balance === null ? 'unavailable_zero_supply' : 'verified', supply, graduated, failed,
    seedReceived: pile.seedLoaded, seedReturnDue: failed && !returned ? pile.loadedAmount : 0n, seedReturnBacked: balance === null ? null : true, redemptionOpen: graduated && !failed && supply > 0n };
  const body = { ...base.body, chainId: row.chainId, token: f.at(1), row: jsonV2(row), verified: true, graduated,
    m3: jsonV2({ items: null, pile: { ...pile, leaveBehindBps: BigInt(leave) } }), money: { ...required(base.body.money), m3: jsonV2({ hash: base.body.asOf.hash, itemBalanceP: null, pile: { ...money, leaveBehindBps: BigInt(leave) } }),
      ...(options.pileFees ? { pileFees: jsonV2(options.pileFees) } : {}) } };
  return { body, source: { ...base.source, manifest: f.manifest }, row, at: f.at, seed, asset };
}
