/**
 * A validator verdict (reason, field) as one plain sentence and a fix (F73 launch skill). The sentence comes from the
 * failing check itself: a rule (box-spec.v1.json `rules`), a field check (its kind, bounds, offered members, string
 * rule), an add-on check (versions, box types, `requires`, its parameters). Labels and fixes come from
 * plain-words.v1.json. Part of scripts/check-spec.mjs.
 */
import { addOnValues } from './spec-input.mjs';
import {
  MARKER,
  ZERO32,
  ZERO_ADDRESS,
  boundValue,
  decimalText,
  fieldLabel,
  groupedInt,
  holds,
  memberByValue,
  memberLabel,
  offeredMembers,
  plainAddOn,
  plainField,
  plainMember,
  plainParam,
  plainRule,
  plannedAssetsText,
  qEntry,
  qUnit,
  ruleFor,
  utcText,
} from './spec-model.mjs';

const show = (v) => JSON.stringify(typeof v === 'bigint' ? v.toString() : v);
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Common characters people paste and their plain-ASCII replacements. */
const REPLACEMENTS = new Map([
  ['’', "'"],
  ['‘', "'"],
  ['“', 'nothing (drop the quotes)'],
  ['”', 'nothing (drop the quotes)'],
  ['"', "nothing, or ' instead"],
  ['\\', '/'],
  ['—', '-'],
  ['–', '-'],
  ['…', '...'],
  [' ', 'a normal space'],
  ['\n', 'a space'],
  ['\t', 'a space'],
  ['ß', '"ss"'],
  ['æ', '"ae"'],
  ['Æ', '"AE"'],
  ['œ', '"oe"'],
  ['ø', '"o"'],
  ['Ø', '"O"'],
  ['ł', '"l"'],
]);

function describeChar(ch) {
  const code = ch.codePointAt(0) ?? 0;
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  if (code < 0x20 || code === 0x7f) return `an invisible control character (${hex}${ch === '\n' ? ', a line break' : ch === '\t' ? ', a tab' : ''})`;
  return `"${ch}" (${hex})`;
}

/** Every distinct character of `text` whose UTF-8 bytes fall outside the rule's allowed byte ranges, in order. */
function badChars(text, ranges) {
  const ok = (b) => ranges.some(([lo, hi]) => b >= lo && b <= hi);
  const bad = [];
  for (const ch of text) {
    if (![...Buffer.from(ch, 'utf8')].every(ok) && !bad.includes(ch)) bad.push(ch);
  }
  return bad;
}

/** Plain ASCII stand-ins for a suggested text (the creator confirms it; emoji and accents have none). */
const SUGGEST = new Map([
  ['’', "'"],
  ['‘', "'"],
  ['“', ''],
  ['”', ''],
  ['—', '-'],
  ['–', '-'],
  ['…', '...'],
  ['\u00a0', ' '],
  ['"', "'"],
  ['\\', '/'],
  ['\n', ' '],
  ['\t', ' '],
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['Æ', 'AE'],
  ['œ', 'oe'],
  ['ø', 'o'],
  ['Ø', 'O'],
  ['ł', 'l'],
]);

/**
 * An accented or look-alike letter's plain letters ("é" -> "e", fullwidth "Ｆ" -> "F", "ﬁ" -> "fi"), or undefined when
 * it has none. NFKC first folds compatibility forms, NFD then splits off the accents.
 */
function asciiFold(ch) {
  const folded = ch.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /^[\x20-\x7e]+$/.test(folded) && folded !== ch ? folded : undefined;
}

/** What to write instead of a character, in words, and as the text a suggestion uses ('' drops it). */
function replacementOf(ch) {
  const folded = asciiFold(ch);
  if (REPLACEMENTS.has(ch)) return { words: REPLACEMENTS.get(ch), text: SUGGEST.get(ch) ?? '' };
  if (folded !== undefined) return { words: `"${folded}"`, text: folded };
  return { words: 'nothing (drop it)', text: '' };
}

