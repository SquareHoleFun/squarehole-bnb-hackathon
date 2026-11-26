/**
 * The BoxSpec checker behind `pnpm box-spec:check` (F73: a launch skill other assistants can use). It reads a BoxSpec
 * JSON (a draft, the launch flow's download, a bare spec), validates it with the generated library
 * (`boxSpecV1Schema` / `validateBoxSpecV1` against the version context: the factory's own check), prints the spec
 * hash, turns a refusal into a plain sentence with the fix, and lists what to tell the creator, warnings first.
 * `--menu` prints what a box can be today, read from the spec at run time; `--numbers` and `--field` (spec-numbers.mjs)
 * answer before a draft exists. No keys, no network, no transactions: it only reads files.
 */
import { addOnValues, buildWire, readDocument, show } from './spec-input.mjs';
import { explainVerdict } from './spec-explain.mjs';
import { launchFlowFeeLine, launchFlowGaps } from './spec-launch-flow.mjs';
import { approxText, buyShareBps, curveValues, durationText } from './spec-numbers.mjs';
import { SECRET_ADVICE, SECRET_MESSAGE, isTableV1, secretPaths } from './spec-secrets.mjs';
import {
  BLOCK_SECONDS,
  MARKER,
  boundValue,
  constValue,
  contextUnit,
  createModel,
  decimalText,
  enumFieldLabel,
  fieldLabel,
  groupedInt,
  launchFlowValue,
  loadSources,
  markerWord,
  memberByValue,
  memberLabel,
  offeredMembers,
  percentText,
  plainAddOn,
  plainField,
  plainMember,
  plainNote,
  plainParam,
  plannedAssets,
  plannedItems,
  qEntry,
  qUnit,
  ruleWords,
  utcText,
} from './spec-model.mjs';

export { createModel, loadSources, explainVerdict, buildWire, readDocument };
export { MARKER, contextUnit, memberLabel, memberText, missingPlainWords, plannedItems, decimalText, percentText, groupedInt, qUnit, utcText } from './spec-model.mjs';
export { DRAFT_FORMAT, FILE_FORMAT, addOnValues } from './spec-input.mjs';
export { approxText, buyForShare, buyShareBps, checkField, curveValues, durationText, numbersOf, renderField, renderNumbers, textFieldNames, usdText } from './spec-numbers.mjs';
export { SECRET_MESSAGE, secretKind, secretPaths } from './spec-secrets.mjs';
export { launchFlowGaps } from './spec-launch-flow.mjs';
export { plainWordUnits, proseUnits, soonEntries, soonFindings } from './spec-soon.mjs';

/** Exit codes of the command line: valid, refused by the factory's check, usage, not a readable BoxSpec, a secret. */
export const EXIT = Object.freeze({ VALID: 0, REFUSED: 1, USAGE: 2, NOT_READABLE: 3, SECRET: 4 });

/**
 * Where the spec is meant to run (F74 U1): `mainnet` (the default, the strictest: the factory's own check), `sepolia`
 * (the same today) or `demo` (holder payouts offered early, marked pending legal review). A local chain runs Sepolia's
 * contracts.
 */
export const NETWORK_NAMES = Object.freeze(['demo', 'sepolia', 'mainnet']);
export const DEFAULT_NETWORK = 'mainnet';
const NETWORK_LABELS = Object.freeze({ demo: 'Demo', sepolia: 'Sepolia', mainnet: 'mainnet' });

const isZeroHex = (v) => /^0x0*$/.test(String(v));

const kindOf = (model, enumName, value) => {
  const m = memberByValue(model, enumName, value);
  return { member: m, plain: m ? plainMember(model, enumName, m.name) : undefined };
};
const isCreatorKind = ({ member }) => Boolean(member && (member.kind === 'CREATOR' || /CREATOR/.test(member.name)));
const sells = ({ member, plain }) => Boolean(member?.sells || plain?.sells);
const buys = ({ member }) => Boolean(member?.buys && member.kind !== 'BURN');
const isNativeEth = (entry) => entry?.qClass === 'NATIVE_ETH';

/** The share of all tokens a creator buy gets (native ETH only: the token's address decides the order otherwise). */
function creatorBuyShare(model, wire, entry) {
  if (!isNativeEth(entry) || BigInt(wire.creatorBuy) === 0n) return null;
  try {
    return buyShareBps(model, curveValues(model, wire.raise).curve, wire.creatorBuy);
  } catch {
    return null;
  }
}

/** One item's share and value at the first buy and at graduation (native ETH; a collection), or null. */
function itemValues(model, wire, entry) {
  if (!isNativeEth(entry) || !(Number(wire.n) > 0) || memberByValue(model, 'BoxType', wire.boxType)?.name !== 'NEW_COLLECTION') return null;
  try {
    const { first, graduation } = curveValues(model, wire.raise);
    const n = BigInt(wire.n);
    return { n, tokens: constValue(model, 'ISSUANCE') / n, first: first / n, graduation: graduation / n };
  } catch {
    return null;
  }
}

function addressText(value, placeholders, path) {
  if (placeholders.includes(path)) return 'the wallet connected in the launch flow, or one pasted there';
  return isZeroHex(value) ? 'none' : value;
}

