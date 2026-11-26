/**
 * The format 2 checker behind `pnpm box-spec:check` (M1-11; box-spec-v2-draft.md § 9): reads a format 2 draft against
 * the network's menu, hands the twin (M1-10's `validateBoxSpecV2(wire, ctx)`) the spec and the release context, turns
 * a refusal into a plain sentence with the fix, and lists the overview and what to tell the creator. A format 1 draft
 * for version 2 is refused with a pointer to § 8's table; box 0's version 1 stays format 1 (check-spec.mjs). Without
 * the twin in the checkout no draft is called valid. No keys, no transactions; the indexer is read only when asked.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT } from './check-spec.mjs';
import { holderNoteV2, holderOfferProblemsV2 } from './holder-guard.mjs';
import { decimalText, groupedInt, percentText, pkgDir } from './spec-model.mjs';
import { DRAFT_FORMAT_V2, MENU_NETWORKS_V2, createModelV2, fetchIndexerAnswer, indexerUrlOk, noteV2, readMenu } from './spec-model-v2.mjs';
import { explainVerdictV2 } from './spec-explain-v2.mjs';
import { POINTER, buildWireV2, readDocumentV2 } from './spec-input-v2.mjs';
import { curveProblem, numbersOfV2, renderNumbersV2 } from './spec-numbers-v2.mjs';
import { SECRET_ADVICE, SECRET_MESSAGE, secretPaths } from './spec-secrets.mjs';
import { abiOf, decodeParamsV2, encodeParamsV2, encodeSpecV2, readShapes, specHashV2 } from './spec-types-v2.mjs';

export { DRAFT_FORMAT_V2, EXIT, MENU_NETWORKS_V2, abiOf, decodeParamsV2, encodeParamsV2, encodeSpecV2, fetchIndexerAnswer, holderNoteV2, holderOfferProblemsV2, indexerUrlOk, numbersOfV2, readMenu, readShapes, renderNumbersV2, specHashV2 };
export const modelForV2 = (options) => createModelV2(options);

/**
 * M1-10's twin (src/generated/box-spec.v2.ts, M1-10-b's) once the checkout has it, else null (wave 1). Loaded after
 * load-generated.mjs's `loadBoxSpecLibrary()`, whose resolve hook lets plain Node import the package's TypeScript.
 */
