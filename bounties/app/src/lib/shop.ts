/**
 * SH-288: a card shop for a token launched on Flap or Four.meme (bounties/core RailShop, one per token, made by
 * RailShopFactory; nothing changes after creation). Everything is read from the shop's own views: no log scan, except
 * the factory's ShopCreated events to find the shops of a token. A page shows a shop only when the factory says it
 * made it (`isShop`).
 */
import { zeroAddress, type Address, type PublicClient } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import { cardsAbi, shopAbi, shopFactoryAbi } from '../abi/shop';
import { coinLabel, type AppConfig } from './config';
import { nativeSymbol } from './chain';
import { readEvents } from './logs';
import { decodeError } from './errors';
import { rulesVaultFactoryAbi } from '../abi/flap';
import { payeesOf } from './rules';
import { flapOriginOf } from './flap-origin';
import { readLaunchEvents, rulesLauncherIn } from './launch-events';

/** The most cards the page lists at once (the shop keeps its list; the page reads one window of it). */
export const CARDS_SHOWN = 120n;

export interface ShopCollection {
  nft: Address;
  name: string | null;
  givePrice: bigint;
  pickPrice: bigint;
}

export interface ShopInfo {
  shop: Address;
  token: Address;
  asset: Address;
  router: Address;
  creator: Address;
  pickBps: number;
  weeklyCap: bigint;
  collections: ShopCollection[];
  /** The token has code: before that, stock and refill are refused (TokenNotLive) and nothing can be swapped. */
  tokenLive: boolean;
  tokenSymbol: string;
  tokenDecimals: number;
  assetSymbol: string;
  assetDecimals: number;
}

export interface ShopCardRef {
  nft: Address;
  id: bigint;
}

export interface ShopNow {
  budget: bigint;
  waiting: bigint;
  capLeft: bigint;
  periodEnds: bigint;
  cardCount: bigint;
  /** The cards the shop's list names and still owns (a card it no longer owns is never offered for a pick). */
  cards: ShopCardRef[];
  /** The visitor's token balance and allowance to the shop, when a wallet is connected. */
  balance?: bigint;
  allowance?: bigint;
}

/**
 * A shop of our factory, or why there is none: no factory in the deployment file, no contract at the address yet (a
 * launch's rules can name a shop before it is created), or a contract our factory did not make.
 */
export type ShopLookup = { kind: 'ours'; info: ShopInfo } | { kind: 'no-factory' } | { kind: 'not-created' } | { kind: 'not-ours' };