/** "16 characters" or, when they differ, "14 characters, 16 bytes" (the limit counts bytes). */
export function sizeText(chars, bytes) {
  const count = `${groupedInt(chars)} character${chars === 1 ? '' : 's'}`;
  return chars === bytes ? count : `${count}, ${groupedInt(bytes)} bytes`;
}

const ruleAdvice = {
  JSON_TEXT: 'Use printable ASCII only: letters, digits, spaces and punctuation, without " or \\ (no emoji, accents, curly quotes or long dashes).',
  SVG: 'Use plain SVG text on one line: no line breaks, tabs or non-ASCII characters.',
  URL: 'Use an https:// link without spaces or quotes.',
};

/** Said when a text has nothing allowed left once its bad characters are dropped. */
export const PLAIN_LEFT = 'Once those are dropped nothing is left: it needs at least one plain character (a letter or digit).';

const listText = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * A text checked against its string rule and length, every problem at once (the validator stops at the first): its
 * size, every character that is not allowed with a replacement where one is known, and a suggested text when every
 * bad character has an automatic stand-in. Used by refusals and by `--field`.
 */
export function textReport(model, label, value, check) {
  const rule = model.stringRules.get(check.rule);
  const text = String(value ?? '');
  const max = Number(boundValue(model, check.maxBytes));
  const min = Number(boundValue(model, check.minBytes ?? 0));
  const bytes = Buffer.byteLength(text, 'utf8');
  const chars = [...text].length;
  const bad = badChars(text, rule?.allowed ?? []).map((ch) => ({ char: ch, shown: describeChar(ch), replacement: replacementOf(ch).words }));
  const prefixMissing = Boolean(rule?.prefix && text !== '' && !text.startsWith(rule.prefix));
  // Every character that is not allowed has a plain-ASCII stand-in (or is dropped): the creator confirms the result.
  // A suggestion shorter than the field's minimum (an emoji-only name drops to "") would be refused itself: none then.
  const replaced = bad.length > 0 ? bad.reduce((t, b) => t.split(b.char).join(replacementOf(b.char).text), text).replace(/ {2,}/g, ' ').trim() : undefined;
  const tooShort = replaced !== undefined && Buffer.byteLength(replaced) < min;
  const suggestion = tooShort ? undefined : replaced;
  const problems = [];
  if (bytes < min) problems.push(bytes === 0 ? `${label} is required.` : `${label} is too short (${sizeText(chars, bytes)}; at least ${min}).`);
  if (bytes > max) problems.push(chars === bytes ? `${label} is too long: ${groupedInt(bytes)} characters; at most ${groupedInt(max)}.` : `${label} is too long: ${sizeText(chars, bytes)}; at most ${groupedInt(max)} bytes, and characters outside plain ASCII take 2 to 4 bytes each.`);
  if (prefixMissing) problems.push(`${label} must start with ${rule.prefix}.`);
  if (bad.length === 1) problems.push(`${label} contains ${bad[0].shown}, which is not allowed.`);
  if (bad.length > 1) problems.push(`${label} contains ${bad.length} characters that are not allowed: ${listText(bad.map((b) => b.shown))}.`);
  const replace = bad.filter((b) => b.replacement);
  const replaceText = replace.length === 1 && bad.length === 1 ? ` Replace it with ${replace[0].replacement}.` : replace.length > 0 ? ` Replace ${listText(replace.map((b) => `${b.shown} with ${b.replacement}`))}.` : '';
  const fix = bad.length > 0 ? `${ruleAdvice[check.rule] ?? 'Use plain text.'}${replaceText}` : prefixMissing ? `Write it as ${rule.prefix}...` : bytes > max ? `Shorten it to ${groupedInt(max)} characters.` : bytes < min ? (bytes === 0 ? `Write a ${label.toLowerCase()} of 1 to ${groupedInt(max)} characters.` : 'Make it longer.') : '';
  const plainLeft = tooShort ? ` ${PLAIN_LEFT}` : '';
  return { ok: problems.length === 0, label, text, bytes, chars, min, max, rule: check.rule, bad, problems, fix: `${fix}${plainLeft}`, suggestion };
}

