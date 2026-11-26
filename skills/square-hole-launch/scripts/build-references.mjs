#!/usr/bin/env node
/**
 * Builds the launch skill's generated references from the BoxSpec sources, so they never drift from the spec:
 *   - references/fields.md            every field, member, add-on and setting in plain words, from box-spec.v1.json,
 *                                     add-ons.v1.json and plain-words.v1.json (structure from the spec, words from
 *                                     plain-words; planned values listed as coming soon until the spec has them)
 *   - references/decisions.md         only the block between the `generated:curve` markers: what each raise preset
 *                                     and creator buy come to, computed with the layout library (bigint)
 *   - references/examples/README.md   the index of the worked examples, each checked with the factory's validator
 *   - references/v2/fields.md         format 2 (M1-11): every field, member and settings struct, from M1-00's frozen
 *                                     shapes (SpecTypes.sol, RecipeTypes.sol) and their comments
 *   - references/v2/README.md         the index of the format 2 examples, configurations and presets, each read
 *                                     against its network's menu (and checked by M1-10's twin once it exists)
 *
 * `--check` also fails when a decision id in a generated line is not marked "ref." (never quoted to a creator), when an
 * example departs from the skill's advice without saying why (`deviations`), when prose still calls a value coming
 * soon that the spec now has, or says "coming soon" about something no plain-words entry names (spec-soon.mjs), and
 * when the skill or a format 2 file names a registry pending step that no example row is pending on any more.
 *
 * Usage (from the repository root):
 *   node skills/square-hole-launch/scripts/build-references.mjs           write (pnpm launch-skill:write)
 *   node skills/square-hole-launch/scripts/build-references.mjs --check   exit 1 when stale, when an example does not
 *                                                                         validate, or when plain words are missing
 *                                                                         (pnpm check:launch-skill, in pnpm verify)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hiddenKitRoute, kitReferences } from './kit-references.mjs';
import { jsonSchema as registrySchema, loadExamples as loadRegistry } from '../../../packages/box-spec/examples/v2/registry.mjs';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(skillDir, '../..');
const boxSpecLib = join(repoDir, 'packages/box-spec/scripts/lib');
const { loadBoxSpecLibrary, loadBoxSpecV2Library } = await import(join(boxSpecLib, 'load-generated.mjs'));
const check = await import(join(boxSpecLib, 'check-spec.mjs'));
const { MARKER, addOnValues, allowedText, approxText, buyShareBps, checkSpec, contextUnit, curveValues, decimalText, groupedInt, memberLabel, memberText, missingPlainWords, modelFor, paramText, percentText, plainWordUnits, plannedItems, qUnit, soonFindings } = check;

const v2 = await import(join(boxSpecLib, 'spec-launch-v2.mjs'));
const { paramsOfMember } = await import(join(boxSpecLib, 'spec-types-v2.mjs'));

const lib = await loadBoxSpecLibrary();
const model = modelFor(lib);
const context = model.contexts.at(-1);
const refs = join(skillDir, 'references');
const PATHS = { fields: join(refs, 'fields.md'), decisions: join(refs, 'decisions.md'), examples: join(refs, 'examples'), skill: join(skillDir, 'SKILL.md'), specJson: join(refs, 'spec-json.md') };
const GENERATED_BY = 'skills/square-hole-launch/scripts/build-references.mjs';

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const constant = (name) => BigInt(model.constants.get(name).value);
const plain = model.plain;
const vars = { T: 'the token', Q: contextUnit(context) };
const label = (text) => text.replace(/\{T\}/g, vars.T).replace(/\{Q\}/g, vars.Q);
/** Decision rows and slices behind an entry, for maintainers (never in what the checker tells the creator). */
const ref = (p) => (p?.source ? ` (ref. ${p.source})` : '');

// ------------------------------------------------------------------------------------------------ fields.md

function memberTable(enumName, offered) {
  const e = model.enums.get(enumName);
  const L = ['| Value | Plain label | What it means | Offered now |', '|---|---|---|---|'];
  for (const m of e.members) {
    const p = plain.enums[enumName]?.[m.name] ?? {};
    const isOffered = !offered || offered.includes(m.name);
    const not = p.notOffered ?? 'not offered';
    const status = isOffered ? (p.limits ? `yes, ${p.limits}` : 'yes') : `${/^never/.test(not) ? 'no' : 'not yet'}: ${not}${ref(p)}`;
    L.push(`| \`"${m.name}"\` | ${cell(memberLabel(model, enumName, m.name, vars))} | ${cell(memberText(model, enumName, m.name, vars))} | ${cell(status)} |`);
  }
  for (const item of plannedItems(model).filter((x) => x.kind === 'member' && x.enumName === enumName)) {
    L.push(`| \`"${item.name}"\` | ${cell(label(item.plain.label))} | ${cell(label(item.plain.plain))} | ${cell(item.plain.planned)}${cell(ref(item.plain))} |`);
  }
  return L;
}

