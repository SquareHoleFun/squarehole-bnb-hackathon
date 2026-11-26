import { FIRST_ID, encodeRoyaltiesParams } from '@squarehole/box-spec';
import type { Address } from '@squarehole/domain';
import { PICK_TIME_MAX_AHEAD_SECONDS, PICK_TIME_MIN_AHEAD_SECONDS, ROYALTY_DESTINATION, ZERO_ADDRESS, MAX_UINT256, buildSpec, openAheadSeconds, parseEthText, type BuildInput } from '../create-model';
import { PROBE_OWNER, stepIssues } from '../create-checks';
import { CONTROL, MESSAGES } from '../reason-copy';
import { NATIVE_TOKEN, amountText, isDemoListing, listingFor, offeredListings, raiseOf, type SiteListing } from './listings';
import { choiceOf, eatOffered, moduleIdOf, pickFor, recipeIssues, sideOf, type RecipeCtx, type SidePick } from './recipes';
import type { AlchemistAnswer } from './alchemist';
import { encodeAbiParameters, type Hex } from 'viem';
import { BoxTypeV2, Dest, FORMAT_V2, VERSION_V2, encodeBoxSpecV2, specHashV2, type AddOnV2, type BoxSpecV2 } from './spec-types';
import type { V2StepId } from './v2-steps';
import { modelJson, pictureJson, type CommittedModel, type CommittedPicture } from './pictures';
import { shopAddOnsOf, shopConfigOf, shopIssues, shopParamsOf, type CollectionCheck, type ShopChoice, type StarterCheck } from './shop';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * A token-only box's coin pile (M3, box type PILE; S1 `PileParams`): one listed coin other than this box's own, and an
 * exact seed the creator loads after Create (the creator is the seeder, R43-M3E). The seed is typed text in the
 * coin's own decimals, parsed to raw units only through `pileSeedOf`. v2.1 step 3 adds the fixed leave-behind preset:
 * 0 (the default; a choice saved without one reads 0) or 500 basis points.
 */
export interface PileChoice {
  readonly asset: string;
  readonly seed: string;
  readonly leaveBehindBps?: LeaveBehindBps;
}
/** v2.1 step 3 (S1 `PileParamsV21.leaveBehindBps`): with 5%, each redemption but the last leaves 5% of its share in the pile. */
export type LeaveBehindBps = 0 | 500;
export const LEAVE_BEHIND_PRESETS: readonly LeaveBehindBps[] = Object.freeze([0, 500]);

export interface V2Choices {
  /** The pricing token, by address (one permanent listing). */
  readonly pricing: string;
  readonly buyers: SidePick;
  readonly sellers: SidePick;
  /** Field 31: 100, 500 or 2,500 bps; a token-only box carries 0. */
  readonly pickFeeBps: number;
  readonly deadlineDays: number;
  /** Null: no pile. Applies only to a token-only box (field 30 is empty otherwise). */
  readonly pile: PileChoice | null;
  /**
   * Null: not a shop. A shop is the Contents step's third choice (box type SHOP, shop.ts): a box with no collection of
   * its own (the token's field rules), its settings in field 30. Never together with a pile.
   */
  readonly shop: ShopChoice | null;
}

export const PICK_FEE_PRESETS: readonly number[] = Object.freeze([100, 500, 2_500]);
export const DEADLINE_DAYS_V2: readonly number[] = Object.freeze([30, 60, 90, 180]);
/** Supported non-fee add-ons; CQ11 removes every creator cap. */
const KEPT_ADD_ONS: ReadonlySet<number> = new Set([1, 3, 4, 6]);
/** Add-on 4, the collection's ERC-2981 royalty rate. */
const ROYALTIES_ADD_ON = 4;

/** Both sides receive P; Burn buys and burns the box coin after graduation. */
export const DEFAULT_V2: V2Choices = Object.freeze({
  pricing: NATIVE_TOKEN,
  buyers: pickFor('burn'),
  sellers: pickFor('burn'),
  pickFeeBps: 2_500,
  deadlineDays: 30,
  pile: null,
  shop: null,
});