function explainString(model, label, value, check, reason) {
  const report = textReport(model, label, value, check);
  const max = report.max;
  if (reason === 'LENGTH_OUT_OF_RANGE') {
    if (report.bytes === 0) return { sentence: `${label} is required.`, fix: `Write a ${label.toLowerCase()} of 1 to ${groupedInt(max)} characters.` };
    if (report.bytes < report.min) return { sentence: `${label} is too short (${sizeText(report.chars, report.bytes)}; at least ${report.min}).`, fix: 'Make it longer.' };
    const sentence = report.problems.find((x) => x.includes('too long')) ?? `${label} is too long.`;
    const ascii = report.suggestion !== undefined && Buffer.byteLength(report.suggestion) <= max ? ` In plain ASCII it fits: ${JSON.stringify(report.suggestion)}.` : '';
    return { sentence, fix: `Shorten it to ${groupedInt(max)} characters.${ascii}` };
  }
  const rule = model.stringRules.get(check.rule);
  if (rule?.prefix && value !== '' && !String(value).startsWith(rule.prefix)) {
    return { sentence: `${label} must start with ${rule.prefix}.`, fix: `Write it as ${rule.prefix}...` };
  }
  const sentence = report.problems.find((x) => x.includes('not allowed')) ?? `${label} contains a character that is not allowed.`;
  const suggested = report.suggestion !== undefined && report.bad.length > 1 ? ` For example: ${JSON.stringify(report.suggestion)}.` : '';
  return { sentence, fix: `${report.fix || (ruleAdvice[check.rule] ?? 'Use plain text.')}${suggested}` };
}

function zeroOf(type) {
  if (type === 'address') return `"${ZERO_ADDRESS}"`;
  if (type === 'bytes32') return `"${ZERO32}"`;
  if (type === 'string') return '""';
  if (type === 'bytes') return '"0x"';
  return '0';
}

function setFix(model, f) {
  const p = plainField(model, f.name);
  if (f.type === 'address') return `Write a public 0x address (never a key), or "${MARKER}" for the wallet connected at launch.`;
  if (String(p?.default ?? '').includes(MARKER)) return `Write "${f.name}": "${MARKER}"; the launch flow computes it.`;
  return `Set "${f.name}".`;
}

/** The members to suggest in a fix: offered and usable by any box (members with `limits` are left out). */
function choicesText(model, enumName, offered, vars) {
  return offeredMembers(model, enumName, offered)
    .filter((m) => !plainMember(model, enumName, m.name)?.limits)
    .map((m) => `"${m.name}" (${memberLabel(model, enumName, m.name, vars)})`)
    .join(', ');
}

/** F74 U1: a member offered early on some networks (holder payouts in Demo) says how to check it there. */
const earlyHint = (member) => (member?.offeredOn ? ` To preview it, check with --network ${member.offeredOn.join(' or ')}.` : '');

const NETWORK_LABELS = Object.freeze({ demo: 'Demo', sepolia: 'Sepolia', mainnet: 'mainnet' });

function explainEnum(model, f, value, reason, vars, network) {
  const label = fieldLabel(model, f.name);
  const choices = choicesText(model, f.enum, f.check.offered, vars);
  const member = memberByValue(model, f.enum, value);
  if (reason === 'NOT_OFFERED' && member && (member.notBuiltOn ?? []).includes(network)) {
    // Offered by validate() but not built by core v1 on this network (SH-F74-polish item 5): its own list and why.
    const where = NETWORK_LABELS[network] ?? network;
    const values = model.lib.OFFERED_ON?.[network]?.[f.name] ?? [];
    const names = model.enums.get(f.enum).members.filter((m) => values.includes(m.value)).map((m) => m.name);
    return {
      sentence: `${memberLabel(model, f.enum, member.name, vars)} ("${member.name}") is not built on ${where} yet: ${member.notBuilt}.`,
      fix: `Pick one of ${where}'s choices: ${choicesText(model, f.enum, names, vars)}. The Demo and mainnet's check offer it (--network demo).`,
    };
  }
  if (reason === 'NOT_OFFERED' && member) {
    const why = plainMember(model, f.enum, member.name)?.notOffered;
    return { sentence: `${memberLabel(model, f.enum, member.name, vars)} ("${member.name}") is not offered${why ? ` yet: ${why}` : ' in this version'}.`, fix: `Pick one of: ${choices}.${earlyHint(member)}` };
  }
  return { sentence: `${show(value)} is not one of the ${label} choices.`, fix: `Pick one of: ${choices}.` };
}