function fieldBlock(f, n) {
  const p = plain.fields[f.name];
  const L = [`### ${n} ${p.label} · \`${f.name}\``, '', p.what, ''];
  L.push(`- **Set by:** ${p.setBy}.`);
  if (f.type !== 'AddOn[]') L.push(`- **Allowed now:** ${allowedText(model, f, context)}.`);
  L.push(`- **Default:** ${p.default}.`);
  L.push(`- **Tell the creator:** ${p.tell}`);
  if (p.accepts) L.push(`- **The checker accepts:** ${p.accepts}.`);
  for (const a of p.plannedAssets ?? []) L.push(`- **Planned:** ${a.label}: ${a.status}${ref(a)}.`);
  const canEnter = plain.launchFlowCanEnter ?? {};
  if ((canEnter.zeroFields ?? []).includes(f.name)) L.push(`- **The launch flow:** always writes zero; \`"${MARKER}"\` in a draft means that zero.`);
  if (f.name === 'tStream') L.push('- **The launch flow:** offers each side on its own (any pair the check accepts).');
  if (f.enum) L.push('', ...memberTable(f.enum, f.check?.offered));
  return [...L, ''];
}

function addOnBlock(a) {
  const p = plain.addOns[a.key];
  const versions = a.versions.includes(context.version) ? `version ${a.versions.join(' and ')}` : `version ${a.versions.join(' and ')} only (not for new boxes)`;
  const L = [`### ${p.label} · \`"${a.key}"\` (id ${a.id})`, '', p.what, '', `- **Available in:** ${versions}${a.repeatable ? '; may appear more than once' : ''}.`];
  if (a.boxTypes) L.push(`- **Box types:** ${a.boxTypes.map((b) => `\`${b}\``).join(', ')}.`);
  // Plain words give one sentence for every requirement (listed once) or one per requirement, in the catalog's order.
  const needOf = (r, i) => (Array.isArray(p.conflict) ? p.conflict[i]?.sentence : p.conflict?.sentence) ?? r.why;
  for (const need of new Set((a.requires ?? []).map(needOf))) L.push(`- **Needs:** ${need}`);
  const max = plain.launchFlowCanEnter?.maxRepeats?.[a.key];
  L.push(`- **Tell the creator:** ${max === undefined ? p.tell : p.tell.replace('{launchFlowMax}', String(max))}`, '');
  if (p.launchFlow) {
    const lf = p.launchFlow;
    L.push(
      'What the launch flow writes itself (the checker uses these for `"FROM_LAUNCH_FLOW"`; the creator can change only',
      `${lf.editable.map((x) => `\`${x}\``).join(' and ')} there):`,
      '',
      `- \`placeholderName\`: the ${lf.nameFrom === 'collectionName' ? 'collection name' : lf.nameFrom} cut to ${lf.nameMax} characters, then "${lf.nameSuffix.trim()}".`,
      `- \`placeholderSymbol\`: the ${lf.symbolFrom === 'collectionSymbol' ? 'collection symbol' : lf.symbolFrom} cut to ${lf.symbolMax} characters, then "${lf.symbolSuffix}".`,
      `- \`placeholderDescription\`: "${lf.placeholderDescription}"`,
      `- \`hiddenDescription\`: "${lf.hiddenDescription}"`,
      `- \`hiddenSvg\` (the neutral picture, ${groupedInt(lf.hiddenSvg.length)} characters):`,
      '',
      '```svg',
      lf.hiddenSvg,
      '```',
      '',
    );
  }
  if (a.params.length > 0) {
    L.push('| Setting | What | Allowed | Default |', '|---|---|---|---|');
    for (const param of a.params) {
      const pp = p.params[param.name];
      // With the context, amount menus (the fee cap, F74 U2) read in whole units of the pricing asset, as --menu shows them.
      L.push(`| \`${param.name}\` (${cell(pp.label)}) | ${cell(pp.what)} | ${cell(paramText(model, param, context))} | ${cell(pp.default)} |`);
    }
    L.push('');
  }
  return L;
}