/** A new pile starts in the price coin with no seed typed and no leave-behind; the creator picks the coin and the exact amount. */
export const newPile = (pricing: string): PileChoice => ({ asset: pricing, seed: '', leaveBehindBps: 0 });

/** The seed coin's listing and the seed in its raw units; null when there is no pile, the coin is off the menu or the text is not an amount. */
export function pileSeedOf(input: Pick<BuildV2Input, 'v2' | 'listings' | 'form'>): { readonly listing: SiteListing; readonly amount: bigint } | null {
  const pile = input.form.contents === 'token' && !input.v2.shop ? input.v2.pile : null;
  if (!pile) return null;
  const listing = offeredListings(input.listings).find((l) => l.token.toLowerCase() === pile.asset.toLowerCase());
  if (!listing) return null;
  const amount = parseEthText(pile.seed, listing.decimals);
  return amount === null || amount > MAX_UINT256 ? null : { listing, amount };
}

/**
 * Field 30 for a pile: abi.encode(PileParams(asset, seedAmount)), 64 bytes, with no leave-behind (so a pile chosen
 * before step 3 keeps its spec and hash); with 5%, abi.encode(PileParamsV21(asset, seedAmount, 500)), 96 bytes. Both are
 * the canonical forms the generated validator and the chain package's `pileConfigV2` read.
 */
export const pileParamsOf = (asset: string, seedAmount: bigint, leaveBehindBps: LeaveBehindBps = 0): Hex => leaveBehindBps === 0
  ? encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [asset as Address, seedAmount])
  : encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], [asset as Address, seedAmount, leaveBehindBps]);

/** A pile in another coin than the price coin: the one The Alchemist can convert fees into (v2.1 step 8). */
export function pileInOther(input: Pick<BuildV2Input, 'v2' | 'listings' | 'form'>): SiteListing | null {
  const seed = pileSeedOf(input);
  const pile = input.form.contents === 'token' && !input.v2.shop ? input.v2.pile : null;
  const coin = pile ? offeredListings(input.listings).find((l) => l.token.toLowerCase() === pile.asset.toLowerCase()) ?? seed?.listing ?? null : null;
  return coin && coin.token.toLowerCase() !== recipeCtx(input).pricing.token.toLowerCase() ? coin : null;
}

/** A pile in the box's own price coin (the only pile its fees can go to, v2.1 step 3). */
export function pileInPrice(input: Pick<BuildV2Input, 'v2' | 'listings' | 'form'>): boolean {
  const pile = input.form.contents === 'token' && !input.v2.shop ? input.v2.pile : null;
  return pile !== null && pile.asset.toLowerCase() === recipeCtx(input).pricing.token.toLowerCase();
}

export interface BuildV2Input extends BuildInput {
  readonly v2: V2Choices;
  readonly listings: readonly SiteListing[];
}

export const recipeCtx = (input: Pick<BuildV2Input, 'v2' | 'listings' | 'form'>): RecipeCtx => ({
  pricing: listingFor(input.v2.pricing, input.listings),
  listings: offeredListings(input.listings),
  ticker: input.form.ticker.trim(),
});

const pays = (pick: SidePick, dest: number) => pick.a.dest === dest || (pick.split.kind !== 'none' && pick.b.dest === dest);

/** Field 27: the typed amount in the pricing token's own decimals, held inside uint256. */
export const creatorBuyOf = (text: string, decimals: number): bigint => {
  const raw = parseEthText(text, decimals) ?? 0n;
  return raw > MAX_UINT256 ? MAX_UINT256 : raw;
};

/** A shop the choices build: a token-like box (no collection of its own) with its settings; null otherwise. */
export const shopOf = (input: Pick<BuildV2Input, 'v2' | 'form'>): ShopChoice | null => (input.form.contents === 'token' ? input.v2.shop : null);