function explainUint(model, f, value, reason, wire) {
  const label = fieldLabel(model, f.name);
  const p = plainField(model, f.name);
  if (f.check.allowed) {
    const choices = p?.choices ?? f.check.allowed.join(', ');
    return { sentence: `${label} must be one of ${choices}; it is ${show(value)}.`, fix: `Pick one of ${choices}.` };
  }
  const min = boundValue(model, f.check.min, wire);
  const unit = p?.unit ? ` ${p.unit}` : '';
  if (f.check.orZero && f.check.max === undefined) {
    // A clock time (field 15 openAt, F80): the bound and the value as UTC times, so a block count or a delay typed into
    // it reads as the 1970 time it would be, and is named as such.
    if (p?.clockTime) return { sentence: `${label} must be 0 (Now) or a UTC time from ${utcText(min)} on; it is ${groupedInt(value)} (${utcText(value)}: a block count or a delay, not a time).`, fix: `Set "${f.name}" to 0 for Now, or a UTC time like "2026-10-06T18:00:00Z" (at most 14 days after Create).` };
    return { sentence: `${label} must be 0 or at least ${groupedInt(min)}${unit}; it is ${groupedInt(value)}.`, fix: `Set "${f.name}" to 0 or at least ${groupedInt(min)}.` };
  }
  const max = boundValue(model, f.check.max, wire);
  const range = min === max ? `exactly ${groupedInt(min)}` : `between ${groupedInt(min)} and ${groupedInt(max)}${unit}`;
  return { sentence: `${label} must be ${range}; it is ${groupedInt(value)}.`, fix: `Set "${f.name}" ${min === max ? `to ${min}` : `within ${groupedInt(min)}-${groupedInt(max)}`}.` };
}