function fixedValues() {
  const lp = constant('LP_FEE');
  const share = (name) => `${constant(name)}/${constant('FEE_SHARE_DENOMINATOR')}`;
  const pips = (name) => `${decimalText(constant(name), 4)}%`;
  const span = Number(constant('CURVE_SPAN_TICKS'));
  return [
    `- **Supply:** ${decimalText(constant('ISSUANCE'), 18)} tokens per box, about ${percentText((constant('CURVE_SHARE_TARGET') * 10000n) / constant('ISSUANCE'))} of them on the curve.`,
    `- **Curve:** the price rises about ${(1.0001 ** span).toFixed(1)} times from the first buy to the last (a span of ${groupedInt(span)} ticks).`,
    `- **Fee:** ${decimalText(lp, 4)}% on every trade. Of each fee: ${share('FEE_SHARE_Q_STREAM')} as the creator chose (the fee kinds), ${share('FEE_SHARE_FIT')} to FIT buy-and-burn, ${share('FEE_SHARE_DEPTH')} into the box's own pool (paired and locked, owned by the box).`,
    `- **Launch window:** the first ${Number(constant('WINDOW_SECONDS')) / 60} minutes after the open (${constant('WINDOW_STEPS')} steps of ${constant('TAX_STEP_SECONDS')} seconds) carry a falling tax from ${pips('LAUNCH_TAX_PIPS_BLOCK_0')} to ${pips('LAUNCH_TAX_PIPS_BLOCK_31')}; in every box it stays in the box: its pool after graduation, or the refund range if the box fails (the Misfits have no refund range, so theirs waits until they graduate).`,
    `- **Creation:** ${decimalText(constant('BOOTSTRAP_ETH'), 18)} ETH bootstrap buy (burned) plus gas (estimate: about 4-5 million gas plus about 200 gas per byte of box data such as the trait table; the Overview page shows it) and the creator's ETH at start, from the creator's wallet; at most ${constant('MAX_ADD_ONS')} add-ons.`,
    `- **Items out and back (after graduation):** at launch one item is 1/n of all tokens; as burns shrink the supply it takes fewer (the tokens in circulation divided by the items still in the box, as in the Misfits' vault). Hidden art: a random draw for a ${percentText(constant('DRAW_FEE_BPS'))} draw fee, and an item that was returned picked by name for ${percentText(constant('PICK_FEE_BPS'))} more. Open art: no draw (nothing is hidden); any item still in the box picked by its number for ${percentText(constant('PICK_FEE_BPS'))} more. ${percentText(constant('RETURN_FEE_BPS'))} off when an item is returned. Fees burned.`,
    '- **Pool after graduation:** the box\'s own Uniswap v4 pool; the box owns its liquidity, nobody can withdraw it and nobody else can add any (ref. F49 D3, F72 (B)).',
    '- **Failure:** a box that misses its deadline stops buying and every token sells back for the same amount from the refund range (the curve\'s collection, the launch tax and held fees), not what each buyer paid (ref. launch pipeline § 3.7).',
    '- **Fixed forever once created:** name, ticker, logo, description and every value above (ref. F23 C2, F72 (2)).',
  ];
}