/** The format 2 spec these choices build; always encodable, so the hash, the plan and the preview never throw. */
export function buildSpecV2(input: BuildV2Input): BoxSpecV2 {
  const { form, v2 } = input;
  const v1 = buildSpec(input);
  const ctx = recipeCtx(input);
  const token = form.contents === 'token';
  const owner = input.owner ?? ZERO_ADDRESS;
  // RC6 (F138, R53 G-J): royalties reach the box's inbox and follow its fee setup (destination 1 only); whoever
  // receives in-kind exits is the payee, so the royalty add-on always names one (the generated validator's rule).
  const royalties = !token && form.royaltyBps !== 0;
  const creator = pays(v2.buyers, Dest.Creator) || pays(v2.sellers, Dest.Creator) || royalties;
  const addOns: AddOnV2[] = v1.addOns.filter((addOn) => KEPT_ADD_ONS.has(addOn.id)).map((addOn) => addOn.id === ROYALTIES_ADD_ON
    ? { id: addOn.id, params: encodeRoyaltiesParams({ bps: form.royaltyBps, destination: ROYALTY_DESTINATION.fees }) }
    : { id: addOn.id, params: addOn.params });
  // A pile keeps every token-only field rule (S1); only its type and field 30 differ. An unparsed seed builds as 0 and
  // is refused by v2Issues, so the hash and the preview never throw. A shop keeps them too: its type, field 30 (its
  // ShopConfigV2) and its two add-ons (the collection list, and the starter set: its items' commitment) differ.
  const shop = shopOf(input);
  const pile = token && !shop ? v2.pile : null;
  const seed = pileSeedOf(input);
  return {
    format: FORMAT_V2,
    version: VERSION_V2,
    boxType: shop ? BoxTypeV2.SHOP : pile ? BoxTypeV2.PILE : token ? BoxTypeV2.TOKEN_ONLY : BoxTypeV2.NEW_COLLECTION,
    tokenName: v1.tokenName,
    tokenSymbol: v1.tokenSymbol,
    collectionName: v1.collectionName,
    collectionSymbol: v1.collectionSymbol,
    description: v1.description,
    n: v1.n,
    firstId: token ? 0n : FIRST_ID,
    pricing: { listingId: ctx.pricing.id, token: ctx.pricing.token },
    raise: raiseOf(ctx.pricing),
    layout: v1.layout,
    gradLayout: 3,
    launchFormat: v1.launchFormat,
    openAt: v1.openAt,
    deadlineDays: v2.deadlineDays,
    buyers: sideOf(v2.buyers),
    sellers: sideOf(v2.sellers),
    artMode: v1.artMode,
    revealRoot: v1.revealRoot,
    metadataTable: v1.metadataTable as `0x${string}`,
    generatorHash: v1.generatorHash,
    coverSha256: v1.coverSha256,
    revealListId: v1.revealListId,
    marketplaceOwner: v1.marketplaceOwner,
    creatorFeeRecipient: creator ? owner : ZERO_ADDRESS,
    creatorBuy: creatorBuyOf(form.firstIn, ctx.pricing.decimals),
    collectionCoverSha256: v1.collectionCoverSha256,
    addOns: shop ? [...addOns, ...shopAddOnsOf(shop)].sort((a, b) => a.id - b.id) : addOns,
    contentsParams: shop ? shopParamsOf(shopConfigOf(shop, input.owner ?? null))
      : pile ? pileParamsOf(seed?.listing.token ?? pile.asset, seed?.amount ?? 0n, pile.leaveBehindBps === 500 ? 500 : 0) : '0x',
    pickFeeBps: token ? 0 : v2.pickFeeBps,
  };
}

/** What a Demo run played: its spec's hash, the clock that spec was built at, and its pricing listing. */
export interface Played {
  readonly hash: string;
  readonly listingId: number;
  readonly atMs: number;
}

/**
 * Whether a Demo run is still the page's (review round 3): the choices, built at the run's own clock, give the spec it
 * played, priced in the listing it played. An edit, another token or listing, or a box token's raise read after its
 * listing ends it; the clock alone never does (a preset open time follows the clock, so it is built at the run's).
 */
export const stillPlayed = (played: Played, input: BuildV2Input): boolean =>
  recipeCtx(input).pricing.id === played.listingId && specHashV2(buildSpecV2({ ...input, nowMs: played.atMs })) === played.hash;

export const DEMO_FILE_NOTE = 'Built from sample listings. Not for a chain.';