const royaltyOf = (model, wire) => {
  const i = wire.addOns.findIndex((e) => model.addOnById.get(e.id)?.key === 'royalties');
  const v = i >= 0 ? addOnValues(model, wire.addOns[i]) : null;
  return v ? { index: i, values: v, destination: memberByValue(model, 'RoyaltyDestination', v.destination)?.name } : null;
};

function addOnText(model, entry, wire, context, vars, placeholders, i) {
  const a = model.addOnById.get(entry.id);
  const label = plainAddOn(model, a?.key)?.label ?? a?.key ?? `add-on ${entry.id}`;
  const v = addOnValues(model, entry);
  if (!a || !v) return label;
  if (a.key === 'royalties') {
    const to = memberLabel(model, 'RoyaltyDestination', memberByValue(model, 'RoyaltyDestination', v.destination)?.name ?? '', vars).toLowerCase();
    const toCreator = memberByValue(model, 'RoyaltyDestination', v.destination)?.name === 'CREATOR';
    // One payout wallet (F72 (3)): royalties to the creator are credited to the fee payout address.
    const who = toCreator ? ` (the fee payout address: ${addressText(wire.creatorFeeRecipient, placeholders, 'creatorFeeRecipient')})` : '';
    return `${label}: ${percentText(BigInt(v.bps))}, ${to}${who}`;
  }
  if (a.key === 'placeholders') return `${label}: tickets "${v.placeholderName}" (${v.placeholderSymbol})`;
  if (a.key === 'edition-specials') return `${label}: ${groupedInt(v.count)} "${v.label}"`;
  if (a.key === 'creator-fee-cap') {
    // F74 U2: a fixed amount per 30 days (bigint, Q raw units), not a share of the raise.
    const entry = qEntry(context.json, wire.q);
    const rest = memberLabel(model, 'CapExcess', memberByValue(model, 'CapExcess', v.excess)?.name ?? '', vars).toLowerCase();
    return `${label}: at most ${decimalText(v.capPerEpoch, entry?.decimals ?? 18)} ${vars.Q} per 30 days, the rest ${rest}`;
  }
  if (a.key === 'collection-metadata') {
    // Pictures by what they are, never by fingerprint (a 64-hex value looks like a private key).
    const banner = isZeroHex(v.bannerSha256) ? 'no banner' : placeholders.includes(`addOns[${i}].params.bannerSha256`) ? 'a banner (uploaded in the launch flow)' : 'a banner (its fingerprint is in the spec)';
    const n = v.teaserSha256s.length;
    return `${label}: ${banner}, ${n === 0 ? 'no teasers' : `${n} teaser${n === 1 ? '' : 's'}`}, ${v.externalLink === '' ? 'no link' : `link ${v.externalLink}`}`;
  }
  const parts = a.params.map((p) => {
    const raw = v[p.name];
    const fingerprint = typeof raw === 'string' && /^0x[0-9a-fA-F]{64}$/.test(raw);
    const shown = p.enum ? memberLabel(model, p.enum, memberByValue(model, p.enum, raw)?.name ?? String(raw), vars) : Array.isArray(raw) ? `${raw.length} item(s)` : fingerprint ? 'set' : String(raw);
    return `${plainParam(model, a.key, p.name)?.label ?? p.name} ${shown}`;
  });
  return `${label}: ${parts.join(', ')}`;
}

/**
 * The overview rows a creator confirms: [label, value] in the creation flow's order, labelled as the launch flow's
 * Overview page labels them ("Paired with", "About", "Target", "Your ETH"), the plain term in brackets where useful.
 */