function renderFields() {
  // F74 U5: one raise per pricing asset, set by the version (several presets only in an older context).
  const raiseWords = (q) => (q.raisePresets.length === 1 ? `the one raise: ${decimalText(q.raisePresets[0], q.decimals)} ${qUnit(q)}` : `raise presets ${q.raisePresets.map((x) => decimalText(x, q.decimals)).join(', ')} ${qUnit(q)}`);
  const ctxLine = context.json.qList.map((q) => `${q.label} (${raiseWords(q)})`).join('; ');
  const L = [
    '# BoxSpec fields in plain words',
    '',
    `> Generated by \`${GENERATED_BY}\` from \`packages/box-spec/box-spec.v1.json\`, \`add-ons.v1.json\` and`,
    '> `plain-words.v1.json`: do not edit (run `pnpm launch-skill:write`). For what is offered at this moment, run',
    '> `node scripts/check.mjs --menu` from the skill\'s folder (or `pnpm box-spec:check --menu` in the folder it ships in): it',
    '> reads the same sources at run time. "ref." names the decision rows and slices behind an entry: never quote them.',
    '',
    `Every new box uses context \`${context.name}\` (version ${context.version}): ${ctxLine}.`,
    '',
    'How to write values in a draft (details in [spec-json.md](spec-json.md)): choices by name (`"TO_CREATOR"`),',
    'amounts as `{ "decimal": "0.05" }` in whole units of the pricing asset, counts as plain numbers, the opening time as',
    '`0` (Now) or a UTC time as text, `"2026-10-06T18:00:00Z"`, and',
    `\`"${MARKER}"\` for what the launch flow fills in (art fingerprints, the connected wallet). Never ask for a key.`,
    '',
  ];
  let n = 0;
  for (const [i, step] of plain.steps.entries()) {
    L.push(`## ${step.id === 'fixed' ? '' : `${i + 1}. `}${step.title}`, '');
    for (const name of step.fields) {
      const f = model.fieldByName.get(name);
      if (!f) continue;
      n += 1;
      L.push(...fieldBlock(f, `${i + 1}.${step.fields.indexOf(name) + 1}`));
      if (f.type === 'AddOn[]') for (const a of model.catalog.addOns) L.push(...addOnBlock(a));
    }
  }
  const planned = plannedItems(model).filter((x) => x.kind === 'addOn');
  if (planned.length > 0) {
    L.push('## Coming soon: add-ons not in this spec yet', '');
    for (const item of planned) {
      L.push(`### ${item.plain.label} · \`"${item.key}"\``, '', `${item.plain.what} Planned: ${item.plain.planned}${ref(item.plain)}.`, '', `- **Tell the creator:** ${item.plain.tell}`, '');
      L.push('| Setting | What | Default |', '|---|---|---|');
      for (const [name, pp] of Object.entries(item.plain.params ?? {})) L.push(`| \`${name}\` (${cell(pp.label)}) | ${cell(pp.what)} | ${cell(pp.default)} |`);
      L.push('');
    }
  }
  L.push('## Fixed for every box (never asked)', '', ...fixedValues(), '');
  L.push('## Rules between fields', '', '| Rule | Fix |', '|---|---|');
  for (const sentence of new Set(model.rules.map((r) => r.name))) {
    const p = plain.rules[sentence];
    L.push(`| ${cell(p.sentence)} | ${cell(p.fix)} |`);
  }
  L.push('', '## Refusal reasons', '', 'The checker names the field and turns each into a sentence with a fix; this is what the codes mean.', '', '| Code | Reason | Meaning |', '|---|---|---|');
  for (const r of model.spec.reasons) L.push(`| ${r.code} | \`${r.name}\` | ${cell(plain.reasons[r.name])} |`);
  L.push('', `${n} fields, ${model.catalog.addOns.length} add-ons in the catalog.`, '');
  return L.join('\n');
}

// ------------------------------------------------------------------------------------------------ decisions.md block

/** Creator buys shown in the table: [label, wei]. */
const BUYS = [['0.01', 1n], ['0.02', 2n], ['0.03', 3n], ['0.05', 5n], ['0.1', 10n], ['0.25', 25n], ['0.5', 50n]].map(([text, hundredths]) => [text, hundredths * 10n ** 16n]);
const ITEM_EXAMPLES = [10n, 250n, 1000n];

function curveBlock() {
  const eth = context.json.qList.find((q) => q.qClass === 'NATIVE_ETH');
  const L = [
    '<!-- generated:curve (build-references.mjs: do not edit by hand) -->',
    `| Raise | Market cap (all tokens) at the first buy | at graduation | Creator's ETH at start buys: ${BUYS.map(([text]) => text).join(' | ')} ETH |`,
    `|---|---|---|${BUYS.map(() => '---|').join('')}`,
  ];
  const items = [];
  for (const raise of eth.raisePresets.map(BigInt)) {
    const { curve, first, graduation } = curveValues(model, raise);
    const shares = BUYS.map(([, b]) => (b < raise ? percentText(buyShareBps(model, curve, b)) : 'n/a'));
    L.push(`| ${decimalText(raise, 18)} ETH | ${approxText(first)} ETH | ${approxText(graduation)} ETH | ${shares.join(' | ')} |`);
    items.push(`${decimalText(raise, 18)} ETH: ${ITEM_EXAMPLES.map((n) => `${groupedInt(n)} items ${approxText(first / n)} / ${approxText(graduation / n)}`).join(', ')}`);
  }
  L.push(
    '',
    `At launch one item is 1/n of all tokens, so it is worth the market cap divided by n (ETH at the first buy / at graduation; burns lower the tokens an item takes later): ${items.join('; ')}.`,
    'In dollars: today\'s ETH price times these, labelled as a conversion (`scripts/check.mjs --numbers --eth-usd <price>`).',
    '',
    'Native ETH; the layout library (`boxCurve`, `curveBuyOut`), bigint, 1,000,000,000 tokens, rounded. Estimates for display: the factory\'s own swap is the truth.',
    '<!-- /generated:curve -->',
  );
  return L.join('\n');
}

function renderDecisions(current) {
  const start = current.indexOf('<!-- generated:curve');
  const end = current.indexOf('<!-- /generated:curve -->');
  if (start < 0 || end < 0) throw new Error(`${relative(repoDir, PATHS.decisions)} has no generated:curve markers`);
  return `${current.slice(0, start)}${curveBlock()}${current.slice(end + '<!-- /generated:curve -->'.length)}`;
}

// ------------------------------------------------------------------------------------------------ examples