/** What the BoxSpec file carries beside the spec (F-1): the committed pictures' and models' bytes and open art's public reveal list. */
export interface BoxSpecFileExtras {
  /** Every picture the spec commits (pictures.ts `committedPictures`): the logo, a collection's cover, banner and teasers, each item picture. */
  readonly pictures?: readonly CommittedPicture[];
  /** R74-ART: every 3D model the art commits (pictures.ts `committedModels`); none: the file has no `models` list, as before. */
  readonly models?: readonly CommittedModel[];
  /** Open art's reveal list (create-model `revealList`), public at creation; hidden art's stays in its reveal file. */
  readonly revealList?: unknown;
}

/**
 * Download BoxSpec's file around its pictures: the name, the JSON up to the `pictures` list and the JSON after it. It is
 * labelled Demo while anything it was built from is Demo data (`CLAUDE.md`): the pricing listing, or another listing on
 * the menu. The label rides in the rows. Open art's reveal list closes it. R74-ART: with `models` (art that commits 3D
 * models), `models` is what goes between the pictures and the models (`"models": [`, its entries typed GLBs); without,
 * it is null and the file is byte for byte as before.
 */
export function boxSpecFrame(spec: BoxSpecV2, ctx: Pick<RecipeCtx, 'pricing' | 'listings'>, revealList: unknown = null, models = false): { readonly name: string; readonly head: string; readonly models: string | null; readonly tail: string } {
  const demo = DEMO_BUILD && (isDemoListing(ctx.pricing) || ctx.listings.some(isDemoListing));
  const body = { format: 'squarehole.boxspec/2', ...(demo ? { demo: true, note: DEMO_FILE_NOTE } : {}), specHash: specHashV2(spec), encoded: encodeBoxSpecV2(spec), spec };
  const name = `${spec.tokenSymbol.replace(/[^A-Za-z0-9]+/g, '').toLowerCase() || 'box'}-boxspec-v2.json`;
  const json = JSON.stringify(body, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2);
  const reveal = JSON.stringify(revealList ?? null, null, 2).replace(/\n/g, '\n  ');
  return { name, head: `${json.slice(0, -2)},\n  "pictures": [\n`, models: models ? '\n  ],\n  "models": [\n' : null, tail: `\n  ],\n  "revealList": ${reveal}\n}\n` };
}

/** One picture's entry in the file's `pictures` list; `first` has no separator before it. */
export const picturePart = (picture: CommittedPicture, first: boolean): string => `${first ? '' : ',\n'}    ${JSON.stringify(pictureJson(picture))}`;
/** R74-ART: one model's entry in the file's `models` list; `first` has no separator before it. */
export const modelPart = (model: CommittedModel, first: boolean): string => `${first ? '' : ',\n'}    ${JSON.stringify(modelJson(model))}`;

/**
 * Download BoxSpec's file: as v1's file does, it carries the bytes of every picture the spec commits (F-1: another
 * browser cannot re-encode the logo, cover, banner and teasers byte for byte) and open art's reveal list; R74-ART: and
 * every 3D model its art commits. The parts concatenate to one JSON document; each picture and model is its own part, so
 * a large collection's files never become one string (the page builds the same parts one file at a time, CreateV2Flow
 * `downloadSpec`).
 */
export function boxSpecFile(spec: BoxSpecV2, ctx: Pick<RecipeCtx, 'pricing' | 'listings'>, extras: BoxSpecFileExtras = {}): { readonly name: string; readonly parts: readonly string[] } {
  const models = extras.models ?? [];
  const frame = boxSpecFrame(spec, ctx, extras.revealList ?? null, models.length > 0);
  return {
    name: frame.name,
    parts: [frame.head, ...(extras.pictures ?? []).map((picture, i) => picturePart(picture, i === 0)), ...(frame.models === null ? [] : [frame.models, ...models.map((model, i) => modelPart(model, i === 0))]), frame.tail],
  };
}

export interface V2Issue {
  readonly step: V2StepId;
  /** The control the message belongs to (its element id). */
  readonly control: string;
  readonly message: string;
  /** box-spec-v2-draft.md § 7's reason, for the recipe rules. */
  readonly reason?: string;
}