export function overviewOf(model, wire, context, placeholders) {
  const entry = qEntry(context.json, wire.q);
  const unit = qUnit(entry);
  const decimals = entry?.decimals ?? 18;
  const vars = { T: wire.tokenSymbol, Q: unit };
  const rows = [];
  const add = (label, value) => rows.push([label, value]);
  const supply = decimalText(model.lib.ISSUANCE, 18);
  add('Token', `${wire.tokenName} (${wire.tokenSymbol}), ${supply} tokens`);
  add('Paired with', entry ? entry.label : wire.q);
  // Never the value itself: a 64-hex fingerprint looks like a private key, and this one comes from the input.
  add('Logo', placeholders.includes('coverSha256') ? 'uploaded in the launch flow' : 'set (its fingerprint is in the spec)');
  add('About', wire.description === '' ? '(none)' : wire.description);
  const boxType = memberByValue(model, 'BoxType', wire.boxType)?.name;
  const art = memberLabel(model, 'ArtMode', memberByValue(model, 'ArtMode', wire.artMode)?.name ?? '', vars).toLowerCase();
  const contents = boxType === 'NEW_COLLECTION' ? `a new collection "${wire.collectionName}" (${wire.collectionSymbol}), ${groupedInt(wire.n)} items, ${art}` : memberLabel(model, 'BoxType', boxType ?? '', vars);
  add('Contents', contents);
  // F74 U3: a new collection's own cover (the marketplaces' picture), beside the logo; never its fingerprint.
  if (boxType === 'NEW_COLLECTION') add('Collection cover', placeholders.includes('collectionCoverSha256') ? 'uploaded in the launch flow' : 'set (its fingerprint is in the spec)');
  const item = itemValues(model, wire, entry);
  if (item) add('One item', `1/${groupedInt(item.n)} of all ${wire.tokenSymbol} at launch (about ${groupedInt(item.tokens / 10n ** 18n)}; fewer as burns shrink the supply): about ${approxText(item.first)} ${unit} at the first buy, ${approxText(item.graduation)} ${unit} at graduation`);
  if (boxType === 'NEW_COLLECTION') add('Owner (collection)', addressText(wire.marketplaceOwner, placeholders, 'marketplaceOwner'));
  const q = kindOf(model, 'QStream', wire.qStream);
  const t = kindOf(model, 'TStream', wire.tStream);
  add("Buyers' fees", q.member ? memberLabel(model, 'QStream', q.member.name, vars) : String(wire.qStream));
  add("Sellers' fees", t.member ? memberLabel(model, 'TStream', t.member.name, vars) : String(wire.tStream));
  if (isCreatorKind(q) || isCreatorKind(t) || royaltyOf(model, wire)?.destination === 'CREATOR') add('Fee payout address', addressText(wire.creatorFeeRecipient, placeholders, 'creatorFeeRecipient'));
  add('Add-ons', wire.addOns.length === 0 ? 'none' : wire.addOns.map((e, i) => addOnText(model, e, wire, context, vars, placeholders, i)).join('; '));
  add('Target (raise)', `${decimalText(wire.raise, decimals)} ${unit}`);
  add('Deadline', wire.deadlineDays === 0 ? 'none' : `${wire.deadlineDays} days after the open (not reached: the box fails and every token sells back from the refund range)`);
  // Field 15 openAt (F80, open-at-clock-time.md): 0 is the launch flow's "Now" (the default), the block after the
  // creation block, never in it (one slot: durationText takes seconds); a clock time opens in the first block at or
  // after it, or the block after Create when Create lands at or after it.
  const openAt = BigInt(wire.openAt);
  add('Opens', openAt === 0n ? `Now: the block after Create (${durationText(BLOCK_SECONDS)})` : `${utcText(openAt)}, in the first block from then on (if Create lands later: the block after Create)`);
  const share = creatorBuyShare(model, wire, entry);
  const buy = BigInt(wire.creatorBuy) === 0n ? 'none' : `${decimalText(wire.creatorBuy, decimals)} ${unit}${share !== null ? `, about ${percentText(share)} of all ${wire.tokenSymbol}` : ''}`;
  add(`Your ${unit} (creator buy)`, buy);
  return rows;
}

