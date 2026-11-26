/**
 * `--numbers` for format 2 (M1-11; box-spec-v2-draft.md § 9 item 4): what the curve comes to in the pricing token's own
 * units (6-18 decimals), from the current permanent listing's raise, checked again by the factory at creation. Amounts
 * stay bigint; every figure is an estimate from the layout library, never the factory's own swap.
 */
import { approxText } from './spec-numbers.mjs';
import { decimalText, groupedInt, parseDecimal, percentText } from './spec-model.mjs';
import { LIST_FIRST, byRuleMessage } from './spec-input-v2.mjs';
import { symbolKey } from './spec-model-v2.mjs';

const builds = (curve, raise) => {
  if (raise < 1_000_000n || raise > (1n << 128n) - 1n) return false;
  try {
    const c = curve.boxCurve(raise, false);
    if (curve.fullRange) curve.fullRange(c, raise, c.poolShare);
    return true;
  } catch { return false; }
};

/** Numeric admission floor. Layout representability must also pass; it is not a monotone interval. */
export function curveFloor() { return 1_000_000n; }

/** Why the curve cannot hold `raise` of listing `l`, or null when it can (the registry's RAISE_NOT_BUILDABLE). */
export function curveProblem(curve, raise, l) {
  if (builds(curve, raise)) return null;
  const floor = curveFloor(curve);
  const amount = `${decimalText(raise, l.decimals)} ${l.symbol}`;
  const need = raise < floor ? `: CURVE_V1 needs at least ${decimalText(floor, l.decimals)} ${l.symbol} (${groupedInt(floor)} raw units)` : '';
  return `The curve cannot hold a raise of ${amount}${need}, so the listing registry refuses it (RAISE_NOT_BUILDABLE).`;
}

const option = (problems, name, text, decimals) => {
  if (text === undefined) return undefined;
  const value = parseDecimal(String(text).replace(/^\$/, '').replace(/%$/, ''), decimals);
  if (value === null) problems.push(`--${name} ${JSON.stringify(text)} is not a plain number with at most ${decimals} decimals.`);
  return value ?? undefined;
};

const names = (map) => [...map.values()].map((x) => x.symbol).join(', ');

/** A graduated box's token not listed yet, said as a draft's `pricing` says it (review round 3, low 3). */
const notListedYet = (menu, want) => {
  const rule = menu.byRule.find((b) => symbolKey(b.symbol) === want);
  return rule ? { problem: `${byRuleMessage(rule)} ${LIST_FIRST}` } : undefined;
};
/** One literal POSIX shell argument, including tickers with expansions, operators or single quotes. */
const shellWord = (text) => `'${text.replaceAll("'", "'\"'\"'")}'`;

/**
 * The listing `--pricing` (a token Square Hole listed, by symbol; ETH by default) or `--box-token` (a manually listed box token, by symbol) names, or why it names none: a box token never answers to `--pricing` (review round 2). Both
 * are looked up as a draft's are, without the spaces around them.
 */
function pricingListing(menu, { pricing, boxToken }) {
  if (boxToken !== undefined && pricing !== undefined) return { problem: 'Give --pricing (a token Square Hole listed) or --box-token (a manually listed box token), not both.' };
  if (boxToken !== undefined) {
    const [given, want] = [String(boxToken).trim(), symbolKey(boxToken)];
    const l = menu.boxTokens.get(want);
    if (l) return { l };
    if (menu.ambiguousBoxTokens.has(want)) return { problem: `Two box tokens listed by rule are called ${JSON.stringify(given)}: --menu shows their listings.` };
    return notListedYet(menu, want) ?? { problem: `--box-token ${JSON.stringify(given)} is not a box token listed on ${menu.label}: ${names(menu.boxTokens) || 'none yet'}.` };
  }
  const [given, want] = [String(pricing ?? 'ETH').trim(), symbolKey(pricing ?? 'ETH')];
  const l = menu.offered.get(want);
  if (l) return { l };
  if (menu.ambiguous.has(want)) return { problem: `Two listed tokens are called ${JSON.stringify(given)}: --menu shows their listings.` };
  if (menu.boxTokens.has(want) || menu.ambiguousBoxTokens.has(want)) return { problem: `--pricing ${JSON.stringify(given)} is a manually listed box token, not a token Square Hole listed: use --box-token ${shellWord(given)}.` };
  return notListedYet(menu, want) ?? { problem: `--pricing ${JSON.stringify(given)} is not listed on ${menu.label}: ${names(menu.offered)}.` };
}