/** Where a valid example departs from plain-words `advice` (the creator-buy share, the royalties): [] when it follows it. */
function departures(doc, result) {
  const advice = plain.advice ?? {};
  const out = [];
  if (!result.ok) return out;
  const read = check.readDocument(doc, model);
  const { wire } = check.buildWire(model, read.spec, read.context);
  const eth = context.json.qList.find((q) => q.qClass === 'NATIVE_ETH');
  if (BigInt(wire.creatorBuy) > 0n && eth && wire.q.toLowerCase() === eth.token.toLowerCase()) {
    const share = buyShareBps(model, curveValues(model, wire.raise).curve, wire.creatorBuy);
    if (share > BigInt(advice.creatorBuyMaxBps ?? 500)) out.push(`a creator buy of ${percentText(share)}`);
  }
  const royalty = wire.addOns.find((e) => model.addOnById.get(e.id)?.key === 'royalties');
  const v = royalty ? addOnValues(model, royalty) : { bps: 0 };
  const destination = royalty ? model.enums.get('RoyaltyDestination').members.find((m) => m.value === Number(v.destination))?.name : undefined;
  const ok = (advice.royalties ?? []).some((r) => BigInt(r.bps) === BigInt(v.bps) && (r.destination === undefined || r.destination === destination));
  if (!ok) out.push(`royalties ${percentText(BigInt(v.bps))}${destination ? ` ${destination}` : ''}`);
  return out;
}

