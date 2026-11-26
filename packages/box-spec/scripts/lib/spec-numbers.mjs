/**
 * Numbers and single texts for the launch conversation (F73 launch skill), so an assistant can answer before a draft
 * exists: `--numbers` (what all tokens and one item are worth at the first buy and at graduation, what a creator buy
 * gets, what a share takes, dollar conversions at a price the creator gives) and `--field` (one name, ticker or text
 * checked against its rule, every problem at once). Amounts stay bigint; dollars are integer cents at the creator's
 * own ETH price, labelled as conversions, never predictions. Part of scripts/check-spec.mjs.
 */
import { PLAIN_LEFT, sizeText, textReport } from './spec-explain.mjs';
import { SECRET_ADVICE, SECRET_MESSAGE, secretKind } from './spec-secrets.mjs';
import {
  MARKER,
  constValue,
  decimalText,
  fieldLabel,
  groupedInt,
  parseDecimal,
  percentText,
  plainAddOn,
  plainField,
  plainNote,
  plainParam,
} from './spec-model.mjs';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "about 12 seconds", "about 5 minutes", "about 1 hour", "about 24 hours", "about 14 days" from a number of seconds. */
export function durationText(secondsIn) {
  const seconds = Number(secondsIn);
  if (seconds < 60) return `about ${plural(seconds, 'second')}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${plural(minutes, 'minute')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return `about ${plural(hours, 'hour')}${rest ? ` ${plural(rest, 'minute')}` : ''}`;
  const days = Math.floor(hours / 24);
  return `about ${plural(days, 'day')}${hours % 24 ? ` ${plural(hours % 24, 'hour')}` : ''}`;
}

/** What all tokens are worth at the first buy and at graduation for a native-ETH raise, in wei (layout library). */
export function curveValues(model, raise) {
  const curve = model.lib.boxCurve(BigInt(raise), false);
  const q192 = 1n << 192n;
  const issuance = constValue(model, 'ISSUANCE');
  const value = (sqrtP) => (issuance * q192) / (sqrtP * sqrtP);
  return { curve, first: value(curve.sqrtPriceStartX96), graduation: value(curve.sqrtPriceEndX96) };
}

/** An estimate for display, rounded: 4 decimals from 0.001 up, else 3 significant digits. */
export function approxText(raw, decimals = 18) {
  const v = BigInt(raw);
  if (v === 0n) return '0';
  const d = BigInt(decimals);
  if (decimals >= 4 && v >= 10n ** (d - 3n)) {
    const step = 10n ** (d - 4n);
    return decimalText(((v + step / 2n) / step) * step, decimals);
  }
  const keep = BigInt(Math.max(v.toString().length - 3, 0));
  const step = 10n ** keep;
  return decimalText(((v + step / 2n) / step) * step, decimals);
}

/** wei at `priceCents` per ETH as "$1,234" (from $100) or "$12.34". */
export function usdText(wei, priceCents) {
  const cents = (BigInt(wei) * BigInt(priceCents)) / 10n ** 18n;
  if (cents >= 10_000n) return `$${groupedInt((cents + 50n) / 100n)}`;
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** The share of all tokens (bps) a creator buy of `qIn` gets on a native-ETH curve (after the bootstrap and the fee). */
export function buyShareBps(model, curve, qIn) {
  return BigInt(qIn) === 0n ? 0n : model.lib.issuanceBps(model.lib.curveBuyOut(curve, BigInt(qIn)));
}

/** The smallest creator buy (wei, below the raise) that gets at least `bps` of all tokens, or null when none does. */
export function buyForShare(model, curve, raise, bps) {
  let lo = 1n;
  let hi = BigInt(raise) - 1n;
  if (buyShareBps(model, curve, hi) < BigInt(bps)) return null;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (buyShareBps(model, curve, mid) >= BigInt(bps)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** A decimal option ("2,500", "$2500", "5%") as bigint with `decimals` places, or null. */
function readDecimal(text, decimals) {
  if (text === undefined) return undefined;
  return parseDecimal(plainOption(text), decimals);
}

const plainOption = (text) => String(text).replace(/^\$/, '').replace(/%$/, '');
const optionName = (name) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** Why an option's text is not read: too many decimals for it, or not a plain number at all. */
function optionProblem(name, text, decimals) {
  const plain = plainOption(text).trim().replace(/,/g, '');
  if (/^\d+\.\d+$/.test(plain)) {
    return decimals === 0 ? `${optionName(name)} ${JSON.stringify(text)} must be a whole number.` : `${optionName(name)} ${JSON.stringify(text)} has more than ${decimals} decimals: write at most ${decimals} (e.g. ${decimalText(1n, decimals)}).`;
  }
  return `${optionName(name)} ${JSON.stringify(text)} is not a plain number.`;
}

/**
 * `--numbers`: the raise of native ETH (one for every box since F74 U5; a list if a context has presets) with what all tokens and, with `items`, one item are worth at
 * the first buy and at graduation, what a creator buy of `buy` ETH gets, what `share` percent takes, and with
 * `ethUsd` (the creator's price) every amount in dollars; `usd` converts a dollar amount to ETH.
 */
export function numbersOf(model, options = {}) {
  const context = model.contexts.at(-1);
  const eth = context.json.qList.find((q) => q.qClass === 'NATIVE_ETH');
  const problems = [];
  const opt = (name, decimals) => {
    const v = readDecimal(options[name], decimals);
    if (v === null) problems.push(optionProblem(name, options[name], decimals));
    return v ?? undefined;
  };
  if (!eth) return { ok: false, problems: ['This version lists no native ETH.'] };
  const presets = eth.raisePresets.map(BigInt);
  const raise = opt('raise', eth.decimals);
  const items = opt('items', 0);
  const buy = opt('buy', eth.decimals);
  const share = opt('share', 2);
  const priceCents = opt('ethUsd', 2);
  const usdCents = opt('usd', 2);
  const presetList = presets.map((x) => decimalText(x, eth.decimals)).join(', ');
  // F74 U5: one raise for every box (a list only where a context still has presets).
  if (raise !== undefined && !presets.includes(raise)) problems.push(presets.length === 1 ? `--raise must be the one raise every box has: ${presetList} ETH.` : `--raise must be one of the presets: ${presetList} ETH.`);
  const [minN, maxN] = [constValue(model, 'MIN_N'), constValue(model, 'MAX_N')];
  if (items !== undefined && (items < minN || items > maxN)) problems.push(`--items must be ${groupedInt(minN)} to ${groupedInt(maxN)}.`);
  if (share !== undefined && (share <= 0n || share >= 10_000n)) problems.push('--share must be a percentage between 0 and 100.');
  if (priceCents === 0n) problems.push('--eth-usd must be above 0.');
  if (usdCents !== undefined && priceCents === undefined) problems.push("--usd needs --eth-usd <today's ETH price in dollars>.");
  if (problems.length > 0) return { ok: false, problems };
  const issuance = constValue(model, 'ISSUANCE');
  const rows = (raise !== undefined ? [raise] : presets).map((r) => {
    const { curve, first, graduation } = curveValues(model, r);
    const row = { raise: r, first, graduation };
    if (items !== undefined) row.item = { n: items, tokens: issuance / items, first: first / items, graduation: graduation / items };
    if (buy !== undefined) row.buy = buy < r ? { amount: buy, bps: buyShareBps(model, curve, buy) } : { amount: buy, tooLarge: true };
    if (share !== undefined) row.forShare = { bps: share, amount: buyForShare(model, curve, r, share) };
    return row;
  });
  const usd = usdCents !== undefined ? { cents: usdCents, wei: (usdCents * 10n ** 18n) / priceCents } : undefined;
  return { ok: true, unit: 'ETH', priceCents, rows, usd };
}

/** `--numbers` as text: one block per raise, amounts first, dollars in brackets when a price was given. */
export function renderNumbers(result) {
  if (!result.ok) return `${result.problems.map((p) => `Cannot work these out: ${p}`).join('\n')}\n`;
  const eth = (wei) => `${approxText(wei)} ETH${result.priceCents !== undefined ? ` (about ${usdText(wei, result.priceCents)})` : ''}`;
  const L = ["Numbers for a box priced in ETH: estimates from the curve (the factory's own swap is the truth)."];
  if (result.priceCents !== undefined) L.push(`ETH at $${decimalText(result.priceCents, 2)}: the creator's figure for today, so every dollar amount is a conversion, not a prediction.`);
  for (const row of result.rows) {
    L.push('', `Raise ${decimalText(row.raise, 18)} ETH`);
    L.push(`  All 1,000,000,000 tokens (market cap): ${eth(row.first)} at the first buy, ${eth(row.graduation)} at graduation`);
    if (row.item) L.push(`  One item of ${groupedInt(row.item.n)} (about ${groupedInt(row.item.tokens / 10n ** 18n)} tokens): ${eth(row.item.first)} at the first buy, ${eth(row.item.graduation)} at graduation`);
    if (row.buy) {
      L.push(row.buy.tooLarge ? `  Creator's ETH at start: ${decimalText(row.buy.amount, 18)} ETH is not below the raise, so it is refused` : `  Creator's ETH at start: ${decimalText(row.buy.amount, 18)} ETH buys about ${percentText(row.buy.bps)} of all tokens (before anyone else, without the launch tax, shown on the box page)`);
    }
    if (row.forShare) {
      // The share as asked (two decimals), not rounded to one: "99.99%".
      const want = `${decimalText(row.forShare.bps, 2)}%`;
      L.push(row.forShare.amount === null ? `  ${want} of all tokens: more than a creator buy below the raise can get` : `  ${want} of all tokens: a creator buy of about ${eth(row.forShare.amount)}`);
    }
  }
  if (result.usd) L.push('', `$${decimalText(result.usd.cents, 2)} is about ${approxText(result.usd.wei)} ETH at $${decimalText(result.priceCents, 2)} per ETH.`);
  return `${L.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------ one text

/** The text fields a creator types: core string fields by name or alias, add-on texts as "<key>.<setting>". */
function textField(model, name) {
  const want = String(name).toLowerCase();
  const core = model.fields.find((f) => f.type === 'string' && (f.name.toLowerCase() === want || (plainField(model, f.name)?.aliases ?? []).some((a) => a.toLowerCase() === want)));
  if (core) return { name: core.name, label: fieldLabel(model, core.name), check: core.check };
  const [key, param] = String(name).split('.');
  const p = model.addOnByKey.get(key)?.params.find((x) => x.name === param && x.type === 'string');
  if (p) return { name: `${key}.${param}`, label: `${plainAddOn(model, key)?.label ?? key}: ${(plainParam(model, key, param)?.label ?? param).toLowerCase()}`, check: p };
  return undefined;
}

/** The text fields `--field` takes, for its usage line. */
export function textFieldNames(model) {
  const core = model.fields.filter((f) => f.type === 'string').map((f) => f.name);
  const params = model.catalog.addOns.flatMap((a) => a.params.filter((p) => p.type === 'string').map((p) => `${a.key}.${p.name}`));
  return [...core, ...params];
}

/** `--field <name> <text>`: one text checked against its rule and length, with every problem and a suggested text. */
export function checkField(model, name, value) {
  // Never repeat a pasted key or phrase, not even as the field's name.
  if (secretKind(String(value ?? '')) || secretKind(String(name ?? ''))) return { ok: false, secret: true, field: '', problems: [SECRET_MESSAGE], warnings: [] };
  const field = textField(model, name);
  if (!field) return { ok: false, unknown: true, field: String(name), problems: [`"${name}" is not a text field. Text fields: ${textFieldNames(model).join(', ')}.`], warnings: [] };
  const text = String(value ?? '');
  const report = textReport(model, field.label, text, field.check);
  const warnings = [];
  if (text === MARKER) {
    report.ok = false;
    report.problems.push(`"${MARKER}" would become the text itself.`);
  }
  if (/Symbol$/.test(field.name) && text.startsWith('$')) {
    // A ticker is written without "$" (sites add it): the suggestion and the note's text both drop it.
    const fixed = (report.suggestion ?? text).replace(/^\$+/, '');
    if (report.suggestion !== undefined) report.suggestion = fixed === '' ? undefined : fixed;
    // "$🔥" leaves nothing once the "$" and the emoji go: say so rather than suggest "".
    if (fixed === '' && report.fix && !report.fix.includes(PLAIN_LEFT)) report.fix = `${report.fix} ${PLAIN_LEFT}`;
    warnings.push(plainNote(model, 'dollarTicker', { what: field.label.toLowerCase(), value: text, fixed: fixed === '' ? 'it without the "$"' : JSON.stringify(fixed) }));
  }
  if (text !== text.trim()) warnings.push(`${field.label} starts or ends with a space: it would be stored that way.`);
  return { ...report, field: field.name, warnings };
}

/** `--field` as text. */
export function renderField(result) {
  if (result.secret) return `${SECRET_MESSAGE}\n  ${SECRET_ADVICE}\n`;
  if (result.unknown) return `${result.problems[0]}\n`;
  const L = [];
  const size = `${sizeText(result.chars, result.bytes)}; at most ${groupedInt(result.max)}`;
  if (result.ok) L.push(`${result.label} ${JSON.stringify(result.text)}: allowed by the factory's check (${size}).`);
  else {
    L.push(`${result.label}: not allowed yet (${size}).`);
    for (const p of result.problems) L.push(`  - ${p}`);
    if (result.fix) L.push(`  Fix: ${result.fix}`);
    if (result.suggestion !== undefined) L.push(`  Suggested: ${JSON.stringify(result.suggestion)} (plain ASCII, ${sizeText([...result.suggestion].length, Buffer.byteLength(result.suggestion))}; ask the creator to confirm it)`);
  }
  for (const w of result.warnings) L.push(`  Note: ${w}`);
  return `${L.join('\n')}\n`;
}