/** v2.1 step 8: The Alchemist converts into a coin pile in another coin, through a row the page resolved (alchemist.ts). */
export const ALCHEMIST_NEEDS_PILE = 'The Alchemist needs a coin pile in another coin.';
export const ALCHEMIST_CHECKING = 'Checking the Alchemist’s route.';
export const ALCHEMIST_UNCHECKED = 'The Alchemist’s route could not be read. Try again later.';
export const alchemistNoRoute = (price: string, pile: string): string => `No checked Alchemist route from ${price} to ${pile}.`;
/** v2.1 step 7 (R48A/D): Into the shop takes the sellers' fees of a shop box, never the buyers' and never another box's. */
export const SHOP_FEES_SELLERS_ONLY = 'Into the shop takes the sellers’ fees only.';
export const SHOP_FEES_NEED_SHOP = 'Into the shop needs a shop.';
/** The factory refuses eating this coin (V21-MONEY-01): a box coin whose listing records no checked burn. */
export const EAT_REFUSED = (symbol: string): string => `${symbol} is a box coin with no checked burn, so it cannot be eaten.`;
/** The factory's answer is not in yet, or its read failed. */
export const EAT_UNCHECKED = (symbol: string): string => `Checking whether ${symbol} can be eaten.`;

export const V2_CONTROL = Object.freeze({ pricing: 'create-v2-pricing', buyers: 'create-v2-buyers', sellers: 'create-v2-sellers', pickFee: 'create-v2-pick-fee', pile: 'create-v2-pile', pileCoin: 'create-v2-pile-coin', pileSeed: 'create-v2-pile-seed', pileLeave: 'create-v2-pile-leave' });