function explainFieldCheck(model, f, reason, wire, context, vars, network) {
  const label = fieldLabel(model, f.name);
  const value = wire[f.name];
  const check = f.check ?? {};
  if (reason === 'MUST_BE_ZERO' && check.zeroWhen) {
    const kind = memberLabel(model, 'BoxType', memberByValue(model, 'BoxType', wire.boxType)?.name ?? '', vars);
    return { sentence: `${label} must be empty for this kind of box (${kind}).`, fix: `Write "${f.name}": ${zeroOf(f.type)}.` };
  }
  if (reason === 'UNSUPPORTED_VERSION') return { sentence: `Version ${show(value)} does not exist; every new box is version 2.`, fix: 'Set "version": 2.' };
  if (f.enum && (reason === 'NOT_A_MEMBER' || reason === 'NOT_OFFERED')) return explainEnum(model, f, value, reason, vars, network);
  if (check.kind === 'uint' && (reason === 'NOT_A_MEMBER' || reason === 'OUT_OF_RANGE')) return explainUint(model, f, value, reason, wire);
  if (check.kind === 'string') return explainString(model, label, value, check, reason);
  if (reason === 'LENGTH_OUT_OF_RANGE' && f.type === 'bytes') {
    const bytes = (String(value).length - 2) / 2;
    if (bytes === 0) return { sentence: `${label} is empty.`, fix: `Write "${MARKER}" or the traits as { "formatV1": { "traitTypes": [...] } }.` };
    return { sentence: `${label} is ${groupedInt(bytes)} bytes; at most ${groupedInt(boundValue(model, check.maxBytes))}.`, fix: 'Use fewer or shorter trait names and values.' };
  }
  if (reason === 'METADATA_TABLE_MALFORMED') {
    return {
      sentence: `${label} does not read as a trait table: version 1, the description, at most ${groupedInt(boundValue(model, { const: 'MAX_TRAIT_TYPES' }))} trait types, names and values of 1 to 255 plain ASCII characters without quotes or backslashes, nothing after the last value.`,
      fix: `Write "${MARKER}" or the traits as { "formatV1": { "traitTypes": [...] } }.`,
    };
  }
  if (reason === 'ZERO_VALUE') return { sentence: `${label} must be set.`, fix: setFix(model, f) };
  if (reason === 'Q_NOT_LISTED') {
    const listed = context.json.qList.map((q) => `"${qUnit(q)}" (${q.label})`).join(', ');
    return { sentence: `${show(value)} is not on this version's list of pricing assets.`, fix: `Use ${listed}. ${plannedAssetsText(model)}` };
  }
  if (reason === 'RAISE_NOT_A_PRESET') return explainRaise(model, wire, context);
  if (reason === 'TOO_MANY_ADD_ONS') return { sentence: `${wire.addOns.length} add-ons; a box takes at most ${boundValue(model, check.maxCount)}.`, fix: 'Drop some special series.' };
  if (reason === 'ADD_ON_ORDER') return explainOrder(model, wire);
  if (reason === 'ADD_ON_UNKNOWN') {
    return { sentence: 'An add-on id is not in the catalog.', fix: `Write add-ons by key: ${model.catalog.addOns.map((a) => `"${a.key}"`).join(', ')}.` };
  }
  return { sentence: `${label}: ${model.plain.reasons[reason] ?? reason}`, fix: `Check "${f.name}" in references/fields.md.` };
}

function explainRaise(model, wire, context) {
  const entry = qEntry(context.json, wire.q);
  const unit = qUnit(entry);
  const presets = (entry?.raisePresets ?? []).map((x) => decimalText(x, entry.decimals));
  const now = entry ? ` It is ${decimalText(wire.raise, entry.decimals)} ${unit} now.` : '';
  if (presets.length === 1) {
    // F74 U5: one raise for every box; the version sets it.
    return { sentence: `Every box raises the same: ${presets[0]} ${unit} (the version sets it, the creator does not choose it).${now}`, fix: `Write "raise": { "decimal": "${presets[0]}" }.` };
  }
  const list = presets.length > 1 ? `${presets.slice(0, -1).join(', ')} or ${presets.at(-1)}` : presets.join('');
  return { sentence: `The raise must be one of the presets for ${unit}: ${list} ${unit}.${now}`, fix: `Write "raise": { "decimal": "${presets[0] ?? '1'}" } (or another preset).` };
}

function explainOrder(model, wire) {
  const keys = wire.addOns.map((a) => model.addOnById.get(a.id)?.key ?? `id ${a.id}`);
  const sorted = [...wire.addOns].sort((a, b) => a.id - b.id).map((a) => model.addOnById.get(a.id)?.key ?? `id ${a.id}`);
  const repeats = model.catalog.addOns.filter((a) => a.repeatable).map((a) => `"${a.key}"`);
  return {
    sentence: `Add-ons must be listed by catalog id, each once${repeats.length ? ` (only ${repeats.join(', ')} may repeat)` : ''}; they are ${keys.join(', ')}.`,
    fix: `List them as: ${[...new Set(sorted)].join(', ')} (and remove any repeat).`,
  };
}

// ------------------------------------------------------------------------------------------------ add-ons