export async function readShopInfo(c: PublicClient, config: AppConfig, shop: Address): Promise<ShopLookup> {
  const factory = config.shops?.factory;
  if (!factory) return { kind: 'no-factory' };
  const ours = await c.readContract({ address: factory, abi: shopFactoryAbi, functionName: 'isShop', args: [shop] });
  if (!ours) {
    const code = await c.getCode({ address: shop });
    return code === undefined || code === '0x' ? { kind: 'not-created' } : { kind: 'not-ours' };
  }
  const [token, asset, router, creator, pickBps, weeklyCap, count] = await Promise.all([
    c.readContract({ address: shop, abi: shopAbi, functionName: 'token' }),
    c.readContract({ address: shop, abi: shopAbi, functionName: 'asset' }),
    c.readContract({ address: shop, abi: shopAbi, functionName: 'router' }),
    c.readContract({ address: shop, abi: shopAbi, functionName: 'creator' }),
    c.readContract({ address: shop, abi: shopAbi, functionName: 'pickBps' }),
    c.readContract({ address: shop, abi: shopAbi, functionName: 'weeklyCap' }),
    c.readContract({ address: shop, abi: shopAbi, functionName: 'collectionCount' }),
  ]);
  const collections = await Promise.all(Array.from({ length: Number(count > 4n ? 4n : count) }, async (_, i) => {
    const [nft, givePrice, pickPrice] = await c.readContract({ address: shop, abi: shopAbi, functionName: 'collection', args: [BigInt(i)] });
    const name = await c.readContract({ address: nft, abi: cardsAbi, functionName: 'name' }).then((n) => (n.trim() === '' ? null : n), () => null);
    return { nft, name, givePrice, pickPrice };
  }));
  // A launch's rules can name a shop before its token exists: then the token has no code and no name yet.
  const tokenCode = await c.getCode({ address: token });
  const tokenLive = tokenCode !== undefined && tokenCode !== '0x';
  const [tokenSymbol, tokenDecimals] = tokenLive
    ? await Promise.all([
        c.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      ])
    : [`${token.slice(0, 6)}…${token.slice(-4)}`, 18];
  let assetSymbol = nativeSymbol();
  let assetDecimals = 18;
  if (asset !== zeroAddress) {
    const [s, d] = await Promise.all([
      c.readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' }),
      c.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    assetSymbol = coinLabel(config, asset, s);
    assetDecimals = d;
  }
  return { kind: 'ours', info: { shop, token, asset, router, creator, pickBps: Number(pickBps), weeklyCap, collections, tokenLive, tokenSymbol, tokenDecimals, assetSymbol, assetDecimals } };
}

export async function readShopNow(c: PublicClient, info: ShopInfo, account?: Address): Promise<ShopNow> {
  const shop = info.shop;
  const r = (functionName: 'budget' | 'waiting' | 'capLeft' | 'periodEnds' | 'cardCount') => c.readContract({ address: shop, abi: shopAbi, functionName });
  const [budget, waiting, capLeft, periodEnds, cardCount] = await Promise.all([r('budget'), r('waiting'), r('capLeft'), r('periodEnds'), r('cardCount')]);
  const [nfts, ids] = cardCount === 0n ? [[], []] : await c.readContract({ address: shop, abi: shopAbi, functionName: 'cards', args: [0n, cardCount < CARDS_SHOWN ? cardCount : CARDS_SHOWN] });
  const listed = nfts.map((nft, i) => ({ nft, id: ids[i] ?? 0n }));
  // A listed card the shop no longer owns (its collection moved it) is not offered: anyone may drop it from the list.
  const owners = await Promise.all(listed.map((card) => c.readContract({ address: card.nft, abi: cardsAbi, functionName: 'ownerOf', args: [card.id] }).catch(() => null)));
  const cards = listed.filter((_, i) => owners[i]?.toLowerCase() === shop.toLowerCase());
  let balance: bigint | undefined;
  let allowance: bigint | undefined;
  if (account && info.tokenLive) {
    [balance, allowance] = await Promise.all([
      c.readContract({ address: info.token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      c.readContract({ address: info.token, abi: erc20Abi, functionName: 'allowance', args: [account, shop] }),
    ]);
  }
  return { budget, waiting, capLeft, periodEnds, cardCount, cards, balance, allowance };
}

/**
 * The token's shops a launch's page links to. Anyone may make a shop for any token, and the factory's list per token is
 * open: it is never paged through. Shown: the shops the launch's rules name as a payee (read from the rules on chain by
 * the caller), each one our factory made for this token; where no rule names one, only the shops the launch's own
 * creator (as the rail's contracts say) made for it (`shopOfBy`). Never a shop by anyone else. None without a factory.
 */
export async function linkedShops(c: PublicClient, config: AppConfig, token: Address, launch: { payees?: readonly Address[] | null; creator?: Address | null }): Promise<Address[]> {
  const factory = config.shops?.factory;
  if (!factory) return [];
  const named: Address[] = [];
  for (const payee of launch.payees ?? []) {
    const ours = await c.readContract({ address: factory, abi: shopFactoryAbi, functionName: 'isShop', args: [payee] });
    if (!ours) continue;
    const forToken = await c.readContract({ address: payee, abi: shopAbi, functionName: 'token' });
    if (forToken.toLowerCase() === token.toLowerCase()) named.push(payee);
  }
  if (named.length > 0 || !launch.creator) return named;
  const creator = launch.creator;
  const count = await c.readContract({ address: factory, abi: shopFactoryAbi, functionName: 'shopCountBy', args: [token, creator] });
  const n = count > 20n ? 20n : count;
  return Promise.all(Array.from({ length: Number(n) }, (_, i) => c.readContract({ address: factory, abi: shopFactoryAbi, functionName: 'shopOfBy', args: [token, creator, BigInt(i)] })));
}

/**
 * The cards of the shop's collections the wallet holds now (SH-288 STEP 2: select one and hand it in). Found from the
 * collections' own Transfer events to the wallet (one query for all of them, at most four addresses, read in windows
 * from the deployment's first block and kept for the visit: lib/logs.ts), each checked with `ownerOf` now. A failed
 * read throws (never "no cards").
 */
export async function ownCardsOf(c: PublicClient, config: AppConfig, info: Pick<ShopInfo, 'collections'>, wallet: Address): Promise<ShopCardRef[]> {
  const collections = info.collections.map((x) => x.nft).slice(0, 4);
  if (collections.length === 0) return [];
  type Moved = { address: Address; args: { tokenId?: bigint } };
  const logs = await readEvents<Moved>(c, { address: collections, abi: cardsAbi, eventName: 'Transfer', args: { to: wallet }, fromBlock: BigInt(config.fromBlock) });
  const seen = new Map<string, ShopCardRef>();
  // Each card under its collection's address as the shop lists it (a log's address comes in lower case).
  const listed = new Map(collections.map((nft) => [nft.toLowerCase(), nft]));
  for (const l of logs) {
    const nft = listed.get(l.address.toLowerCase());
    if (nft && l.args.tokenId !== undefined) seen.set(`${nft.toLowerCase()}:${l.args.tokenId}`, { nft, id: l.args.tokenId });
  }
  const candidates = [...seen.values()];
  // A card's `ownerOf` that reverts (a burned card) is an answer: not the wallet's. Any other failure fails the read.
  const owners = await Promise.all(candidates.map((card) => c.readContract({ address: card.nft, abi: cardsAbi, functionName: 'ownerOf', args: [card.id] }).catch((e: unknown) => {
    if (decodeError(e).name === 'unknown') throw e;
    return null;
  })));
  return candidates.filter((_, i) => owners[i]?.toLowerCase() === wallet.toLowerCase());
}

/**
 * Who created a Flap sale, when one of the deployment file's launcher factories made it (SH-303: proven from the sale
 * and the factory, lib/flap-origin.ts, instead of scanning the factories' creation events), or null.
 */
export async function flapCreatorOf(c: PublicClient, config: AppConfig, launcher: Address): Promise<Address | null> {
  if (!config.flap) return null;
  return (await flapOriginOf(c, config, launcher))?.creator ?? null;
}

/**
 * The Flap rules sale that launched `token` (SH-281 step 3): our rules vault factories' `RulesVaultCreated(token, …,
 * launcher)` for it, from the deployment file's rules pairs; null without one. The caller still proves the sale with
 * `flapCreatorOf` (our launcher factory's own creation event).
 */
export async function flapRulesLauncherOf(c: PublicClient, config: AppConfig, token: Address): Promise<Address | null> {
  if (!config.flap?.rules) return null;
  // SH-303: from the tab's one scan of the creation events (lib/launch-events.ts)
  return rulesLauncherIn(await readLaunchEvents(c, config), config, token) ?? null;
}

/**
 * The addresses a Flap rules sale's rules pay (CREATOR rules' targets, in rule order): `rulesOf(launcher)` at the
 * deployment file's rules vault factory (the rules stored before the sale; the factory's record, not the sale's own
 * word). An empty list means the rules named no payees. A failed read returns null.
 */
export async function flapRulesPayees(c: PublicClient, rulesVaultFactory: Address, launcher: Address): Promise<Address[] | null> {
  try {
    const rules = (await c.readContract({ address: rulesVaultFactory, abi: rulesVaultFactoryAbi, functionName: 'rulesOf', args: [launcher] })) as readonly { kind: number; target: Address }[];
    return payeesOf(rules.map((x) => ({ kind: Number(x.kind), target: x.target })));
  } catch {
    return null;
  }
}

/** Why a give cannot be paid now (the shop's own refusals, read before the press), or null. */
export function giveBlock(now: Pick<ShopNow, 'budget' | 'capLeft'>, givePrice: bigint): 'budget' | 'cap' | null {
  if (now.budget < givePrice) return 'budget';
  if (now.capLeft < givePrice) return 'cap';
  return null;
}

/**
 * Who made a shop, against who launched its token: 'launch' (the same address), 'other' (another), 'unknown' (the
 * page cannot tell who launched the token, or has not read it yet).
 */
export function makerOf(shopCreator: Address, launchCreator: Address | null | undefined): 'launch' | 'other' | 'unknown' {
  if (!launchCreator) return 'unknown';
  return shopCreator.toLowerCase() === launchCreator.toLowerCase() ? 'launch' : 'other';
}

/** The cards stat: what the grid shows (listed and owned), how many are listed, and whether the list is longer than read. */
export function cardsLine(now: Pick<ShopNow, 'cards' | 'cardCount'>): { shown: bigint; listed: bigint; more: boolean } {
  return { shown: BigInt(now.cards.length), listed: now.cardCount, more: now.cardCount > CARDS_SHOWN };
}

const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** A chain time (seconds) as "3 Dec, 03:51 UTC". */
export const utcWhen = (seconds: bigint): string => `${DATE.format(new Date(Number(seconds) * 1000))} UTC`;

/** Why the chosen card cannot be given now, in words; the room's refusal says when the room renews (`periodEnds()`). */
export function giveRefusal(block: 'budget' | 'cap' | null, periodEnds: bigint): string | null {
  if (block === 'budget') return 'The shop’s budget is too small for this card.';
  if (block === 'cap') return `This week’s room for gives is too small for this card${periodEnds > 0n ? `; the room renews ${utcWhen(periodEnds)}` : ''}.`;
  return null;
}

/**
 * What the give side shows for the wallet's own cards: the way to connect, nothing while the first read runs, the read's
 * failure (never "no cards"), one line for a wallet holding none of these collections, or the tiles.
 */
export function ownGroup(account: string | undefined, read: { state: 'loading' } | { state: 'error' } | { state: 'ok'; count: number }): 'connect' | 'reading' | 'failed' | 'none' | 'cards' {
  if (!account) return 'connect';
  if (read.state === 'loading') return 'reading';
  if (read.state === 'error') return 'failed';
  return read.count > 0 ? 'cards' : 'none';
}

/** The contract's pick price for a give price: the give price plus its part in basis points, rounded up. */
export const pickPriceOf = (givePrice: bigint, pickBps: number): bigint => givePrice + (givePrice * BigInt(pickBps) + 9_999n) / 10_000n;

export const cardKey = (c: ShopCardRef): string => `${c.nft.toLowerCase()}:${c.id}`;
