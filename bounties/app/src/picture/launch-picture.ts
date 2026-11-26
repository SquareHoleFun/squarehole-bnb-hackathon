/**
 * SH-281: a launch drawn as a picture, in the platform's Visual way (apps/web/src/features/box-picture/picture.ts is
 * the model this follows: one fixed layout, every part a control, every number from the form). Pure: no React, no DOM.
 * The picture says only what the launch does; each part's source in the launch's code is named where it is built.
 */
import type { Address } from 'viem';
import { formatAmount, parseAmount, parsePercentToBps } from '../lib/amounts';
import { CREATE_DEFAULTS, readCreateForm, type CreateForm } from '../lib/flap';
import { FOUR_DEFAULTS, readFourForm, type FourForm } from '../lib/four-create';
import type { RulesField, RulesForm } from '../lib/rules';

/** The parts that are controls, in reading order. Each opens its own sheet of fields. */
export type PartId = 'token' | 'buyers' | 'sellers' | 'raise' | 'price' | 'deadline' | 'creator' | 'tax' | 'pile' | 'pool' | 'holders' | 'shop';

export type CellKind = 'burn' | 'creator' | 'pile' | 'holders' | 'shop' | 'buyburn';

/**
 * 10 cells: `burnCells` burned, the rest shared by the parts (basis points of the rest), in the order creator, pile,
 * buy back. A part above 0 gets at least one cell while there are cells enough (else the largest parts get one each);
 * the others follow the largest remainder. A part at 0 gets none.
 */
export function cellsOf(burnCells: number, parts: { creator: number; pile: number; burn: number; holders?: number; shop?: number } | null): CellKind[] {
  const rest = 10 - burnCells;
  const burned: CellKind[] = Array.from({ length: burnCells }, () => 'burn' as const);
  if (!parts) return [...burned, ...Array.from({ length: rest }, () => 'pile' as const)];
  const order = [
    { kind: 'creator' as const, bps: parts.creator },
    { kind: 'pile' as const, bps: parts.pile },
    // SH-321 (a launched token's page): rules paying the holders' stake or a card shop, each its own colour
    { kind: 'holders' as const, bps: parts.holders ?? 0 },
    { kind: 'shop' as const, bps: parts.shop ?? 0 },
    { kind: 'buyburn' as const, bps: parts.burn },
  ].filter((x) => x.bps > 0);
  const ideal = (bps: number) => (rest * bps) / 10_000;
  const n = new Map<CellKind, number>(order.map((x) => [x.kind, 0]));
  if (order.length > rest) {
    [...order].sort((a, b) => b.bps - a.bps).slice(0, rest).forEach((x) => n.set(x.kind, 1));
  } else {
    for (const x of order) n.set(x.kind, Math.max(1, Math.floor(ideal(x.bps))));
    const total = () => [...n.values()].reduce((a, b) => a + b, 0);
    while (total() > rest) {
      const over = order.filter((x) => n.get(x.kind)! > 1).sort((a, b) => n.get(b.kind)! - ideal(b.bps) - (n.get(a.kind)! - ideal(a.bps)))[0]!;
      n.set(over.kind, n.get(over.kind)! - 1);
    }
    while (total() < rest) {
      const under = [...order].sort((a, b) => ideal(b.bps) - n.get(b.kind)! - (ideal(a.bps) - n.get(a.kind)!))[0]!;
      n.set(under.kind, n.get(under.kind)! + 1);
    }
  }
  const run = (k: CellKind) => Array.from({ length: n.get(k) ?? 0 }, () => k);
  return [...burned, ...run('creator'), ...run('pile'), ...run('holders'), ...run('shop'), ...run('buyburn')];
}

export interface FrontSlot {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
}