function loadExamples(problems) {
  const files = readdirSync(PATHS.examples).filter((f) => f.endsWith('.json') && f !== 'waiting.json').sort();
  const loaded = files.map((file) => {
    const doc = JSON.parse(readFileSync(join(PATHS.examples, file), 'utf8'));
    const result = checkSpec(model, doc);
    if (!result.ok) problems.push(`examples/${file}: ${result.explanation ? `${result.explanation.reason} at ${result.explanation.field}: ${result.explanation.sentence}` : result.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
    for (const key of ['brief', 'status', 'shows', 'differences']) if (doc[key] === undefined) problems.push(`examples/${file}: "${key}" is missing`);
    if (!['ready', 'stand-in'].includes(doc.status)) problems.push(`examples/${file}: status must be "ready" or "stand-in"`);
    if (doc.status === 'stand-in' && !(doc.differences?.length > 0)) problems.push(`examples/${file}: a stand-in lists its differences`);
    if (!Number.isInteger(doc.example)) problems.push(`examples/${file}: "example" (its number in the example set) is missing`);
    const departs = departures(doc, result);
    if (departs.length > 0 && !(doc.deviations?.length > 0)) problems.push(`examples/${file}: departs from the skill's advice (${departs.join('; ')}) without saying why in "deviations"`);
    return { file, doc, result };
  });
  return loaded.sort((a, b) => (a.doc.example ?? 0) - (b.doc.example ?? 0));
}

function renderExamples(examples) {
  const waiting = JSON.parse(readFileSync(join(PATHS.examples, 'waiting.json'), 'utf8')).waiting;
  const L = [
    '# Worked examples',
    '',
    `> Generated by \`${GENERATED_BY}\` from the JSON files here; every draft is checked with the factory's validator`,
    '> (`pnpm box-spec:check <file>`) in `pnpm verify`. Do not edit this index by hand.',
    '',
    'The Square Hole example boxes (ref. F72, F73). Each file is a complete draft with the brief that led to it. **ready**:',
    'the spec says everything the brief asks. **stand-in**: the nearest box the spec allows today; `differences`',
    'says what is still coming. Use them as patterns: copy the closest one, then change what the creator wants.',
    '',
    '| # | Example | Status | Kind of box | Shows |',
    '|---|---|---|---|---|',
  ];
  for (const { file, doc, result } of examples) {
    const rows = Object.fromEntries(result.overview ?? []);
    const kind = `buyers: ${rows["Buyers' fees"] ?? '?'}; sellers: ${rows["Sellers' fees"] ?? '?'}`;
    L.push(`| ${doc.example} | [${doc.spec.tokenName} (${doc.spec.tokenSymbol})](${file}) | ${doc.status} | ${cell(kind)} | ${cell(doc.shows.join('; '))} |`);
  }
  L.push('', '## Briefs and differences', '');
  for (const { file, doc } of examples) {
    L.push(`### ${doc.spec.tokenName} · [${file}](${file})`, '', doc.brief, '');
    for (const d of doc.differences) L.push(`- ${d}`);
    for (const d of doc.deviations ?? []) L.push(`- Departs from the advice on purpose: ${d}`);
    if (doc.differences.length + (doc.deviations?.length ?? 0) > 0) L.push('');
  }
  L.push('## Waiting for the spec', '', 'These briefs cannot be expressed yet. Tell a creator who wants one what is missing and offer the nearest box.', '');
  for (const w of waiting) {
    L.push(`### ${w.name} (${w.ticker})`, '', w.brief, '', ...w.needs.map((x) => `- Needs: ${x}.`), `- Nearest today: ${w.nearestToday}`, '');
  }
  return L.join('\n');
}

// ------------------------------------------------------------------------------------------------ decision ids

const DECISION_ID = /\b(?:F\d{2}|slice S\d+|BC-\d+|BP-\d+|FLR-\d+)\b/g;

/** Decision ids in generated text outside a "(ref. ...)" group: they must never reach a creator unmarked. */
function unmarkedIds(path, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const open = [];
    const marked = [];
    for (let at = 0; at < line.length; at++) {
      if (line[at] === '(') open.push(at);
      if (line[at] === ')') open.pop();
      marked[at] = open.some((o) => line.startsWith('(ref. ', o));
    }
    for (const m of line.matchAll(DECISION_ID)) if (!marked[m.index]) out.push(`${path}:${i + 1}: decision id ${m[0]} outside "(ref. ...)"`);
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ format 2 (M1-11)

const v2Dir = join(refs, 'v2');
const V2_DIRS = ['examples', 'configurations', 'presets'];
const v2Files = () => V2_DIRS.flatMap((dir) => (existsSync(join(v2Dir, dir)) ? readdirSync(join(v2Dir, dir)).filter((f) => f.endsWith('.json')).sort().map((file) => ({ dir, file, doc: JSON.parse(readFileSync(join(v2Dir, dir, file), 'utf8')) })) : []));
const V2_HEADER = (what) => `> Generated by \`${GENERATED_BY}\` ${what}; do not edit it by hand.`;

/** references/v2/fields.md: the frozen shapes and their own comments (rules and plain words come with M1-10). */
function renderFieldsV2() {
  const shapes = v2.readShapes();
  const recipe = v2.modelForV2({ network: 'demo' }).sources.spec.recipe;
  const L = ['# Format 2 fields', '', V2_HEADER("from M1-00's frozen shapes (`packages/contracts/src/box-v2/interfaces/SpecTypes.sol`, `RecipeTypes.sol`)"), '> Each text is the shape\'s own comment. The rules, presets and plain words come with M1-10 (`box-spec.v2.json`, `plain-words.v2.json`); decision ids in the comments are for maintainers, never for a creator.', ''];
  const table = (rows, head) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`), ''];
  L.push('## BoxSpec', '', ...table(shapes.structs.get('BoxSpec').map((f, id) => [id, `\`${f.name}\``, f.type, f.doc]), ['Id', 'Field', 'Type', 'What the frozen shape says']));
  for (const name of ['BoxType', 'GradLayout', 'FeeChoice', 'Leg', 'Dest', 'Split', 'HoldersCurrency', 'ItemsInsidePolicy']) {
    const e = shapes.enums.get(name);
    const settings = (m) => ['legParams', 'destParams', 'splitParams'].map((w) => recipe[{ legParams: 'legs', destParams: 'dests', splitParams: 'splits' }[w]]?.[m.name]?.params ?? paramsOfMember(m, w)).filter(Boolean).map((x) => `\`${x}\``).join(', ') || 'none';
    L.push(`## \`${name}\``, '', e.doc, '', ...table(e.members.slice(1).map((m) => [m.value, `\`"${m.name}"\``, settings(m), m.doc]), ['Value', 'Name', 'Settings', 'What it does']));
  }
  for (const name of ['Pricing', 'AddOn', 'Branch', 'Side', 'HoldersDestParams', 'ItemsDestParams', 'PileParams', 'PileParamsV21', 'Listing', 'ReleaseContext', 'ShopConfigV2']) {
    L.push(`## \`${name}\``, '', ...table(shapes.structs.get(name).map((f) => [`\`${f.name}\``, f.type, f.doc]), ['Setting', 'Type', 'What the frozen shape says']));
  }
  return `${L.join('\n').trimEnd()}\n`;
}

/** A token as a draft names it: a listed token's symbol, { boxToken } (a manually listed box token), or a listing id. */
const tokenText = (t) => (typeof t === 'string' ? t : t?.boxToken ? `box token ${t.boxToken}` : t?.listingId !== undefined ? `listing ${t.listingId}` : '');