function explainAddOnItself(model, a, reason, wire, context, entry, vars) {
  const label = plainAddOn(model, a.key)?.label ?? a.key;
  const conflict = plainAddOn(model, a.key)?.conflict;
  if (reason === 'ADD_ON_NOT_AVAILABLE') {
    return { sentence: `${label} is not available in version ${wire.version} (only in version ${a.versions.join(' and ')}).`, fix: `Remove the "${a.key}" add-on.` };
  }
  if (reason === 'ADD_ON_PARAMS_MALFORMED') {
    return { sentence: `${label}: its settings are not encoded the way the catalog expects.`, fix: `Write it by key, { "addOn": "${a.key}", "params": { ... } }, and let the checker encode it.` };
  }
  if (reason === 'ADD_ON_CONFLICT') {
    const boxType = memberByValue(model, 'BoxType', wire.boxType)?.name;
    if (a.boxTypes && !a.boxTypes.includes(boxType)) {
      return { sentence: `${label} does not fit this kind of box (${memberLabel(model, 'BoxType', boxType ?? '', vars)}).`, fix: `Remove the "${a.key}" add-on.` };
    }
    const values = entry ? addOnValues(model, entry) : null;
    const index = (a.requires ?? []).findIndex((r) => !holds(model, r.predicate, wire, context.json, { addOn: a, values: values ?? {} }));
    // Plain words give one conflict for every requirement, or one per requirement in the catalog's order.
    const words = Array.isArray(conflict) ? conflict[index] : conflict;
    return { sentence: words?.sentence ?? a.requires?.[index]?.why ?? `${label} does not fit the rest of the box.`, fix: words?.fix ?? `Change the box, or remove the "${a.key}" add-on.` };
  }
  return { sentence: `${label}: ${model.plain.reasons[reason] ?? reason}`, fix: `Check the "${a.key}" add-on in references/fields.md.` };
}

function explainParam(model, a, p, reason, wire, values, vars, context) {
  const paramLabel = plainParam(model, a.key, p.name)?.label ?? p.name;
  const label = `${plainAddOn(model, a.key)?.label ?? a.key}: ${paramLabel.charAt(0).toLowerCase()}${paramLabel.slice(1)}`;
  const value = values?.[p.name];
  if (p.type === 'string') return explainString(model, label, value, p, reason);
  if (reason === 'NOT_A_MEMBER' && p.allowed && plainParam(model, a.key, p.name)?.amountInQ) {
    // An amount menu (F74 U2): in the pricing asset's units, never raw.
    const entry = qEntry(context.json, wire.q);
    const decimals = entry?.decimals ?? 18;
    const amounts = p.allowed.map((x) => decimalText(x, decimals));
    const list = `${amounts.slice(0, -1).join(', ')} or ${amounts.at(-1)} ${vars.Q}`;
    const now = value === undefined ? '' : `; it is ${decimalText(value, decimals)} ${vars.Q}`;
    return { sentence: `${label} must be one of ${list}${now}.`, fix: `Write it like { "decimal": "${amounts[1] ?? amounts[0]}" }, one of ${list}.` };
  }
  if (reason === 'NOT_A_MEMBER' && p.allowed) return { sentence: `${label} must be one of ${p.allowed.join(', ')}; it is ${show(value)}.`, fix: `Pick one of ${p.allowed.join(', ')}. ${plainParam(model, a.key, p.name)?.what ?? ''}`.trim() };
  if ((reason === 'NOT_A_MEMBER' || reason === 'NOT_OFFERED') && p.enum) {
    const member = memberByValue(model, p.enum, value);
    const why = member ? plainMember(model, p.enum, member.name)?.notOffered : undefined;
    const sentence = reason === 'NOT_OFFERED' && member ? `${label}: "${member.name}" is not offered${why ? ` yet: ${why}` : ''}.` : `${label}: ${show(value)} is not one of the choices.`;
    return { sentence, fix: `Pick one of: ${choicesText(model, p.enum, p.offered, vars)}.${reason === 'NOT_OFFERED' && member ? earlyHint(member) : ''}` };
  }
  if (reason === 'OUT_OF_RANGE') {
    const min = boundValue(model, p.min, wire);
    const max = boundValue(model, p.max, wire);
    const of = p.max?.field ? ` (${fieldLabel(model, p.max.field).toLowerCase()} of the box)` : '';
    return { sentence: `${label} must be between ${groupedInt(min)} and ${groupedInt(max)}${of}; it is ${groupedInt(value ?? 0)}.`, fix: `Use ${groupedInt(min)} to ${groupedInt(max)}.` };
  }
  if ((reason === 'ZERO_VALUE' || reason === 'MUST_BE_ZERO') && p.nonZeroIff) {
    const when = `"${p.nonZeroIff.param}" is "${p.nonZeroIff.eq}"`;
    if (reason === 'ZERO_VALUE') return { sentence: `${label} must be set when ${when}.`, fix: `Write a public 0x address, or "${MARKER}" for the wallet connected at launch.` };
    return { sentence: `${label} must be zero unless ${when}.`, fix: `Write "${p.name}": "${ZERO_ADDRESS}".` };
  }
  // A list of picture fingerprints (the collection page's teasers): at most `maxItems`, none of them zero.
  if (p.type === 'bytes32[]' && reason === 'LENGTH_OUT_OF_RANGE') {
    return { sentence: `${label}: at most ${p.maxItems}; it lists ${Array.isArray(value) ? value.length : 'more'}.`, fix: `Keep at most ${p.maxItems}.` };
  }
  if (p.type === 'bytes32[]' && reason === 'ZERO_VALUE') {
    return { sentence: `${label}: every entry must be a picture, not zero.`, fix: `Write "${MARKER}" for each picture uploaded in the launch flow, and drop the zero entries ([] for none).` };
  }
  return { sentence: `${label}: ${model.plain.reasons[reason] ?? reason}`, fix: `Check the "${a.key}" add-on in references/fields.md.` };
}