export async function loadTwinV2(path = join(pkgDir, 'src/generated/box-spec.v2.ts')) {
  if (!existsSync(path)) return null;
  const twin = await import(pathToFileURL(path).href);
  return typeof twin.validateBoxSpecV2 === 'function' ? twin : null;
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const valueOf = (model, enumName, name) => model.shapes.enums.get(enumName).members.find((m) => m.name === name)?.value;
const memberName = (model, enumName, value) => model.shapes.enums.get(enumName).members[value]?.name ?? String(value);
const isCollection = (model, wire) => memberName(model, 'BoxType', wire.boxType) === 'NEW_COLLECTION';

/** Frozen single-listing context; kind 0 marks an unknown id (including an absent native row). */
export function contextOf(model, built) {
  const l = built.priced?.listing;
  return { listing: l ? { id: l.id, token: l.address, decimals: l.decimals, class: valueOf(model, 'ListingClass', l.class), kind: valueOf(model, 'ListingKind', l.kind), raise: l.raise } : { id: 0, token: '0x0000000000000000000000000000000000000000', decimals: 0, class: 0, kind: 0, raise: 0n } };
}
const byRuleNote = (l) => l?.kind === 'BOX_TOKEN' ? ', a manually listed graduated box coin' : '';

function recipeText(model, side) {
  const choice = model.sources.spec.menu.choices.find((c) => valueOf(model, 'Leg', c.leg) === side.a.leg && valueOf(model, 'Dest', c.dest) === side.a.dest);
  return choice?.key ?? 'unavailable choice';
}

/** The overview rows a creator confirms, in the creation flow's order. */
function overviewOf(model, wire, built) {
  const l = built.priced.listing;
  const P = l?.symbol ?? 'the pricing token';
  const rows = [['Token', `${wire.tokenName} (${wire.tokenSymbol})`]];
  const older = l && model.menu.newest.get(l.address)?.id !== l.id ? ', an older listing' : '';
  rows.push(['Paired with', l ? `${l.label}, listing ${l.id}${byRuleNote(l)}${older}` : `listing ${wire.pricing.listingId}`]);
  rows.push(['Raise', `${decimalText(wire.raise, l?.decimals ?? 18)} ${P}${built.raiseFrom === 'listing' ? ', fixed for this box at creation' : ''}`]);
  rows.push(['Contents', isCollection(model, wire) ? `a new collection "${wire.collectionName}" (${wire.collectionSymbol}), ${groupedInt(wire.n)} items, a named pick ${percentText(wire.pickFeeBps)}` : 'just the token']);
  rows.push(["Buyers' fees", recipeText(model, wire.buyers)], ["Sellers' fees", recipeText(model, wire.sellers)]);
  rows.push(['Deadline', `${wire.deadlineDays} days after the open`]);
  rows.push(['Add-ons', wire.addOns.length === 0 ? 'none' : wire.addOns.map((e) => model.addOnById.get(e.id)?.key ?? `add-on ${e.id}`).join(', ')]);
  rows.push([`Your ${P} (creator buy)`, BigInt(wire.creatorBuy) === 0n ? 'none' : `${decimalText(wire.creatorBuy, l?.decimals ?? 18)} ${P}`]);
  return rows;
}

/** A refused listing is hidden by tools, while its on-chain identity remains permanent. */
function warningsOf(model, wire, built) {
  const l = built.priced?.listing;
  const problem = l && model.curve ? curveProblem(model.curve, wire.raise, l) : null;
  return problem ? [problem] : [];
}

/** What to tell the creator (plain-words.v2.json `notes`; none while the words are missing). */
function notesOf(model, wire, built) {
  const l = built.priced.listing;
  const vars = { P: l?.symbol, T: wire.tokenSymbol, days: wire.deadlineDays };
  return [
    noteV2(model, 'notLive'),
    isCollection(model, wire) && wire.metadataTable !== '0x' ? noteV2(model, 'tableLoads') : null,
    built.raiseFrom === 'listing' ? noteV2(model, 'raiseChecked', { ...vars, raise: decimalText(wire.raise, l.decimals) }) : null,
    l && l.id !== 0 ? noteV2(model, 'nonEthOpen', vars) : null,
    l?.powers?.length ? noteV2(model, 'powers', { ...vars, powers: l.powers.join(' ') }) : null,
    wire.deadlineDays > 0 ? noteV2(model, 'closing', vars) : null,
  ].filter(Boolean);
}

const FORMAT1_REFUSAL = {
  reason: 'FORMAT_1',
  field: 'format',
  sentence: 'No factory builds it, and format 2 replaces it.',
  fix: `Write it as a format 2 draft ("format": "${DRAFT_FORMAT_V2}"): ${POINTER} turns each format 1 fee kind into its recipe, and references/v2/examples has every worked example converted.`,
};

/** Checks one parsed document. The result: ok, the stage that stopped it, problems, verdict, hash, overview, notes. */
export function checkSpecV2(model, doc) {
  const secrets = secretPaths(model, doc, isObject(doc?.spec) ? ['spec'] : []);
  if (secrets.length > 0) return { ok: false, format: 2, stage: 'secret', secret: true, paths: secrets, problems: [], message: SECRET_MESSAGE };
  const read = readDocumentV2(doc, model);
  const base = { ok: false, format: 2, network: model.network, menuSource: model.menu.source, menuWrittenAt: model.menu.writtenAt };
  if (read.format1 && read.box0) return { ...base, format: 1, stage: 'input', format1: true, box0: true, problems: [{ path: 'format', message: "Box 0's version 1 spec is format 1, which stays for box 0.", fix: 'Check it without --format 2: pnpm box-spec:check <file>.' }] };
  if (read.format1) return { ...base, format: 1, stage: 'check', format1: true, problems: [], explanation: FORMAT1_REFUSAL };
  if (read.problems.length > 0 || !read.spec) return { ...base, stage: 'input', problems: read.problems };
  const built = buildWireV2(model, read.spec);
  if (built.problems.length > 0) return { ...base, stage: 'input', problems: built.problems };
  const common = { ...base, kind: read.kind, preset: read.preset, pricing: built.priced.listing, raiseFrom: built.raiseFrom, wire: built.wire, placeholders: built.placeholders, draft: built.placeholders.length > 0 };
  if (built.pending.length > 0) return { ...common, stage: 'check', pending: 'catalog', warnings: warningsOf(model, built.wire, built) };
  const ctx = contextOf(model, built);
  const summary = { ...common, specHash: specHashV2(model.shapes, built.wire), ctx, overview: overviewOf(model, built.wire, built), warnings: warningsOf(model, built.wire, built), notes: notesOf(model, built.wire, built) };
  if (!model.twin) return { ...summary, stage: 'check', pending: 'twin' };
  const v = model.twin.validateBoxSpecV2(built.wire, ctx);
  const reasons = model.twin.REASON_NAMES ?? Object.fromEntries((model.sources.spec?.reasons ?? []).map((r) => [r.code, r.name]));
  const verdict = { reason: Number(v.reason), field: Number(v.field), reasonName: reasons[Number(v.reason)] ?? `reason ${v.reason}` };
  if (verdict.reason !== 0) return { ...summary, stage: 'check', verdict, explanation: explainVerdictV2(model, verdict, built.wire) };
  return { ...summary, ok: true, verdict, stage: 'check' };
}

/** The command line's exit code (unchanged: 0 valid, 1 refused or not accepted yet, 3 not readable, 4 a secret). */
export function exitCodeOfV2(result) {
  if (result.ok) return EXIT.VALID;
  if (result.stage === 'secret') return EXIT.SECRET;
  return result.stage === 'check' ? EXIT.REFUSED : EXIT.NOT_READABLE;
}

const pad = (rows) => {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
};

/** The result as text for a person or an assistant reading the terminal. */
export function renderTextV2(result, file = 'the file') {
  const L = [];
  if (result.stage === 'secret') return `${[SECRET_MESSAGE, `  Where: ${result.paths.join(', ')}`, `  ${SECRET_ADVICE}`, 'Nothing was checked, and the value is not repeated here.'].join('\n')}\n`;
  if (result.stage === 'input') {
    L.push(`Not checked yet: ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'} in ${file}.`);
    result.problems.forEach((p, i) => L.push(`  ${i + 1}. ${p.path ? `${p.path}: ` : ''}${p.message}`, `     Fix: ${p.fix}`));
    return `${L.join('\n')}\n`;
  }
  const e = result.explanation;
  if (result.format1) return `${['Refused: a format 1 draft for version 2.', ...pad([['Why', e.sentence], ['Fix', e.fix]])].join('\n')}\n`;
  if (result.pending === 'catalog') {
    L.push("Read, not encoded yet: format 2's add-on catalog (M1-10-a's add-ons.v2.json) is not in this checkout.");
    if (result.warnings?.length > 0) L.push('', 'Check first', ...result.warnings.map((w) => `  - ${w}`));
    return `${L.join('\n')}\n`;
  }
  if (result.pending === 'twin') L.push("Read and encoded, not accepted yet: format 2's check (M1-10's twin) is not in this checkout.");
  else if (!result.ok) {
    L.push(`Refused: the factory's check (format 2, ${result.network}) does not accept this spec yet.`);
    L.push(...pad([['Field', e.field], ['Why', e.sentence], ['Fix', e.fix], ['Check', `${e.reason} at ${e.field} (reason ${e.reasonCode}, field ${e.fieldId})`]]));
    L.push('The check stops at the first problem: fix it and run it again.');
    return `${L.join('\n')}\n`;
  } else L.push(`Valid${result.draft ? ' draft' : ''}: the factory's check (format 2, ${result.network}) accepts this spec.`);
  L.push(`${result.draft ? 'Draft hash' : 'Spec hash'}: ${result.specHash}`, '', 'Overview', ...pad(result.overview));
  if (result.warnings.length > 0) L.push('', 'Check first', ...result.warnings.map((w) => `  - ${w}`));
  if (result.notes.length > 0) L.push('', 'Tell the creator', ...result.notes.map((n) => `  - ${n}`));
  if (result.menuSource === 'copy') L.push('', `Listings: the offline copy of ${result.menuWrittenAt}; a newer listing shows with --listings <file> or --indexer <url>.`);
  return `${L.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------ menu and presets

/** Current M1 menu; no executable outside conversion or recipe builder. */
export function renderMenuV2(model) {
  const L = [`What a format 2 box can be on ${model.menu.label} (release ${model.menu.release.name}).`];
  L.push('', 'Price coins (one permanent listing per coin; the lister sets its raise):');
  for (const l of model.menu.listings.filter((row) => !row.retired)) {
    L.push(`  "${l.symbol}" ${l.label}, listing ${l.id}${byRuleNote(l)}: raise ${decimalText(l.raise, l.decimals)} ${l.symbol}. ${l.powers?.join(' ') ?? ''}`);
  }
  L.push('', 'Fees on each side: keep, buy back and burn, grow the pool, to holders, to items, eat the price coin.', '1% of every buy and sale, in the price coin. Of each fee: 2/15 FIT, 1/15 platform, 2/15 pool, 10/15 your choice.');
  L.push('Eat uses a checked burn or a permanent dead-address lock after graduation; show Burn <coin> or Lock <coin> from the listing capability. No splits, creator caps or plug-ins.', 'Add-ons: placeholders, edition-specials, royalties, collection-metadata.');
  L.push('Refresh the listing before creation. If its raise changed, rebuild the spec and quote, then mine both salts again. Existing boxes keep their creation raise.');
  return `${L.join('\n')}\n`;
}

/** A draft made from a preset (F89; § 9 item 8): the preset's spec with what it asks for, `{ preset: { id, version } }` kept off chain. */
export function fromPreset(preset, fill = {}) {
  for (const key of Object.keys(fill)) if (!(preset.asks ?? []).includes(key)) throw new Error(`The preset ${preset.id} does not ask for ${key}.`);
  return { format: DRAFT_FORMAT_V2, preset: { id: preset.id, version: preset.version }, spec: { ...preset.spec, ...fill } };
}