const sideText = (side) => {
  const branch = (b) => (b ? `${b.leg} → ${b.dest}${b.destParams?.insidePolicy ? ` (${b.destParams.insidePolicy})` : b.legParams?.listing ? ` (${tokenText(b.legParams.listing)})` : ''}` : '');
  if (!side) return '';
  if (side.split === 'NoSplit') return branch(side.a);
  const how = side.split === 'Cap30Days' ? `cap preset ${side.splitParams?.preset}` : side.split === 'PlugIn' ? `rule "${side.splitParams?.plugIn}"` : `${side.splitParams?.bpsToA} bps`;
  return `${branch(side.a)}, ${branch(side.b)} (${how})`;
};

/** references/v2/README.md: what each format 2 file is, from the files themselves. */
function renderIndexV2(files) {
  const L = ['# Format 2 worked examples, configurations and presets', '', V2_HEADER('from the JSON files here; `pnpm check:launch-skill` reads every one against its network\'s menu'), ''];
  L.push('For the twelve Sepolia kits, [start from a kit](kits/README.md): use its settings file, Load settings, then choose the verified listing. Each worked guide includes the exact registry row and its loading instructions. L1\'s ten other kit filenames are unchanged; both hidden kits have public settings templates and plan manifests. Alchemist remains pending and refused.', '', hiddenKitRoute, '');
  L.push('Payouts are claim-only: each owner claims its own funds. Owner claims have no minimum or tip. Wallets, contracts and EIP-7702 owners use the same owner claim entry. The FIT and platform Safes claim their own fee shares. Collection and protocol-step tips are separate from owner payouts.', '');
  L.push('The draft JSON files below exercise the offline demo menu; they are not app settings downloads or live deployments. Items use explicit Keep, BuyBackBurn or Depth policies. Shops use seed, pick receipts and the selected sellers fee funding up to a fixed ceiling. A same-price-coin pile can receive pending fees after graduation. Pile redemptions leave 0 or 500 basis points; the last redeemer takes the balance. Exit Liquidity has 404 open signs, Grow buyers and item payouts with BuyBackBurn inside on sellers. A preset keeps its id and version off chain. Refresh the listing raise, quote and both mined salts before Create.', '');
  const name = (doc) => (doc.example !== undefined ? `${doc.example} ${doc.spec.tokenName} (${doc.spec.tokenSymbol})` : (doc.configuration ?? doc.name));
  const row = ({ dir, file, doc }) => [`[${name(doc)}](${dir}/${file})`, doc.status ?? doc.network ?? '', tokenText(doc.spec.pricing), sideText(doc.spec.buyers), sideText(doc.spec.sellers)];
  const order = (a, b) => (a.doc.example ?? 0) - (b.doc.example ?? 0);
  for (const [dir, title] of [['examples', 'Examples'], ['configurations', 'Configurations'], ['presets', 'Presets']]) {
    L.push(`## ${title}`, '', '| File | Status or network | Paired with | Buyers\' fees | Sellers\' fees |', '|---|---|---|---|---|', ...files.filter((f) => f.dir === dir).sort(order).map((f) => `| ${row(f).map(cell).join(' | ')} |`), '');
  }
  return `${L.join('\n').trimEnd()}\n`;
}

/** Reads every format 2 file against its menu: input problems and refusals fail; pending M1-10 parts are counted. */
async function checkV2(files, problems) {
  const twin = await v2.loadTwinV2();
  const models = new Map();
  const v2Lib = await loadBoxSpecV2Library();
  const modelOf = (network) => models.get(network) ?? models.set(network, v2.modelForV2({ network, twin, curve: v2Lib })).get(network);
  const counts = { read: 0, pending: 0, twin: Boolean(twin), curve: [] };
  for (const { dir, file, doc } of files) {
    const at = `skills/square-hole-launch/references/v2/${dir}/${file}`;
    let r;
    try {
      r = v2.checkSpecV2(modelOf(doc.network ?? 'demo'), dir === 'presets' ? v2.fromPreset(doc) : doc);
    } catch (error) {
      // A checker fault must fail the check, but must not prevent reporting the other files or writing the index.
      problems.push(`${at}: checker error: ${error.message}`);
      continue;
    }
    // Reported, not failed, while founder question M1-11-Q1 is open: a box the curve cannot hold cannot be created.
    if (r.warnings?.some((w) => w.includes('RAISE_NOT_BUILDABLE'))) counts.curve.push(`${dir}/${file}`);
    if (r.pending === 'catalog') counts.pending += 1;
    else if (r.stage !== 'check' || r.format1) problems.push(`${at}: ${r.problems?.map((p) => `${p.path}: ${p.message}`).join('; ') ?? r.message ?? 'not a format 2 draft'}`);
    else if (!r.ok && r.pending !== 'twin') problems.push(`${at}: refused: ${r.explanation?.sentence}`);
    else counts.read += 1;
  }
  // F99/F100 and F86 E: format 2's prose says "closing price" and "with M2", never the old words.
  for (const path of [PATHS.skill, join(v2Dir, 'spec-json.md')]) {
    const text = readFileSync(path, 'utf8');
    for (const old of [/refund/i, /pending legal review/i]) if (old.test(text)) problems.push(`${relative(repoDir, path)}: says ${old.source}; format 2 says "closing price" and "with M2"`);
  }
  return counts;
}