export interface LaunchPicture {
  /** Above the token coin: the symbol, or "Token" while it has none. */
  readonly ticker: string;
  /** Under the buyers' and the sellers' figures: what each trade pays. */
  readonly buyers: readonly string[];
  readonly sellers: readonly string[];
  /** The box's front: the raise on the left, the deadline on the right (none on a rail without one). */
  readonly front: { readonly left: FrontSlot; readonly right: FrontSlot | null };
  /** Under the coin in the box's socket: what the sale is paid in. */
  readonly coin: string;
  /** Under the creator: what the creator sends. */
  readonly creator: readonly string[];
  /** Of each tray's 10 cells, how many go to the burn station (the rest to the pile). */
  readonly burnCells: number;
  /**
   * Each tray's 10 cells, in order: what is burned at once, then the creator's rules over the rest (SH-287): the
   * creator's, the pile's, the buy back and burn's. Without rules: the burned ones, then the pile's.
   */
  readonly cells: readonly CellKind[];
  /** On the creator's star: the creator's part (SH-287), or null. */
  readonly creatorTag: string | null;
  /** Under the tag, what the part is of ("of the rest" on Flap, where the burned share is taken first), or null. */
  readonly creatorTagOf: string | null;
  /** The burn station's lines; null: nothing is burned on this rail. */
  readonly burn: readonly string[] | null;
  /** The pile station's lines. */
  readonly pile: readonly string[];
  /** Between the trays: how long the trays run. */
  readonly center: readonly string[];
  /** The pool and its number. */
  readonly pool: { readonly label: string; readonly number: string };
  /** Each part's accessible name (its words), in reading order. */
  readonly parts: readonly { readonly id: PartId; readonly name: string }[];
  /** Parts with a problem: marked, and the first one opens when Create is pressed. */
  readonly warn: readonly PartId[];
  /** SH-319, a launched token's page: the holders' stake over the holders (their own part when `parts` names it). */
  readonly holdersTag?: string | null;
  /** SH-321: the lines under the holders when a rule pays their stake ("Holders 40%", "sent 6.8"); else just "Holders". */
  readonly holdersLines?: readonly string[] | null;
  /** SH-319, a launched token's page: the card shop's lines (its own part when `parts` names it). */
  readonly shop?: readonly string[] | null;
}

/** The picture's own words (the platform's where it has them: picture-words.ts). */
export const WORDS = Object.freeze({
  hint: 'Tap a part to change it.',
  token: 'Token',
  buys: 'Buys',
  sells: 'Sells',
  creator: 'Creator',
  holders: 'Holders',
  pool: 'Pool',
  target: 'Target',
  deadline: 'Deadline',
  hours: 'hours',
  burned: 'Burned',
  pile: 'Pile',
  close: 'Close',
});

/* ── Flap ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Which part holds each field of Flap's form (FlapCreate's sheets). */
export const FLAP_FIELD_PART: Readonly<Record<keyof CreateForm, PartId>> = Object.freeze({
  name: 'token',
  symbol: 'token',
  target: 'raise',
  saleTokens: 'raise',
  virtualBnb: 'raise',
  durationHours: 'deadline',
  tradeFee: 'buyers',
  buyTax: 'buyers',
  sellTax: 'sellers',
  burnShare: 'tax',
  taxDays: 'tax',
});

/** The reading order: the page's own order of the parts (left to right, top to bottom; LaunchPictureSvg draws them so). */
const FLAP_ORDER: readonly PartId[] = ['buyers', 'token', 'sellers', 'creator', 'raise', 'price', 'deadline', 'tax', 'pool', 'pile'];

/**
 * Every field's own refusal (readCreateForm's words), not only the first: each field is read with the others at the
 * entry's defaults; the sell tax with the buy tax as typed when that one reads (the rule "not both 0" is the sell tax's).
 */
export function flapRefusals(form: CreateForm, quoteDecimals: number): Partial<Record<keyof CreateForm, string>> {
  const out: Partial<Record<keyof CreateForm, string>> = {};
  for (const key of Object.keys(FLAP_FIELD_PART) as (keyof CreateForm)[]) {
    const probe: CreateForm = { ...CREATE_DEFAULTS, [key]: form[key] };
    // The sell tax is read with the buy tax as typed when that one reads (the rule "not both 0"), else the default.
    if (key === 'sellTax' && readCreateForm({ ...CREATE_DEFAULTS, buyTax: form.buyTax }, quoteDecimals).ok) probe.buyTax = form.buyTax;
    const r = readCreateForm(probe, quoteDecimals);
    if (!r.ok && r.refusal.field === key) out[key] = r.refusal.text;
  }
  return out;
}