/** Every check of the page, by step, in step order; the Overview's own (owner, reveal file) are the Create action's. */
export function v2Issues(input: BuildV2Input & {
  readonly revealSaved?: boolean;
  readonly shopChecks?: ReadonlyMap<string, CollectionCheck | 'unknown'>;
  /** A shop's starter items as the chain answered for the connected wallet (shop-checks.ts `useStarterChecks`). */
  readonly starterChecks?: ReadonlyMap<string, StarterCheck | 'unknown'>;
  readonly alchemist?: AlchemistAnswer;
}): V2Issue[] {
  const { form, v2 } = input;
  const gate = { ...input, owner: input.owner ?? PROBE_OWNER, revealSaved: input.revealSaved ?? false };
  const v1 = (step: 'basics' | 'contents', to: V2StepId): V2Issue[] => stepIssues(step, gate).map((issue) => ({ step: to, control: issue.control, message: issue.message }));
  const ctx = recipeCtx(input);
  const issues: V2Issue[] = [...v1('basics', 'v2-basics'), ...v1('contents', 'v2-contents')];
  if (!offeredListings(input.listings).some((l) => l.token.toLowerCase() === v2.pricing.toLowerCase())) issues.push({ step: 'v2-basics', control: V2_CONTROL.pricing, message: 'Choose a current price coin.' });
  if (form.contents === 'collection' && !PICK_FEE_PRESETS.includes(v2.pickFeeBps)) issues.push({ step: 'v2-contents', control: V2_CONTROL.pickFee, message: MESSAGES.pickOption });
  const shop = shopOf(input);
  if (form.contents === 'token' && v2.pile && !shop) {
    const coin = offeredListings(input.listings).find((l) => l.token.toLowerCase() === v2.pile?.asset.toLowerCase());
    if (!coin) issues.push({ step: 'v2-contents', control: V2_CONTROL.pileCoin, message: 'Choose a current seed coin.' });
    else if (pileSeedOf(input) === null) issues.push({ step: 'v2-contents', control: V2_CONTROL.pileSeed, message: `Use a number like 1000, up to ${coin.decimals} decimals` });
    const leave = v2.pile.leaveBehindBps;
    if (leave !== undefined && !LEAVE_BEHIND_PRESETS.includes(leave)) issues.push({ step: 'v2-contents', control: V2_CONTROL.pileLeave, message: MESSAGES.pickOption });
  }
  // A shop's own checks (shop.ts), each with its step's: at Contents, the first buy at Opening, the curator's wallet last.
  const shopList = shop ? shopIssues(shop, { owner: input.owner ?? null, ticker: form.ticker.trim(), firstIn: parseEthText(form.firstIn, ctx.pricing.decimals), priceSymbol: ctx.pricing.symbol, checks: input.shopChecks, starterChecks: input.starterChecks }) : [];
  const shopAt = (step: V2StepId) => shopList.filter((issue) => issue.step === step);
  issues.push(...shopAt('v2-contents'));
  for (const issue of recipeIssues(v2.buyers, v2.sellers)) issues.push({ step: 'v2-fees', control: V2_CONTROL[issue.side], message: issue.message, reason: issue.reason });
  // S1: items pay every item of the box's own new collection, so a token-only box or a pile cannot choose them, in P
  // or in T. v2.1 step 3: fees go only to a coin pile in the box's own price coin. V21-MONEY-01: Eat only where the
  // factory allows it (a box coin needs a checked burn). v2.1 step 7 (R48A/D): Into the shop only on a shop's sellers.
  const pricing = recipeCtx(input).pricing;
  for (const side of ['buyers', 'sellers'] as const) {
    const choice = choiceOf(v2[side]);
    if ((choice === 'items' || choice === 'items-t') && form.contents !== 'collection') issues.push({ step: 'v2-fees', control: V2_CONTROL[side], message: 'To items needs a new collection.' });
    if (choice === 'pile' && !pileInPrice(input)) issues.push({ step: 'v2-fees', control: V2_CONTROL[side], message: 'To the pile needs a coin pile in the price coin.' });
    if (choice === 'shop' && side === 'buyers') issues.push({ step: 'v2-fees', control: V2_CONTROL[side], message: SHOP_FEES_SELLERS_ONLY });
    else if (choice === 'shop' && !shop) issues.push({ step: 'v2-fees', control: V2_CONTROL[side], message: SHOP_FEES_NEED_SHOP });
    // v2.1 step 8: only a row the page resolved for exactly this price coin and pile coin; never a guessed id.
    if (choice === 'alchemist') {
      const other = pileInOther(input); const answer = input.alchemist ?? { state: 'off' as const };
      const message = !other ? ALCHEMIST_NEEDS_PILE : answer.state === 'checking' ? ALCHEMIST_CHECKING : answer.state === 'failed' ? ALCHEMIST_UNCHECKED
        : answer.state === 'ready' && answer.rows.some((row) => row.id === moduleIdOf(v2[side])) ? null : alchemistNoRoute(pricing.symbol, other.symbol);
      if (message) issues.push({ step: 'v2-fees', control: V2_CONTROL[side], message });
    }
    if (choice === 'eat' && !eatOffered(pricing)) {
      issues.push({ step: 'v2-fees', control: V2_CONTROL[side], message: pricing.eat === 'refused' ? EAT_REFUSED(pricing.symbol) : EAT_UNCHECKED(pricing.symbol) });
    }
  }
  if (!DEADLINE_DAYS_V2.includes(v2.deadlineDays)) issues.push({ step: 'v2-raise', control: CONTROL.deadline, message: MESSAGES.pickOption });
  if (form.open.kind === 'time') {
    const ahead = openAheadSeconds(form.open, input.nowMs);
    const message = !Number.isFinite(ahead) ? MESSAGES.pickTime : ahead < PICK_TIME_MIN_AHEAD_SECONDS ? MESSAGES.openSoon : ahead > PICK_TIME_MAX_AHEAD_SECONDS ? MESSAGES.openTime : null;
    if (message) issues.push({ step: 'v2-opening', control: CONTROL.openTime, message });
  }
  const first = parseEthText(form.firstIn, ctx.pricing.decimals);
  const raise = raiseOf(ctx.pricing);
  // The same fixed listing raise constrains every pricing coin.
  if (first === null) issues.push({ step: 'v2-opening', control: CONTROL.firstIn, message: 'Use a number like 0.05' });
  else if (first !== 0n && first >= raise) issues.push({ step: 'v2-opening', control: CONTROL.firstIn, message: `Below the raise: less than ${amountText(raise, ctx.pricing)}` });
  issues.push(...shopAt('v2-opening'));
  if (!form.rights) issues.push({ step: 'v2-opening', control: CONTROL.rights, message: MESSAGES.rights });
  issues.push(...shopAt('v2-overview'));
  return issues;
}
