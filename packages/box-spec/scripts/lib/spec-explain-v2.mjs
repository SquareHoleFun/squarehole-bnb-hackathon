/**
 * A format 2 verdict in plain words (M1-11; box-spec-v2-draft.md § 7, § 9 item 3): the twin's (reason, field) becomes
 * the sentence and fix of plain-words.v2.json `reasons`, filled with where the check stopped ("Buyers' fees, first
 * part") and what part it is ("what the fees turn into"). Recipe sub-field ids are the side's field id times 1,000
 * plus the part: a.leg 1, a.dest 2, a.legParams 3, a.destParams 4, b.* 11-14, split 21, splitParams 22.
 */
import { fillV2 } from './spec-model-v2.mjs';

const PARTS = { 1: ['a', 'leg'], 2: ['a', 'dest'], 3: ['a', 'legParams'], 4: ['a', 'destParams'], 11: ['b', 'leg'], 12: ['b', 'dest'], 13: ['b', 'legParams'], 14: ['b', 'destParams'], 21: [null, 'split'], 22: [null, 'splitParams'] };
const SIDES = { 17: 'buyers', 18: 'sellers' };

/** Where a verdict's field id points: its path, where it is in the creator's words, and the part. */
export function fieldOf(model, id) {
  const recipe = model.plain.recipe ?? {};
  const side = SIDES[Math.floor(id / 1000)];
  if (side && PARTS[id % 1000]) {
    const [branch, part] = PARTS[id % 1000];
    const sideText = recipe.sides?.[side] ?? (side === 'buyers' ? "Buyers' fees" : "Sellers' fees");
    return { path: [side, branch, part].filter(Boolean).join('.'), where: branch ? `${sideText}, ${recipe.branches?.[branch] ?? branch}` : sideText, part: recipe.parts?.[part] ?? part };
  }
  // Add-ons as format 1 numbers them: 100 x id for the add-on, plus i + 1 for its i-th parameter.
  const addOn = id >= 100 && id < 1700 ? model.addOnById.get(Math.floor(id / 100)) : undefined;
  if (addOn) {
    const param = addOn.params[(id % 100) - 1]?.name;
    return { path: `addOns.${addOn.key}${param ? `.${param}` : ''}`, where: addOn.key, part: param ?? addOn.key };
  }
  const f = model.fields[id];
  const words = model.plain.fields?.[f?.name];
  const label = typeof words?.label === 'string' ? words.label : (f?.name ?? `field ${id}`);
  return { path: f?.name ?? `field ${id}`, where: label, part: label, words };
}

const isText = (v) => typeof v === 'string' && v.length > 0;

/**
 * A reason's words in either shape plain words have held: `{ sentence, fix }` (format 2's, filled) or a plain string
 * (format 1's plain-words.v1.json), which is the sentence after the field's label, its fix then the field's own (`fix`,
 * else `tell`). Null when there are none.
 */
function reasonWords(model, name, at, vars) {
  const words = model.plain.reasons?.[name];
  const fieldFix = [at.words?.fix, at.words?.tell].find(isText);
  const fix = (text) => fillV2(isText(text) ? text : (fieldFix ?? `See what "${at.path}" takes in references/v2/fields.md.`), vars);
  if (isText(words)) return { sentence: `${at.where}: ${fillV2(words, vars)}`, fix: fix(undefined) };
  if (isText(words?.sentence)) return { sentence: fillV2(words.sentence, vars), fix: fix(words.fix) };
  return null;
}

/** The verdict (reason, field, reasonName) explained, with a fix. */
export function explainVerdictV2(model, verdict, wire) {
  const at = fieldOf(model, verdict.field);
  const listing = model.menu.listings.find((l) => l.id === wire.pricing?.listingId);
  const subject = wire.pricing;
  const named = model.menu.newest.get(subject?.token);
  const vars = { where: at.where, part: at.part, listing: subject?.listingId, token: named?.symbol ?? subject?.token, network: model.label, P: listing?.symbol ?? 'the pricing token', T: wire.tokenSymbol };
  const words = reasonWords(model, verdict.reasonName, at, vars);
  const contents = at.path === 'contentsParams';
  const pile = model.shapes.enums.get('BoxType').members[wire.boxType]?.name === 'PILE';
  return {
    reason: verdict.reasonName,
    reasonCode: verdict.reason,
    field: at.path,
    fieldId: verdict.field,
    sentence: words?.sentence ?? `${at.where}: refused (${verdict.reasonName}).`,
    fix: contents ? pile ? 'Check the pile asset and raw seed amount against references/v2/spec-json.md; use the canonical seed tuple, optionally with leaveBehindBps 0 or 500; pile fees require the same price coin.' : 'Check the shop settings, collection tiers and seed loader against references/v2/spec-json.md; the generated validator rejected these contents.' : words?.fix ?? 'See references/v2/fields.md for what this field takes.',
  };
}