export interface FlapPictureInput {
  readonly form: CreateForm;
  /** What the sale is paid in, as the page names it ("USDT (test)", "BNB"), and its decimals. */
  readonly symbol: string;
  readonly decimals: number;
  readonly refusals: Partial<Record<keyof CreateForm, string>>;
  /** The Portal's salt lock fee the creator sends (factory `creationFee()`), shown; undefined while it is read. */
  readonly fee?: string;
  /** The factory refuses the target (below the Portal's floor, or `curveFor` refused it). */
  readonly raiseProblem: boolean;
  /** The factory's `checkConfig` refused the settings for another reason (shown on the creator's part). */
  readonly checkProblem: boolean;
  /** SH-287: the creator's rules, where this rail's deployment has them (none: today's picture). */
  readonly rules?: { readonly form: RulesForm; readonly refusals: Partial<Record<RulesField, string>> };
  /** The token-quote factory's coin is not the one shown. */
  readonly coinProblem: boolean;
}

/** A percent as typed, for the picture ("3%"), or "?" when the field has a problem. */
const pct = (text: string, bad: boolean): string => (bad ? '?' : `${text.trim()}%`);

/**
 * Flap's launch (bounties/flap: CurveLauncherFactory.createLauncher / Portal.newLauncher, CurveLauncher). The sources:
 * - token: CurveConfig.name, .symbol (the Portal's tax token).
 * - buyers, sellers: CurveConfig.tradeFeeBps (every curve trade, CurveLauncher._buy and sell; kept apart in feePot) and
 *   .buyTaxBps, .sellTaxBps (the tax token's tax on pool trades after the launch).
 * - raise: CurveConfig.targetRaise, .saleTokens, .virtualBnb (CurveMath; the factory's curveFor gives the prices).
 * - price: what the sale is paid in (the native factory: BNB; the token-quote factory: its quote()).
 * - deadline: CurveConfig.duration (CurveLauncher.deadline; after it, unwind gives every buyer back what they put in).
 * - creator: the value sent, the factory's creationFee() (the Portal's SALT_LOCK_FEE).
 * - tax: CurveConfig.burnShareBps (burned) and .taxDuration (how long the tax runs).
 * - pool: CurveLauncher._launch: the buy that takes the last sale token launches on Flap's Portal; the raise is the pool.
 * - pile: PileVault: the tax's rest after Flap's share (the processor's dispatch), and the curve fees at the launch;
 *   holders hand tokens in for pile × tokens ÷ tokens in circulation.
 */
export function flapPicture(input: FlapPictureInput): LaunchPicture {
  const { form, symbol, decimals, refusals: r } = input;
  const ticker = form.symbol.trim() || WORDS.token;
  const target = parseAmount(form.target, decimals);
  const targetText = r.target || !target.ok ? '?' : formatAmount(target.value, decimals);
  const hours = r.durationHours ? '?' : form.durationHours.trim();
  const burn = parsePercentToBps(form.burnShare);
  // Of 10 cells: none when nothing is burned, at least one when something is, never all (below 100%, as the form requires).
  const burnCells = r.burnShare || !burn.ok || burn.value === 0n ? 0 : Math.min(9, Math.max(1, Math.round(Number(burn.value) / 1000)));
  const days = r.taxDays ? '?' : form.taxDays.trim();
  const warn = new Set<PartId>();
  for (const key of Object.keys(r) as (keyof CreateForm)[]) warn.add(FLAP_FIELD_PART[key]);
  if (input.raiseProblem) warn.add('raise');
  if (input.checkProblem) warn.add('creator');
  if (input.coinProblem) warn.add('price');
  const rules = input.rules;
  const rulesBad = rules ? Object.keys(rules.refusals).length > 0 : false;
  if (rulesBad) warn.add('tax');
  const parts =
    rules && !rulesBad ? { creator: Number(rules.form.creator) * 100, pile: Number(rules.form.pile) * 100, burn: Number(rules.form.burn) * 100 } : null;
  const cells = cellsOf(burnCells, parts);
  const ruled = parts !== null && parts.pile !== 10_000;
  const fee = pct(form.tradeFee, Boolean(r.tradeFee));
  const buyers = [`fee ${fee}`, `tax ${pct(form.buyTax, Boolean(r.buyTax))}`];
  const sellers = [`fee ${fee}`, `tax ${pct(form.sellTax, Boolean(r.sellTax))}`];
  const names: Partial<Record<PartId, string>> = {
    token: form.symbol.trim() ? `${WORDS.token} ${ticker}` : WORDS.token,
    buyers: `${WORDS.buys}: ${buyers.join(', ')}`,
    sellers: `${WORDS.sells}: ${sellers.join(', ')}`,
    creator: input.fee ? `${WORDS.creator}: sends ${input.fee}` : WORDS.creator,
    raise: `${WORDS.target} ${targetText} ${symbol}`,
    price: `Paid in ${symbol}`,
    deadline: `${WORDS.deadline} ${hours} ${WORDS.hours}`,
    tax: `Tax: ${pct(form.burnShare, Boolean(r.burnShare))} burned, for ${days} days${
      rules ? (parts ? `; the rest: creator ${parts.creator / 100}%, pile ${parts.pile / 100}%, buy back and burn ${parts.burn / 100}%` : '; the rest: ?') : ''
    }`,
    pool: `${WORDS.pool}: at ${targetText} ${symbol}`,
    // The holders stand by the pile: one part.
    pile: `${WORDS.pile}: ${WORDS.holders.toLowerCase()} redeem`,
  };
  return {
    ticker,
    buyers,
    sellers,
    front: { left: { label: WORDS.target, value: targetText, unit: symbol }, right: { label: WORDS.deadline, value: hours, unit: WORDS.hours } },
    coin: symbol,
    creator: input.fee ? [WORDS.creator, input.fee] : [WORDS.creator],
    burnCells,
    cells,
    creatorTag: parts && parts.creator > 0 ? `${parts.creator / 100}%` : null,
    creatorTagOf: parts && parts.creator > 0 ? 'of the rest' : null,
    burn:
      parts && parts.burn > 0
        ? [`${WORDS.burned} ${pct(form.burnShare, Boolean(r.burnShare))}`, `buy back ${parts.burn / 100}%`, 'of the rest']
        : [WORDS.burned, pct(form.burnShare, Boolean(r.burnShare))],
    pile: [WORDS.pile, ruled && parts ? `${parts.pile / 100}% of the rest` : rulesBad ? '?' : 'the rest'],
    center: [`tax for ${days} days`],
    pool: { label: WORDS.pool, number: `at ${targetText}` },
    parts: FLAP_ORDER.map((id) => ({ id, name: names[id]! })),
    warn: FLAP_ORDER.filter((id) => warn.has(id)),
  };
}