/** Names of the trait types in a metadata table v1 (encoded), or [] when it has none or does not decode. */
function traitTypeNames(hex) {
  try {
    const b = Buffer.from(String(hex).slice(2), 'hex');
    let i = 3 + ((b[1] << 8) | b[2]);
    const names = [];
    for (let t = 0, count = b[i++]; t < count; t++) {
      const len = b[i++];
      names.push(b.subarray(i, i + len).toString('ascii'));
      i += len;
      for (let v = 0, values = b[i++]; v < values; v++) i += 1 + b[i];
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * What the launch flow cannot enter, each line starting "The launch flow cannot enter this yet": the gaps from
 * plain-words `launchFlowCanEnter` (spec-launch-flow.mjs), different addresses where it uses one for owner, fee payout
 * and royalties (apps/web create-model `chooseOwner`), and ticket texts it sets itself. None for box 0 (version 1),
 * which Square Hole builds itself.
 */
export function enterGapsOf(model, wire, context, built) {
  if (context.version === 1) return [];
  const notes = launchFlowGaps(model, wire);
  const addresses = new Set();
  const note = (value, path) => addresses.add(built.placeholders.includes(path) ? MARKER : String(value).toLowerCase());
  // Each address counts only when set: a token-only box has no collection owner (the launch flow writes zero there).
  if (!isZeroHex(wire.marketplaceOwner)) note(wire.marketplaceOwner, 'marketplaceOwner');
  // Royalties to the creator pay the fee payout address itself (F72 (3)): no third address.
  if (!isZeroHex(wire.creatorFeeRecipient)) note(wire.creatorFeeRecipient, 'creatorFeeRecipient');
  if (addresses.size > 1) notes.push(plainNote(model, 'oneAddress'));
  wire.addOns.forEach((e) => {
    const a = model.addOnById.get(e.id);
    const lf = plainAddOn(model, a?.key)?.launchFlow;
    const values = lf ? addOnValues(model, e) : null;
    if (!values) return;
    for (const p of a.params) {
      if (p.type !== 'string' || (lf.editable ?? []).includes(p.name)) continue;
      const own = launchFlowValue(model, a.key, p.name, wire);
      if (own !== undefined && values[p.name] !== own) {
        const what = (plainParam(model, a.key, p.name)?.label ?? p.name).replace(/^Ticket /, '').toLowerCase();
        notes.push(plainNote(model, 'placeholdersLaunchFlow', { what, value: p.name === 'hiddenSvg' ? 'a neutral picture' : JSON.stringify(own) }));
      }
    }
  });
  return notes;
}

/** Other things to fix or confirm before the creator confirms: raw dust, a "$" ticker, a link that is not https (or an X @handle). */
export function warningsOf(model, wire, context, built, site) {
  const notes = [];
  const unit = qUnit(qEntry(context.json, wire.q));
  for (const d of built.dust) notes.push(`${d.path} is ${d.value} raw units (${d.text} ${unit}): did you mean { "decimal": "${d.value}" }?`);
  for (const field of ['tokenSymbol', 'collectionSymbol']) {
    const value = String(wire[field] ?? '');
    if (value.startsWith('$')) notes.push(plainNote(model, 'dollarTicker', { what: fieldLabel(model, field).toLowerCase(), value, fixed: JSON.stringify(value.replace(/^\$+/, '')) }));
  }
  for (const link of Array.isArray(site?.links) ? site.links : []) {
    // An https:// link, or an X @handle (the launch flow's X field takes both: apps/web site-links.ts).
    if (typeof link === 'string' && (/^https:\/\/[^\s"<>\\]+$/.test(link) || /^@[A-Za-z0-9_]{1,15}$/.test(link))) continue;
    // Shown only when short, like every raw value (a long one may be pasted text), and guessed only then.
    const text = String(link).trim();
    const short = show(link) === JSON.stringify(link);
    const guess = !short ? null : /^http:\/\//i.test(text) ? text.replace(/^http:/i, 'https:') : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text) ? `https://${text}` : null;
    notes.push(plainNote(model, 'badLink', { link: show(link), suggest: guess ? `. Did you mean ${JSON.stringify(guess)}?` : '.' }));
  }
  return notes;
}

/**
 * The opening time against the clock (`nowMs`, milliseconds, when the caller gives one; the command line gives its own):
 * a time already passed opens in the block after Create, like Now; a time more than 14 days ahead is refused by the
 * factory at creation (OpenAtTooFar) until 14 days before it, which `validate()` cannot see (open-at-clock-time.md
 * § 2.1). Without a clock, no warning: the same draft checks the same on every day.
 */
export function openAtWarningsOf(model, wire, nowMs) {
  const openAt = BigInt(wire.openAt ?? 0);
  if (openAt === 0n || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return [];
  const now = BigInt(Math.floor(nowMs / 1000));
  const ahead = constValue(model, 'MAX_OPEN_AHEAD_SECONDS');
  if (openAt <= now) return [plainNote(model, 'openAtPassed', { time: utcText(openAt) })];
  if (openAt > now + ahead) return [plainNote(model, 'openAtTooFar', { time: utcText(openAt), earliest: utcText(openAt - ahead) })];
  return [];
}

const FULL32 = /^0x[0-9a-fA-F]{64}$/;

/** The description a metadata table v1 holds, or null when the bytes do not read as one to the end. */
function tableDescription(hex) {
  if (!isTableV1(hex)) return null;
  const b = Buffer.from(hex.slice(2), 'hex');
  return b.subarray(3, 3 + ((b[1] << 8) | b[2])).toString('latin1');
}

/**
 * What a draft writes that it cannot know (F73 review): a raw trait table (the launch flow builds the table from the
 * About text and the art's traits; the factory refuses a malformed one, METADATA_TABLE_MALFORMED since core item 9,
 * but not one with another description), and a fingerprint written as 64 hex characters (the launch flow computes
 * each from an upload; a pasted key there looks the same). Downloads and bare specs carry real values and are not
 * flagged.
 */
export function draftWarningsOf(model, read, wire) {
  if (read.kind !== 'draft') return [];
  const notes = [];
  const spec = read.spec;
  const table = spec.metadataTable;
  if (typeof table === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(table)) {
    const description = tableDescription(table);
    const problem = description === null ? ' that do not read as a trait table' : description !== wire.description ? ", with a description that is not the spec's description" : '';
    notes.push(plainNote(model, 'rawTable', { problem }));
  }
  const explicit = (value) => typeof value === 'string' && FULL32.test(value) && !isZeroHex(value);
  const zeroFields = model.plain.launchFlowCanEnter?.zeroFields ?? [];
  for (const f of model.fields) if (f.type === 'bytes32' && !zeroFields.includes(f.name) && explicit(spec[f.name])) notes.push(plainNote(model, 'explicitFingerprint', { path: f.name }));
  (Array.isArray(spec.addOns) ? spec.addOns : []).forEach((entry, i) => {
    const a = typeof entry?.addOn === 'string' ? model.addOnByKey.get(entry.addOn) : undefined;
    const params = entry?.params;
    if (!a || typeof params !== 'object' || params === null) return;
    for (const p of a.params) {
      const at = `addOns[${i}].params.${p.name}`;
      if (p.type === 'bytes32' && explicit(params[p.name])) notes.push(plainNote(model, 'explicitFingerprint', { path: at }));
      if (p.type === 'bytes32[]' && Array.isArray(params[p.name])) params[p.name].forEach((v, j) => explicit(v) && notes.push(plainNote(model, 'explicitFingerprint', { path: `${at}[${j}]` })));
    }
  });
  return notes;
}

/**
 * "How the creator is paid", side by side from the spec's own members: whether each fee side pays the creator, in
 * which currency (the member's `paidIn`, else what the side collects: buyers' fees in Q, sellers' fees in T) and
 * whether the box converts it first. Right for the creator option on both sides (main) and for per-side kinds
 * (sh-box-create-v2), where one side may pay the creator and the other burn.
 */
function creatorFeesNote(model, q, t, vars, decimals) {
  const lpFee = constValue(model, 'LP_FEE');
  const part = constValue(model, 'FEE_SHARE_Q_STREAM');
  const per = (10n ** BigInt(decimals) * lpFee * part) / (1_000_000n * constValue(model, 'FEE_SHARE_DENOMINATOR'));
  const words = { ...vars, fee: `${decimalText(lpFee, 4)}%`, share: `${part}/${constValue(model, 'FEE_SHARE_DENOMINATOR')}`, perEth: approxText(per, decimals) };
  const side = (s, enumName, collects) => {
    if (!isCreatorKind(s)) return plainNote(model, 'creatorFromNone', { label: s.member ? memberLabel(model, enumName, s.member.name, vars) : 'unknown' });
    const converted = (s.member?.paidIn ?? collects) !== collects;
    return plainNote(model, `creatorFrom${enumName === 'QStream' ? 'Buyers' : 'Sellers'}${converted ? 'Converted' : ''}`, words);
  };
  return plainNote(model, 'creatorFees', { ...words, buyers: side(q, 'QStream', 'Q'), sellers: side(t, 'TStream', 'T') });
}

/** What to tell the creator before they confirm: how the box pays, works and fails (warnings come separately). */
export function notesOf(model, wire, context, built, site) {
  const notes = [];
  const entry = qEntry(context.json, wire.q);
  const unit = qUnit(entry);
  const decimals = entry?.decimals ?? 18;
  const vars = { T: wire.tokenSymbol, Q: unit };
  if (built.placeholders.length > 0) {
    const words = [...new Set(built.placeholders.map((path) => markerWord(model, path, wire)))];
    notes.push(plainNote(model, 'draft', { count: words.length, what: words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] }));
  }
  notes.push(plainNote(model, 'notLive'));
  const share = creatorBuyShare(model, wire, entry);
  const advice = BigInt(model.plain.advice?.creatorBuyMaxBps ?? 500);
  if (share !== null) {
    notes.push(plainNote(model, 'creatorBuy', { amount: `${decimalText(wire.creatorBuy, decimals)} ${unit}`, share: percentText(share), T: wire.tokenSymbol }));
    if (share > advice) notes.push(plainNote(model, 'creatorBuyLarge', { share: percentText(share), advice: percentText(advice), T: wire.tokenSymbol }));
  } else if (BigInt(wire.creatorBuy) > 0n) notes.push(plainNote(model, 'creatorBuyOtherQ'));
  const q = kindOf(model, 'QStream', wire.qStream);
  const t = kindOf(model, 'TStream', wire.tStream);
  const royalty = royaltyOf(model, wire);
  const creatorPaid = isCreatorKind(q) || isCreatorKind(t) || (royalty?.destination === 'CREATOR' && BigInt(royalty.values.bps) > 0n);
  if (isCreatorKind(q) || isCreatorKind(t)) notes.push(creatorFeesNote(model, q, t, vars, decimals));
  if (creatorPaid) notes.push(plainNote(model, 'creatorCounsel'));
  // F74 U1: a holder payout is offered in Demo only, marked pending legal review.
  const capEntry = wire.addOns.find((e) => model.addOnById.get(e.id)?.key === 'creator-fee-cap');
  const capExcess = capEntry ? memberByValue(model, 'CapExcess', addOnValues(model, capEntry)?.excess)?.name : undefined;
  if (q.member?.kind === 'HOLDERS' || t.member?.kind === 'HOLDERS' || capExcess === 'HOLDERS') notes.push(plainNote(model, 'holdersPending'));
  for (const [side, enumName] of [[q, 'QStream'], [t, 'TStream']]) {
    const label = side.member ? memberLabel(model, enumName, side.member.name, vars) : '';
    if (sells(side)) notes.push(plainNote(model, 'sells', { label, T: wire.tokenSymbol, Q: unit }));
    if (buys(side)) notes.push(plainNote(model, 'buys', { label, T: wire.tokenSymbol, Q: unit }));
  }
  const item = itemValues(model, wire, entry);
  const fee = (name) => percentText(constValue(model, name));
  const hidden = memberByValue(model, 'ArtMode', wire.artMode)?.name === 'HIDDEN';
  if (item) {
    // Draws exist only with hidden art (the placeholders add-on, IBoxTickets); an open-art vault has no hidden item, so
    // every item still inside can be picked by its number (IBoxVault's header; add-ons.v1.json, placeholders).
    const when = plainNote(model, hidden ? 'itemHidden' : 'itemOpen', { T: wire.tokenSymbol, draw: fee('DRAW_FEE_BPS'), pick: fee('PICK_FEE_BPS') });
    notes.push(plainNote(model, 'item', { n: groupedInt(item.n), tokens: groupedInt(item.tokens / 10n ** 18n), T: wire.tokenSymbol, ret: fee('RETURN_FEE_BPS'), when }));
  }
  if (hidden) {
    notes.push(plainNote(model, 'hidden'));
    if (wire.deadlineDays > 0) notes.push(plainNote(model, 'hiddenDeadline'));
    const names = built.placeholders.includes('metadataTable') ? [] : traitTypeNames(wire.metadataTable);
    notes.push(plainNote(model, 'hiddenTable', { types: names.length > 0 ? names.join(', ') : 'every trait name and value' }));
  }
  const page = wire.addOns.find((e) => model.addOnById.get(e.id)?.key === 'collection-metadata');
  if (hidden && page && (addOnValues(model, page)?.teaserSha256s.length ?? 0) > 0) notes.push(plainNote(model, 'teasersHidden'));
  if (royalty && BigInt(royalty.values.bps) > 0n) {
    notes.push(plainNote(model, 'royalties'));
    if (royalty.destination === 'FEE_HANDLING' && isCreatorKind(q)) notes.push(plainNote(model, 'royaltiesWithFees'));
  }
  if (wire.deadlineDays > 0) {
    const items = !hidden && memberByValue(model, 'BoxType', wire.boxType)?.name === 'NEW_COLLECTION' ? ' The items then go back to the creator.' : '';
    notes.push(plainNote(model, 'deadline', { raise: `${decimalText(wire.raise, decimals)} ${unit}`, days: wire.deadlineDays, Q: unit, T: wire.tokenSymbol, items }));
  }
  if (Array.isArray(site?.links) && site.links.length > 0) notes.push(plainNote(model, 'links'));
  notes.push(plainNote(model, 'fixed', { T: wire.tokenSymbol }));
  return notes;
}

/**
 * The network a check runs for (F74 U1): `--network` when given; else the network a Download BoxSpec file names (its
 * `network` key, the network the launch flow checked it for); else the strictest, mainnet (drafts and bare specs
 * always, so a draft passes for testnet or mainnet only without --network demo).
 */
function networkOf(doc, read, option) {
  if (option !== undefined) return { network: option, networkFrom: 'option' };
  const named = read.kind === 'download' ? doc.network : undefined;
  if (named === undefined) return { network: DEFAULT_NETWORK, networkFrom: 'default' };
  if (NETWORK_NAMES.includes(named)) return { network: named, networkFrom: 'file' };
  const problem = { path: 'network', message: `The file names the network ${show(named)}; the launch flow writes ${NETWORK_NAMES.map((n) => `"${n}"`).join(', ')}.`, fix: 'Download the BoxSpec again, or choose the network with --network.' };
  return { network: DEFAULT_NETWORK, networkFrom: 'default', problem };
}

/**
 * Checks one BoxSpec JSON (already parsed). The result: ok, the stage that stopped it (input, file or check), the input
 * problems, the verdict with its plain explanation, the spec hash, the overview and the notes.
 */
export function checkSpec(model, doc, options = {}) {
  if (options.network !== undefined && !NETWORK_NAMES.includes(options.network)) throw new Error(`unknown network ${options.network}; use one of ${NETWORK_NAMES.join(', ')}`);
  const bare = typeof doc === 'object' && doc !== null && !('spec' in doc) && !('format' in doc);
  const secrets = secretPaths(model, doc, bare ? [] : ['spec']);
  // Stop before anything is read back: the value must never be repeated, not even in --json.
  if (secrets.length > 0) return { ok: false, stage: 'secret', secret: true, paths: secrets, problems: [], message: SECRET_MESSAGE };
  const read = readDocument(doc, model);
  const { network, networkFrom, problem } = networkOf(doc, read, options.network);
  const problems = problem ? [...read.problems, problem] : read.problems;
  // Never the brief: it is the creator's own words, for people, and the checker does not repeat free text it ignores.
  const result = { ok: false, kind: read.kind, context: read.context?.name, network, networkFrom, problems };
  if (problems.length > 0 || !read.spec || !read.context) return { ...result, stage: 'input' };
  const built = buildWire(model, read.spec, read.context);
  if (built.problems.length > 0) return { ...result, stage: 'input', problems: built.problems };
  const { wire } = built;
  const parsed = model.lib.boxSpecV1Schema(read.context.ctx, network).safeParse(wire);
  const verdict = parsed.success ? { reason: 0, field: 0 } : model.lib.validateBoxSpecV1(wire, read.context.ctx, network);
  const specHash = model.lib.specHash(wire);
  const draft = built.placeholders.length > 0;
  const common = { ...result, specHash, draft, placeholders: built.placeholders, launchFlow: built.launchFlow, verdict: { ...verdict, reasonName: model.lib.REASON_NAMES[verdict.reason], fieldName: model.lib.FIELD_NAMES[verdict.field] ?? '' } };
  if (verdict.reason !== 0) return { ...common, stage: 'check', explanation: explainVerdict(model, verdict, wire, read.context, network) };
  if (read.declared) {
    const encoded = model.lib.encodeBoxSpecV1(wire);
    const mismatch = [];
    if (read.declared.specHash !== undefined && read.declared.specHash !== specHash) mismatch.push({ path: 'specHash', message: `The file says ${read.declared.specHash} but its spec hashes to ${specHash}: the spec was edited after download.`, fix: 'Download the BoxSpec again from the launch flow.' });
    if (read.declared.encoded !== undefined && String(read.declared.encoded).toLowerCase() !== encoded) mismatch.push({ path: 'encoded', message: 'The file\'s "encoded" bytes do not match its spec.', fix: 'Download the BoxSpec again from the launch flow.' });
    if (mismatch.length > 0) return { ...common, stage: 'file', problems: mismatch };
  }
  const gaps = enterGapsOf(model, wire, read.context, built);
  return {
    ...common,
    ok: true,
    stage: 'check',
    enterable: gaps.length === 0,
    overview: overviewOf(model, wire, read.context, built.placeholders),
    warnings: [...gaps, ...warningsOf(model, wire, read.context, built, read.site), ...draftWarningsOf(model, read, wire), ...openAtWarningsOf(model, wire, options.nowMs)],
    notes: notesOf(model, wire, read.context, built, read.site),
  };
}

// ------------------------------------------------------------------------------------------------ text

const pad = (rows) => {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
};

/** ", Demo" after the context when the check ran for a network other than the strictest; ", as the file says" when read from it. */
const networkText = (result) => (result.network && result.network !== DEFAULT_NETWORK ? `, ${NETWORK_LABELS[result.network] ?? result.network}${result.networkFrom === 'file' ? ', as the file says' : ''}` : '');

/** The result as text for a person or an assistant reading the terminal. */
export function renderText(result, file = 'the file') {
  const L = [];
  if (result.stage === 'secret') {
    L.push(SECRET_MESSAGE, `  Where: ${result.paths.join(', ')}`, `  ${SECRET_ADVICE}`, 'Nothing was checked, and the value is not repeated here.');
    return `${L.join('\n')}\n`;
  }
  if (result.stage === 'input' || result.stage === 'file') {
    const n = result.problems.length;
    L.push(`Not checked yet: ${n} problem${n === 1 ? '' : 's'} in ${file}.`);
    result.problems.forEach((p, i) => {
      L.push(`  ${i + 1}. ${p.path ? `${p.path}: ` : ''}${p.message}`);
      L.push(`     Fix: ${p.fix}`);
    });
    return `${L.join('\n')}\n`;
  }
  if (!result.ok) {
    const e = result.explanation;
    L.push(`Refused: the factory's check (context ${result.context}${networkText(result)}) does not accept this spec yet.`);
    L.push(...pad([['Field', e.field], ['Why', e.sentence], ['Fix', e.fix], ['Check', `${e.reason} at ${e.field} (reason ${e.reasonCode}, field ${e.fieldId})${e.rule ? `, rule "${e.rule}"` : ''}`]]));
    L.push('The check stops at the first problem: fix it and run it again.');
    return `${L.join('\n')}\n`;
  }
  const gaps = result.enterable === false ? ', but the launch flow cannot enter all of it yet (see Check first)' : '';
  L.push(`Valid${result.draft ? ' draft' : ''}: the factory's check (context ${result.context}${networkText(result)}) accepts this spec${gaps}.`);
  L.push(`${result.draft ? 'Draft hash' : 'Spec hash'}: ${result.specHash}`);
  L.push('', 'Overview', ...pad(result.overview));
  if (result.warnings.length > 0) {
    L.push('', 'Check first ("cannot enter": change the draft; the rest: change it or confirm with the creator)');
    for (const w of result.warnings) L.push(`  - ${w}`);
  }
  L.push('', 'Tell the creator');
  for (const note of result.notes) L.push(`  - ${note}`);
  return `${L.join('\n')}\n`;
}

/** The command line's exit code for a result (EXIT). */
export function exitCodeOf(result) {
  if (result.ok) return EXIT.VALID;
  if (result.stage === 'secret') return EXIT.SECRET;
  return result.stage === 'check' ? EXIT.REFUSED : EXIT.NOT_READABLE;
}

// ------------------------------------------------------------------------------------------------ menu

const plainLabel = (text, context) => text.replace(/\{T\}/g, 'the token').replace(/\{Q\}/g, contextUnit(context));

/** What a core field accepts today, in one line (the menu and the skill's field guide). */
export function allowedText(model, f, context) {
  const check = f.check ?? {};
  const p = plainField(model, f.name);
  if (f.name === 'version') return `${context.version}`;
  if (f.enum) {
    const vars = { Q: contextUnit(context) };
    const offered = offeredMembers(model, f.enum, check.offered).map((m) => {
      const limits = plainMember(model, f.enum, m.name)?.limits;
      // Offered by validate() but not built by core v1 on Sepolia (SH-F74-polish item 5).
      const notBuilt = (m.notBuiltOn ?? []).map((n) => `not on ${NETWORK_LABELS[n] ?? n} yet: ${m.notBuilt}`);
      const notes = [...(limits ? [limits] : []), ...notBuilt];
      return `"${m.name}" ${memberLabel(model, f.enum, m.name, vars)}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    });
    const later = model.enums.get(f.enum).members.filter((m) => check.offered && !check.offered.includes(m.name)).map((m) => `"${m.name}" (${plainMember(model, f.enum, m.name)?.notOffered ?? 'not offered'}${m.offeredOn ? `; --network ${m.offeredOn.join(' or ')}` : ''})`);
    return `${offered.join(' | ')}${later.length ? `. Not offered: ${later.join(', ')}` : ''}`;
  }
  if (check.kind === 'listedQ') return `${context.json.qList.map((q) => `"${qUnit(q)}" (${q.label})`).join(' | ')}${plannedAssets(model).length ? ' (others are planned for later)' : ''}`;
  if (check.kind === 'raisePreset') {
    const presets = context.json.qList.map((q) => `${q.raisePresets.map((x) => decimalText(x, q.decimals)).join(' | ')} ${qUnit(q)}`).join('; ');
    // F74 U5: one raise for every box, set by the version.
    const one = context.json.qList.every((q) => q.raisePresets.length === 1);
    return `${presets}${one ? ' (every box; set by the version)' : p?.choices ? `: ${p.choices}` : ''}`;
  }
  if (check.kind === 'uint' && check.allowed) return p?.choices ?? check.allowed.join(' | ');
  // A value of its own at 0 and no maximum (field 15 openAt: 0 = Now, else a time; the factory's 14 days need the
  // block's time): the plain words say it.
  if (check.kind === 'uint' && check.orZero) return p?.choices ?? `0, or ${groupedInt(boundValue(model, check.min))} or more${p?.unit ? ` ${p.unit}` : ''}`;
  if (check.kind === 'uint') {
    const [min, max] = [boundValue(model, check.min), boundValue(model, check.max)];
    return min === max ? groupedInt(min) : `${groupedInt(min)} to ${groupedInt(max)}${p?.unit ? ` ${p.unit}` : ''}`;
  }
  if (check.kind === 'string') return `text, ${groupedInt(boundValue(model, check.minBytes))} to ${groupedInt(boundValue(model, check.maxBytes))} characters (${ruleWords(model, check.rule)})`;
  if (p?.choices) return p.choices;
  if (f.type === 'address') return `a public 0x address, or "${MARKER}" (the wallet connected at launch, or the address pasted there)`;
  if (String(p?.default ?? '').includes(MARKER)) return `"${MARKER}" (the launch flow fills it in)`;
  return p?.default ?? 'see references/fields.md';
}

/** What an add-on setting accepts, in one line. */
export function paramText(model, param, context) {
  // An amount menu (F74 U2) in whole units of the pricing asset, never raw.
  if (param.allowed && typeof param.allowed[0] === 'string') {
    const entry = context?.json.qList.length === 1 ? context.json.qList[0] : undefined;
    return entry ? `${param.allowed.map((x) => decimalText(x, entry.decimals)).join(' | ')} ${qUnit(entry)} (write { "decimal": "${decimalText(param.allowed[0], entry.decimals)}" })` : `${param.allowed.join(' | ')} (raw units)`;
  }
  if (param.allowed) return param.allowed.join(' | ');
  if (param.enum) return offeredMembers(model, param.enum, param.offered).map((m) => `"${m.name}" ${memberLabel(model, param.enum, m.name)}`).join(' | ');
  if (param.type === 'string') return `text, ${param.minBytes} to ${groupedInt(param.maxBytes)} characters (${ruleWords(model, param.rule)})`;
  if (param.max?.field) return `${param.min ?? 0} to ${param.max.field}`;
  // Fingerprints of pictures uploaded in the launch flow (the collection page's banner and teasers).
  if (param.type === 'bytes32') return `"${MARKER}" (the launch flow computes it from the upload), or "0x0" for none`;
  if (param.type === 'bytes32[]') return `a list of up to ${param.maxItems ?? 'any number of'} "${MARKER}" (one per upload), or [] for none`;
  if (param.nonZeroIff) return `${param.type}, set only when ${param.nonZeroIff.param} is ${param.nonZeroIff.eq}`;
  return param.type;
}

function addOnMenu(model, version, context) {
  const L = [];
  for (const a of model.catalog.addOns) {
    const p = plainAddOn(model, a.key);
    const available = a.versions.includes(version);
    L.push(`  "${a.key}" (id ${a.id}) ${p?.label ?? a.key}${available ? '' : ` - not available in version ${version}`}${a.repeatable ? ', may repeat' : ''}`);
    if (available && p?.launchFlow) L.push(`      params: "${MARKER}" for the launch flow's own ticket texts and picture`);
    if (available) for (const param of a.params) L.push(`      ${param.name}: ${paramText(model, param, context)}${p?.launchFlow && launchFlowValue(model, a.key, param.name, {}) !== undefined ? ` (or "${MARKER}")` : ''}`);
  }
  return L;
}

/** What a box can be today in `contextName`, read from the spec at run time. */
export function renderMenu(model, contextName = 'v2') {
  const context = model.contexts.find((c) => c.name === contextName);
  if (!context) throw new Error(`unknown context ${contextName}; use one of ${model.contexts.map((c) => c.name).join(', ')}`);
  const L = [`What a box can be today (context ${context.name}, version ${context.version}), read from packages/box-spec at run time.`, ''];
  for (const step of model.plain.steps) {
    L.push(step.title);
    for (const name of step.fields) {
      const f = model.fieldByName.get(name);
      if (!f) continue;
      if (f.type === 'AddOn[]') L.push(...addOnMenu(model, context.version, context));
      else L.push(`  ${name} (${fieldLabel(model, name)}): ${allowedText(model, f, context)}`);
    }
    if (step.fields.includes('tStream') && context.version > 1) L.push(launchFlowFeeLine());
    L.push('');
  }
  L.push('Rules');
  for (const sentence of new Set(model.rules.map((r) => model.plain.rules[r.name]?.sentence ?? r.name))) L.push(`  - ${sentence}`);
  const planned = plannedItems(model);
  const listed = new Set(context.json.qList.map((q) => qUnit(q).toLowerCase()));
  const assets = plannedAssets(model).filter((a) => !listed.has(a.label.toLowerCase()));
  if (planned.length > 0 || assets.length > 0) {
    L.push('', 'Coming soon (planned, not in this spec yet)');
    for (const item of planned) {
      const what = item.kind === 'addOn' ? `add-on "${item.key}"` : `${enumFieldLabel(model, item.enumName)} "${item.name}"`;
      L.push(`  - ${what}: ${plainLabel(item.plain.label, context)} (${item.plain.planned})`);
    }
    for (const a of assets) L.push(`  - Pricing asset ${a.label}: ${a.status}`);
  }
  return `${L.join('\n')}\n`;
}

/** The model from the package's JSON sources and the generated library. */
export function modelFor(lib, dir) {
  return createModel(loadSources(dir), lib);
}