/**
 * SH-EX-LMV2 fix round: the skill names a registry pending step only while some example row is pending on it. Text
 * that says the registry awaits a step no row waits on tells a creator that a ready recipe is still unverified.
 */
function staleRegistrySteps(texts) {
  const open = new Set(loadRegistry().filter((row) => row.status === 'pending').map((row) => row.pendingStep));
  const stale = registrySchema.properties.pendingStep.enum.filter((step) => !open.has(step));
  return texts.flatMap(({ path, text }) => stale.filter((step) => text.includes(step))
    .map((step) => `${path}: names ${step}, but no registry row is pending on it; say what the row is now`));
}

// ------------------------------------------------------------------------------------------------ main

const problems = [];
const missing = missingPlainWords(model);
if (missing.length > 0) problems.push(`packages/box-spec/plain-words.v1.json has no entry for: ${missing.join(', ')}`);
const examples = loadExamples(problems);
const readme = join(PATHS.examples, 'README.md');
const outputs = [
  [PATHS.fields, `${renderFields()}`],
  [PATHS.decisions, renderDecisions(readFileSync(PATHS.decisions, 'utf8'))],
  [readme, renderExamples(examples)],
];

const filesV2 = v2Files();
const v2Counts = await checkV2(filesV2, problems);
const outputsV2 = [
  [join(v2Dir, 'fields.md'), renderFieldsV2()],
  [join(v2Dir, 'README.md'), renderIndexV2(filesV2)],
  ...kitReferences().map(([path, content]) => [join(v2Dir, path), content]),
];
problems.push(...staleRegistrySteps([
  ...[PATHS.skill, join(v2Dir, 'spec-json.md'), ...filesV2.map(({ dir, file }) => join(v2Dir, dir, file))]
    .map((path) => ({ path: relative(repoDir, path), text: readFileSync(path, 'utf8') })),
  ...outputsV2.map(([path, content]) => ({ path: relative(repoDir, path), text: content })),
]));

const checkOnly = process.argv.includes('--check');
const stale = [];
for (const [path, content] of [...outputs, ...outputsV2]) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === content) continue;
  if (checkOnly) stale.push(relative(repoDir, path));
  else {
    writeFileSync(path, content);
    process.stdout.write(`wrote ${relative(repoDir, path)}\n`);
  }
}
if (stale.length > 0) problems.push(`stale generated references (run \`pnpm launch-skill:write\`): ${stale.join(', ')}`);
for (const [path, content] of outputs) problems.push(...unmarkedIds(relative(repoDir, path), path === PATHS.decisions ? curveBlock() : content));
const prose = [PATHS.skill, PATHS.decisions, PATHS.specJson, readme].map((path) => ({ path: relative(repoDir, path), text: path === readme ? renderExamples(examples) : readFileSync(path, 'utf8') }));
prose.push({ path: 'packages/box-spec/plain-words.v1.json', units: plainWordUnits(model) });
for (const f of soonFindings(model, prose)) {
  problems.push(f.kind === 'stale' ? `${f.at}: says ${f.entry} is not available yet, but the spec has it now: update the text ("${f.text}")` : `${f.at}: "coming soon" names nothing plain-words knows: add soonWords to the entry, or reword ("${f.text}")`);
}
if (problems.length > 0) {
  console.error(`check:launch-skill:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
process.stdout.write(`check:launch-skill: ${examples.length} example drafts valid; ${outputs.length} generated references ${checkOnly ? 'are up to date' : 'written'}\n`);
const pendingV2 = v2Counts.pending > 0 ? `, ${v2Counts.pending} wait for M1-10-a's add-on catalog` : '';
process.stdout.write(`check:launch-skill: format 2: ${filesV2.length} files, ${v2Counts.read} read and encoded${pendingV2}; ${v2Counts.twin ? "checked by M1-10's twin" : "verdicts wait for M1-10's twin"}; ${outputsV2.length} generated references ${checkOnly ? 'are up to date' : 'written'}\n`);
if (v2Counts.curve.length > 0) process.stdout.write(`check:launch-skill: format 2: ${v2Counts.curve.length} cannot be created as written, the curve cannot hold a raise they name (M1-11-Q1): ${v2Counts.curve.join(', ')}\n`);
