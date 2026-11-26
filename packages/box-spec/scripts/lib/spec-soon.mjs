/**
 * "Coming soon" prose must not outlive the spec (F73 launch skill). Plain-words entries for what is not available yet
 * carry `soonWords`, the words the skill's prose uses for them: enum members (available once the spec has and offers
 * them), add-ons (once the catalog has them for the newest version), planned pricing assets (once listed), rules
 * (once the spec drops them: "per side" was blocked by a rule) and `launchFlowCanEnter.comingSoon` (launch-flow
 * features outside the spec, never available here: apps/web launch-skill-words.test.ts fails once the page has one,
 * so the entry and its prose go together). `soonFindings` reports prose that still calls an available value
 * coming soon ("stale") and "coming soon" prose that names nothing registered ("unregistered", which the first check
 * could not see). Used by skills/square-hole-launch/scripts/build-references.mjs --check (pnpm check:launch-skill).
 */
import { qUnit } from './spec-model.mjs';

/** Words that make a prose unit a claim about the future or about today's limits. */
const SOON = /coming soon|\bsoon\b|\blater\b|\bplanned\b|\bnot yet\b|\bnot offered\b|\bwaits?\b|\bproposal\b|\buntil\b|\btoday\b/i;
const COMING_SOON = /coming soon|\(soon\)/i;

function offeredEverywhere(model, enumName, member) {
  const lists = [
    ...model.fields.filter((f) => f.enum === enumName && f.check?.offered).map((f) => f.check.offered),
    ...model.catalog.addOns.flatMap((a) => a.params.filter((p) => p.enum === enumName && p.offered).map((p) => p.offered)),
  ];
  return lists.every((list) => list.includes(member));
}

/**
 * Every plain-words entry prose may call coming soon: { id, own, words, names, available }. `words` (soonWords) match
 * in any case at a word start ("banner" also finds "banners"); `names` (the member name or add-on key) match exactly;
 * `own` is the entry's plain-words path, whose own texts describe it and never count against it.
 */
export function soonEntries(model) {
  const latest = model.contexts.at(-1);
  const out = [];
  for (const [enumName, members] of Object.entries(model.plain.enums)) {
    for (const [name, p] of Object.entries(members)) {
      if (!p.soonWords && !p.planned && !p.notOffered) continue;
      const exists = model.enums.get(enumName)?.members.some((m) => m.name === name) ?? false;
      out.push({ id: `${enumName}.${name}`, own: `enums.${enumName}.${name}`, words: p.soonWords ?? [], names: [name], available: exists && offeredEverywhere(model, enumName, name) });
    }
  }
  for (const [key, p] of Object.entries(model.plain.addOns)) {
    if (p.soonWords || p.planned) out.push({ id: `add-on ${key}`, own: `addOns.${key}`, words: p.soonWords ?? [], names: [key], available: model.addOnByKey.get(key)?.versions.includes(latest.version) ?? false });
  }
  (model.plain.fields.q?.plannedAssets ?? []).forEach((a, i) => {
    const listed = latest.json.qList.some((q) => q.qClass === a.qClass && (!a.symbol || qUnit(q).toUpperCase() === a.symbol));
    if (a.soonWords) out.push({ id: `pricing asset ${a.label}`, own: `fields.q.plannedAssets[${i}]`, words: a.soonWords, names: [], available: listed });
  });
  for (const [name, p] of Object.entries(model.plain.rules)) {
    if (p.soonWords) out.push({ id: `rule "${name}"`, own: `rules.${name}`, words: p.soonWords, names: [], available: !model.rules.some((r) => r.name === name) });
  }
  for (const item of model.plain.launchFlowCanEnter?.comingSoon ?? []) out.push({ id: `launch flow: ${item.label}`, own: null, words: item.soonWords, names: [], available: false });
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, word) => new RegExp(`(?<![A-Za-z])${escape(word)}`, 'i').test(text);
const names = (text, name) => new RegExp(`(?<![A-Za-z0-9_-])${escape(name)}(?![A-Za-z0-9_-])`).test(text);
const named = (text, e) => e.words.some((w) => mentions(text, w)) || e.names.some((n) => names(text, n));

/**
 * A markdown text as prose units { line, text }: sentences of paragraphs, list items and table cells; headings and
 * code blocks are skipped. `line` is where the unit starts (1-based).
 */
export function proseUnits(text) {
  const units = [];
  let block = [];
  const flush = () => {
    if (block.length === 0) return;
    const joined = block.map((b) => b.text).join(' ');
    let at = 0;
    // Sentences end at . ! ? ; but not after "ref." or "e.g." (decision ids and examples follow them).
    for (const part of joined.split(/(?<=[.!?;])(?<!\bref\.|\be\.g\.|\bi\.e\.)\s+|\s·\s|\s\|\s?|^\|\s?/)) {
      const offset = joined.indexOf(part, at);
      at = offset + part.length;
      let line = block[0].line;
      for (let i = 0, pos = 0; i < block.length; pos += block[i].text.length + 1, i++) if (pos <= offset) line = block[i].line;
      if (part.trim() !== '') units.push({ line, text: part.trim() });
    }
    block = [];
  };
  let code = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      flush();
      code = !code;
      return;
    }
    if (code) return;
    const line = raw.replace(/<!--.*?-->/g, '');
    if (line.trim() === '' || /^\s*#/.test(line)) return flush();
    if (/^\s*(?:[-*] |\d+\. |\|)/.test(line)) flush();
    block.push({ line: i + 1, text: line.trim() });
  });
  flush();
  return units;
}

/** Every string in plain-words that prose is built from, as units (planned and not-offered texts excluded). */
export function plainWordUnits(model) {
  const skip = new Set(['planned', 'notOffered', 'status', 'source', 'soonWords', 'about', 'limits', 'comingSoon', 'retired']);
  const units = [];
  const visit = (value, path) => {
    if (typeof value === 'string') return units.push({ line: path, text: value });
    if (Array.isArray(value)) return value.forEach((v, i) => visit(v, `${path}[${i}]`));
    if (typeof value === 'object' && value !== null) for (const [k, v] of Object.entries(value)) if (!skip.has(k)) visit(v, path ? `${path}.${k}` : k);
  };
  visit(model.plain, '');
  return units;
}

/**
 * Findings for prose files ({ path, text } markdown, or { path, units } already split): "stale" when a unit names an
 * available value and a soon word; "unregistered" when a unit says "coming soon" and names no registered value.
 */
export function soonFindings(model, files) {
  const entries = soonEntries(model);
  const findings = [];
  for (const file of files) {
    for (const unit of file.units ?? proseUnits(file.text)) {
      const hits = entries.filter((e) => named(unit.text, e));
      const own = (e) => e.own && typeof unit.line === 'string' && (unit.line === e.own || unit.line.startsWith(`${e.own}.`));
      const at = `${file.path}:${unit.line}`;
      for (const e of hits.filter((x) => x.available && !own(x))) if (SOON.test(unit.text)) findings.push({ kind: 'stale', at, entry: e.id, text: unit.text });
      if (COMING_SOON.test(unit.text) && hits.length === 0) findings.push({ kind: 'unregistered', at, text: unit.text });
    }
  }
  return findings;
}
