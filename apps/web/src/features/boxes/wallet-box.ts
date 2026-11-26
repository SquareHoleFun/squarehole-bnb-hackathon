/**
 * A wallet as a box (F46: "We also want to show the users' wallets as boxes"; BOX-INTERFACE § 4): what one address
 * holds of the supported boxes on this data source, read-only. Different assets are never added up and nothing is
 * priced in USD (no totals); an unread value stays null, never 0. Item ids need the indexer and the art hosting (G13),
 * so revealed items are shown as counts. Claims are not built (the per-Misfit stream, T10–T12).
 *
 * The Demo has two wallets from the box mock-up (mock data, labelled Demo): A during the curve (FIT, two sealed
 * Misfits, Clay Pots tokens) and B after graduation (three Misfits, Toy Trains tokens and four toy blocks, FIT). Every
 * other address, the three older Demo personas included, holds nothing from a supported box.
 */
import type { WalletBoxRead } from '@squarehole/chain';
import { sameAddress, type Address } from '@squarehole/domain';
import type { BoxRecord, BoxState } from './box-model';
import type { DemoScenario } from '../fit-pair/demo-chain';
import { formatCount } from '../fit-pair/fit-format';
import { capitalized, withArticle } from '../fit-pair/market-names';
import { DEMO_WALLET_A, DEMO_WALLET_B } from '../wallet/personas';
import { TESTNET } from '../data-source/testnet';