function explainAddOn(model, verdict, reason, wire, context, vars) {
  const a = model.addOnById.get(Math.floor(verdict.field / 100));
  if (!a) return { sentence: model.plain.reasons[reason] ?? reason, fix: 'Check the add-ons.' };
  const index = (verdict.field % 100) - 1;
  const entries = wire.addOns.filter((e) => e.id === a.id);
  if (index < 0) return explainAddOnItself(model, a, reason, wire, context, entries[0], vars);
  const p = a.params[index];
  // A repeatable add-on: the entry whose setting is out of its bounds (else the first).
  const values = entries.map((e) => addOnValues(model, e)).find((v) => v && reason === 'OUT_OF_RANGE' && (BigInt(v[p.name]) < boundValue(model, p.min, wire) || BigInt(v[p.name]) > boundValue(model, p.max, wire))) ?? (entries[0] ? addOnValues(model, entries[0]) : null);
  return explainParam(model, a, p, reason, wire, values, vars, context);
}

/**
 * The verdict as { reason, field, sentence, fix, rule? }: the plain sentence names the failing check and the fix says
 * what to write instead.
 */
export function explainVerdict(model, verdict, wire, context, network = 'mainnet') {
  const reason = model.reasonByCode.get(verdict.reason)?.name ?? `reason ${verdict.reason}`;
  const field = model.lib.FIELD_NAMES[verdict.field] ?? `field ${verdict.field}`;
  const entry = qEntry(context.json, wire.q);
  const vars = { T: wire.tokenSymbol || 'the token', Q: qUnit(entry) };
  const base = { reason, reasonCode: verdict.reason, field, fieldId: verdict.field };
  if (verdict.field >= 100) return { ...base, ...explainAddOn(model, verdict, reason, wire, context, vars) };
  const rule = ruleFor(model, verdict, wire, context.json);
  if (rule) {
    const p = plainRule(model, rule.name);
    return { ...base, rule: rule.name, sentence: p?.sentence ?? `${capitalise(rule.name)}.`, fix: p?.fix ?? `Change "${rule.field}".` };
  }
  const f = model.fieldById.get(verdict.field);
  return { ...base, ...explainFieldCheck(model, f, reason, wire, context, vars, network) };
}