/* ── Four.meme ─────────────────────────────────────────────────────────────────────────────────────────────────── */

type FourField = 'name' | 'symbol' | 'quote' | 'raise' | 'buy' | 'sell';

/** Which part holds each field of the Four.meme form (FourCreate's sheets). */
export const FOUR_FIELD_PART: Readonly<Record<FourField, PartId>> = Object.freeze({
  name: 'token',
  symbol: 'token',
  quote: 'price',
  raise: 'raise',
  buy: 'buyers',
  sell: 'sellers',
});

const FOUR_ORDER: readonly PartId[] = ['buyers', 'token', 'sellers', 'creator', 'raise', 'price', 'tax', 'pool', 'pile'];
/** Any address: the probes below read the fields, not the wallet (readFourForm asks for one). */
const PROBE_CREATOR = '0x000000000000000000000000000000000000dEaD' as Address;

/**
 * Every field's own refusal (readFourForm's words): each field read with the others at valid values of the same
 * kind; the sell fee with the buy fee as typed when that one reads (the preset's rule "not both 0" is the sell's).
 */
export function fourRefusals(form: FourForm, quotes: readonly Address[], decimalsOf: (quote: string) => number | undefined): Partial<Record<FourField, string>> {
  const valid: FourForm = { ...FOUR_DEFAULTS, kind: form.kind, quote: quotes[0] ?? '', sell: '1', buy: '1' };
  const read = (f: FourForm) => readFourForm(f, PROBE_CREATOR, quotes, decimalsOf);
  const out: Partial<Record<FourField, string>> = {};
  for (const key of Object.keys(FOUR_FIELD_PART) as FourField[]) {
    const probe: FourForm = { ...valid, [key]: form[key] };
    if (key === 'sell' && read({ ...valid, buy: form.buy }).ok) probe.buy = form.buy;
    const r = read(probe);
    if (!r.ok && r.refusal.field === key) out[key] = r.refusal.text;
  }
  return out;
}

export interface FourPictureInput {
  readonly form: FourForm;
  /** The coin it is raised in, as the page names it (its symbol), or "" while it is read. */
  readonly symbol: string;
  readonly refusals: Partial<Record<FourField, string>>;
  /** SH-287: the creator's rules for a tax launch, where the deployment and the signer offer them. */
  readonly rules?: { readonly form: RulesForm; readonly refusals: Partial<Record<RulesField, string>> };
}