const FALLBACK_ONE = (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? 'Misfit' : 'item';
const FALLBACK_MANY = (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? 'Misfits' : 'items';

export interface WalletHolding {
  readonly record: BoxRecord;
  /** The box's state as this view knows it (a Demo wallet carries its own snapshot). */
  readonly state: BoxState | null;
  /** Token balance, raw (18 decimals); null = not read. */
  readonly tokenRaw: bigint | null;
  /** Placeholders held: sealed until graduation. */
  readonly sealed: bigint | null;
  /** Revealed items held (ids need the indexer: shown as a count). */
  readonly revealed: bigint | null;
  /** A Demo snapshot's scenario, for its "Open box" link. */
  readonly scenario: DemoScenario | null;
  /** A core v1 box's per-item stream: what this address is owed, raw T (read at one block, never from our index). */
  readonly streamOwed?: bigint | null;
  /** The item ids held, when the indexer lists them. */
  readonly itemIds?: readonly bigint[];
}

export interface WalletBox {
  readonly address: Address;
  readonly holdings: readonly WalletHolding[];
  readonly source: 'demo' | 'chain';
  /** The block of a chain read. */
  readonly block: bigint | null;
  /** A Demo wallet's snapshot line ("Demo snapshot · during the curve"), or null. */
  readonly snapshot: string | null;
  /** Boxes this address created (its BoxSpec's owner), as OpenSea's "Created" tab; newest first. */
  readonly created: readonly BoxRecord[];
  /**
   * SH-258 round 3: false where this page reads no holdings at all (BNB Chain testnet: no core v1 wallet read; its v2
   * claims show alone): then it says nothing about what the wallet holds. Absent: read.
   */
  readonly holdingsRead?: boolean;
}

export { DEMO_WALLET_A, DEMO_WALLET_B };

const tokens = (whole: bigint): bigint => whole * 10n ** 18n;

/** Whether a holding has anything to show. A null count is unknown, not empty. */
export function holdsSomething(holding: WalletHolding): boolean {
  return [holding.tokenRaw, holding.sealed, holding.revealed, holding.streamOwed ?? null].some((value) => value !== null && value > 0n);
}

/** Boxes with something in them, and items (sealed and revealed NFTs, a count of things, not of amounts). */
export function walletStats(wallet: WalletBox): { readonly boxes: number; readonly items: bigint | null } {
  const held = wallet.holdings.filter(holdsSomething);
  const counts = wallet.holdings.flatMap((holding) => [holding.sealed, holding.revealed]);
  const known = counts.filter((value): value is bigint => value !== null);
  return { boxes: held.length, items: known.length === 0 && counts.length > 0 ? null : known.reduce((sum, value) => sum + value, 0n) };
}

interface DemoHoldingSpec {
  readonly ticker: string;
  readonly state: BoxState;
  readonly tokens: bigint;
  readonly sealed: bigint;
  readonly revealed: bigint;
  readonly scenario: DemoScenario | null;
}

type DemoWalletSpec = { readonly snapshot: string; readonly holdings: readonly DemoHoldingSpec[] };
let demoWallets: ReadonlyMap<string, DemoWalletSpec> | null = null;

/** The Demo's two box wallets, built on first use (a module-level map would ship them with every page that imports this). */
const demoWalletSpecs = (): ReadonlyMap<string, DemoWalletSpec> => (demoWallets ??= new Map([
  [
    DEMO_WALLET_A.toLowerCase(),
    {
      snapshot: 'During the curve',
      holdings: [
        { ticker: 'FIT', state: 'bonding', tokens: tokens(1_250_000n), sealed: 2n, revealed: 0n, scenario: 'curve' },
        { ticker: 'POTS', state: 'bonding', tokens: tokens(40_000n), sealed: 0n, revealed: 0n, scenario: null },
      ],
    },
  ],
  [
    DEMO_WALLET_B.toLowerCase(),
    {
      snapshot: 'After graduation',
      holdings: [
        { ticker: 'FIT', state: 'graduated', tokens: tokens(400_000n), sealed: 0n, revealed: 3n, scenario: 'migrated' },
        { ticker: 'CHOO', state: 'graduated', tokens: tokens(2_500_000n), sealed: 0n, revealed: 4n, scenario: null },
      ],
    },
  ],
]));

/**
 * The boxes `address` created, newest first: built from a BoxSpec whose creator it is (the site record's creator, else
 * the collection's owner or the fee recipient; a token-only box names no owner in its spec).
 */
export function createdBy(address: Address, boxes: readonly BoxRecord[]): BoxRecord[] {
  return boxes.filter((box) => box.spec !== null && box.spec.creator !== null && sameAddress(box.spec.creator, address)).sort((a, b) => b.order - a.order);
}

/**
 * A Demo wallet box: A and B hold Demo boxes; any other address holds nothing from a supported box. A box the address
 * created is listed under Created, and its creator buy (F61 O2) is a token holding (the T it came to, an estimate).
 */
export function demoWalletBox(address: Address, boxes: readonly BoxRecord[]): WalletBox {
  const spec = demoWalletSpecs().get(address.toLowerCase());
  const holdings = (spec?.holdings ?? []).flatMap((holding): WalletHolding[] => {
    const record = boxes.find((box) => box.ticker === holding.ticker && box.demo && box.spec === null);
    if (!record) return [];
    return [{ record, state: holding.state, tokenRaw: holding.tokens, sealed: holding.sealed, revealed: holding.revealed, scenario: holding.scenario }];
  });
  const created = createdBy(address, boxes);
  const firstIn = created.flatMap((record): WalletHolding[] => {
    const tokens = record.spec?.firstTokensRaw ?? 0n;
    return record.demo && tokens > 0n ? [{ record, state: record.demoState, tokenRaw: tokens, sealed: 0n, revealed: 0n, scenario: null }] : [];
  });
  return Object.freeze({ address, holdings: [...firstIn, ...holdings], source: 'demo', block: null, snapshot: spec?.snapshot ?? null, created });
}

/**
 * A wallet across the core v1 boxes of a source (S10a § 6; BC-089): one holding per box, keyed by the box's own record
 * (its token address), never by ticker; T, placeholders and items are each box's own, never added up across boxes.
 */
export function coreWalletBox(address: Address, boxes: readonly { readonly record: BoxRecord; readonly state: BoxState | null; readonly t: bigint; readonly tickets: bigint | null; readonly items: bigint | null; readonly itemIds: readonly bigint[]; readonly streamOwed: bigint | null }[], block: bigint | null): WalletBox {
  return Object.freeze({
    address,
    holdings: boxes.map((b) => ({ record: b.record, state: b.state, tokenRaw: b.t, sealed: b.tickets, revealed: b.items, scenario: null, streamOwed: b.streamOwed, itemIds: b.itemIds })),
    source: 'chain',
    block,
    snapshot: null,
    created: [],
  });
}

/** A chain read as a wallet box: one holding, the launch market's. */
export function chainWalletBox(read: WalletBoxRead, record: BoxRecord, state: BoxState | null): WalletBox {
  return Object.freeze({
    address: read.account,
    holdings: [{ record, state, tokenRaw: read.tokenBalance, sealed: read.placeholderBalance, revealed: read.collectionBalance, scenario: null }],
    source: 'chain',
    block: read.block.number,
    snapshot: null,
    created: [],
  });
}

/** The companion slot (a Misfit next to the wallet, T20; not built): what the slot and the Companion tab say. */
export interface Companion {
  /** The words in the shell's lid slot. */
  readonly slot: string;
  readonly lead: string;
  readonly line: string;
}

/**
 * What the companion slot says depends on what the wallet holds of the launch (a revealed item can be chosen, a
 * placeholder opens at graduation, nothing held leaves it empty) and whose wallet it is. The launch's own noun is used
 * ("Misfit"; a rehearsal's "item"); unknown counts read as nothing known, never as 0.
 */
export function companionOf(wallet: WalletBox | null, own: boolean): Companion {
  // SH-258 round 3: nothing read (or no read here at all) says nothing about holdings: no companion is selected.
  // Sepolia keeps its words while a wallet loads (parity, round 3b); BNB says nothing about what was not read.
  if (wallet?.holdingsRead === false || (wallet === null && TESTNET.name !== 'sepolia')) return { slot: 'Empty', lead: 'No companion selected', line: 'Choosing a companion is not in this app yet.' };
  const launch = wallet?.holdings.find((holding) => holding.record.market !== null) ?? null;
  // SH-258: without box 0 (BNB Chain testnet) the noun without a launch is a plain "item", never "Misfit".
  const one = launch ? launch.record.itemNoun.replace(/s$/, '') : FALLBACK_ONE;
  const revealed = launch?.revealed ?? null;
  const sealed = launch?.sealed ?? null;
  if (revealed !== null && revealed > 0n) {
    return own
      ? { slot: `Choose your ${one}`, lead: `Choose one of your ${formatCount(revealed)} ${launch?.record.itemNoun ?? FALLBACK_MANY}`, line: 'It sits next to your wallet. Not in this app yet.' }
      : { slot: 'No companion yet', lead: 'No companion chosen', line: `Only the owner can choose one of the ${launch?.record.itemNoun ?? FALLBACK_MANY} it holds.` };
  }
  if (sealed !== null && sealed > 0n) {
    return { slot: 'After graduation', lead: 'Placeholders open at graduation', line: `Then ${withArticle(one)} can sit here.` };
  }
  return { slot: 'Empty', lead: `No ${one} held`, line: `${capitalized(withArticle(one))} held here can sit next to the wallet.` };
}

/** Whether `address` is the connected account (then the page is "My Box", else "View only"). */
export function isOwnWallet(address: string, account: string | null): boolean {
  return account !== null && sameAddress(address, account);
}