/** The numbers for a box priced in `pricing` (a listed token's symbol; ETH by default) or in `boxToken`. */
export function numbersOfV2(model, options = {}) {
  const { menu, curve } = model;
  const { l, problem } = pricingListing(menu, options);
  if (!l) return { ok: false, problems: [problem] };
  const problems = [];
  const items = option(problems, 'items', options.items, 0);
  const buy = option(problems, 'buy', options.buy, l.decimals);
  const share = option(problems, 'share', options.share, 2);
  const raise = l.raise;
  if (raise === undefined) problems.push(`The menu has no reading of ${l.symbol}'s raise yet: check again with --indexer.`);
  else if (curveProblem(curve, raise, l)) problems.push(curveProblem(curve, raise, l));
  if (share !== undefined && (share <= 0n || share >= 10_000n)) problems.push('--share must be a percentage between 0 and 100.');
  if (problems.length > 0) return { ok: false, listing: l, problems };
  const c = curve.boxCurve(raise, false);
  const issuance = c.curveT + c.poolShare;
  const q192 = 1n << 192n;
  const valueAt = (sqrtP) => (issuance * q192) / (sqrtP * sqrtP);
  // The burned bootstrap buy, as the same share of the raise as ETH's (a listing's own bootstrapQ is set at listing).
  const bootstrap = (menu.profile.bootstrap * raise) / menu.profile.raise;
  const shareOf = (q) => (q === 0n ? 0n : curve.issuanceBps(curve.curveBuyOut(c, q, bootstrap)));
  const result = { ok: true, listing: l, network: menu.label, unit: l.symbol, decimals: l.decimals, raise, raiseFrom: 'listing', issuance, first: valueAt(c.sqrtPriceStartX96), graduation: valueAt(c.sqrtPriceEndX96) };
  if (items !== undefined && items > 0n) result.item = { n: items, first: result.first / items, graduation: result.graduation / items };
  if (buy !== undefined) result.buy = buy < raise ? { amount: buy, bps: shareOf(buy) } : { amount: buy, tooLarge: true };
  if (share !== undefined) {
    let [lo, hi] = [1n, raise - 1n];
    if (shareOf(hi) < share) result.forShare = { bps: share, amount: null };
    else {
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        if (shareOf(mid) >= share) hi = mid;
        else lo = mid + 1n;
      }
      result.forShare = { bps: share, amount: lo };
    }
  }
  return result;
}

/** `--numbers` as text: amounts first, in the pricing token, then the caps in ETH. */
export function renderNumbersV2(r) {
  if (!r.ok) return `${r.problems.map((p) => `Cannot work these out: ${p}`).join('\n')}\n`;
  const P = (raw) => `${approxText(raw, r.decimals)} ${r.unit}`;
  const byRule = r.listing.kind === 'BOX_TOKEN' ? ', a manually listed box token' : '';
  const L = [`Numbers for a box priced in ${r.unit} (listing ${r.listing.id} on ${r.network}${byRule}): estimates from the curve (the factory's own swap is the truth).`, ''];
  L.push(`Raise ${decimalText(r.raise, r.decimals)} ${r.unit} (listing raise; refresh before creation)`);
  L.push(`  All ${groupedInt(r.issuance / 10n ** 18n)} tokens (market cap): ${P(r.first)} at the first buy, ${P(r.graduation)} at graduation`);
  if (r.item) L.push(`  One item of ${groupedInt(r.item.n)}: ${P(r.item.first)} at the first buy, ${P(r.item.graduation)} at graduation`);
  if (r.buy) L.push(r.buy.tooLarge ? `  Creator buy: ${decimalText(r.buy.amount, r.decimals)} ${r.unit} is not below the raise, so it is refused` : `  Creator buy: ${decimalText(r.buy.amount, r.decimals)} ${r.unit} buys about ${percentText(r.buy.bps)} of all tokens`);
  if (r.forShare) L.push(r.forShare.amount === null ? `  ${decimalText(r.forShare.bps, 2)}% of all tokens: more than a creator buy below the raise can get` : `  ${decimalText(r.forShare.bps, 2)}% of all tokens: a creator buy of about ${P(r.forShare.amount)}`);
  return `${L.join('\n')}\n`;
}