/**
 * Four.meme's launch on our OpenFour copy (bounties/openfour; the signer's request in lib/four-create.ts, its fixed
 * terms in sign/sign-create.js). The sources:
 * - token: the request's name and symbol (the signed createArgs' initParams).
 * - buyers, sellers: "Curve fee": the Pile Bonding preset's trade module buyFeeBps / sellFeeBps (PileTradeModule: each
 *   curve trade's fee goes into the pile); "Tax token": Bonding Tax V1's buyFeeRate / sellFeeRate (the tax token's tax,
 *   on the curve and after the move to PancakeSwap).
 * - raise and price: raiseAmount in the quote coin (initParams.raiseAmount, .quoteAsset; the signer's allowed coins).
 * - creator: Core.createToken(createArgs, signature) with no value: the creator sends no coin; the site's signer signs.
 * - tax: the whole fee or tax goes to the pile (Curve fee: the trade module; Tax token: rateFounder 100 to the
 *   ForwardVault, cloning our PileTaxVault, whose pile it pays); nothing is burned.
 * - pool: at the raise the token moves to a PancakeSwap pool (the preset's migrate module).
 * - pile: FeeRules: holders hand tokens in for pile × tokens ÷ tokens in circulation.
 */
export function fourPicture(input: FourPictureInput): LaunchPicture {
  const { form, refusals: r } = input;
  const symbol = input.symbol || '?';
  const tax = form.kind === 'tax';
  const ticker = form.symbol.trim() || WORDS.token;
  const raise = parseAmount(form.raise, 18);
  const raiseText = r.raise || !raise.ok ? '?' : formatAmount(raise.value, 18);
  const word = tax ? 'tax' : 'fee';
  const buyers = [`${word} ${pct(form.buy, Boolean(r.buy))}`];
  const sellers = [`${word} ${pct(form.sell, Boolean(r.sell))}`];
  const warn = new Set<PartId>();
  for (const key of Object.keys(r) as FourField[]) warn.add(FOUR_FIELD_PART[key]);
  // SH-287: the rules share the tax token's tax (all of it reaches our vault); not for the curve-fee kind.
  const rules = tax ? input.rules : undefined;
  const rulesBad = rules ? Object.keys(rules.refusals).length > 0 : false;
  if (rulesBad) warn.add('tax');
  const parts =
    rules && !rulesBad ? { creator: Number(rules.form.creator) * 100, pile: Number(rules.form.pile) * 100, burn: Number(rules.form.burn) * 100 } : null;
  const ruled = parts !== null && parts.pile !== 10_000;
  const names: Partial<Record<PartId, string>> = {
    token: form.symbol.trim() ? `${WORDS.token} ${ticker}` : WORDS.token,
    buyers: `${WORDS.buys}: ${buyers[0]}`,
    sellers: `${WORDS.sells}: ${sellers[0]}`,
    creator: WORDS.creator,
    raise: `Raise ${raiseText} ${symbol}`,
    price: `Raised in ${symbol}`,
    tax: !tax
      ? 'Fees: all of them to the pile'
      : rules
        ? parts
          ? `Tax: creator ${parts.creator / 100}%, pile ${parts.pile / 100}%, buy back and burn ${parts.burn / 100}%`
          : 'Tax: ?'
        : 'Tax: all of it to the pile',
    pool: `${WORDS.pool}: at ${raiseText} ${symbol}`,
    pile: `${WORDS.pile}: ${WORDS.holders.toLowerCase()} redeem`,
  };
  return {
    ticker,
    buyers,
    sellers,
    front: { left: { label: 'Raise', value: raiseText, unit: symbol }, right: null },
    coin: symbol,
    creator: [WORDS.creator],
    burnCells: 0,
    cells: cellsOf(0, parts),
    creatorTag: parts && parts.creator > 0 ? `${parts.creator / 100}%` : null,
    creatorTagOf: null,
    burn: parts && parts.burn > 0 ? ['Buy back', `and burn ${parts.burn / 100}%`] : null,
    pile: [WORDS.pile, ruled && parts ? `${parts.pile / 100}% of the tax` : rulesBad ? '?' : tax ? 'all the tax' : 'all the fees'],
    center: [tax ? 'tax on every trade' : 'fee on every curve trade'],
    pool: { label: WORDS.pool, number: `at ${raiseText}` },
    parts: FOUR_ORDER.map((id) => ({ id, name: names[id]! })),
    warn: FOUR_ORDER.filter((id) => warn.has(id)),
  };
}
