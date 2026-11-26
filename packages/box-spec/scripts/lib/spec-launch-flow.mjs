/**
 * What the site's launch flow can enter (F73 launch skill). A draft the factory accepts may still hold choices the
 * launch flow (apps/web create-model.ts `buildSpec`) cannot produce, so the creator could not create it there. The
 * facts are plain-words `launchFlowCanEnter`, kept equal to the page by apps/web launch-skill-words.test.ts. The fee
 * sides need no fact: the launch flow builds each side's menu from the spec's own members (box creation flow § 2.2),
 * so any pair the check accepts can be entered. Part of check-spec.mjs.
 */
import { addOnValues } from './spec-input.mjs';
import { fieldLabel, plainNote } from './spec-model.mjs';

const facts = (model) => model.plain.launchFlowCanEnter ?? {};

const isZero = (v) => /^0x0*$/.test(String(v));

/** A collection page add-on with nothing in it: no banner, no teasers, no link. */
const emptyPage = (v) => Boolean(v) && isZero(v.bannerSha256) && (v.teaserSha256s ?? []).length === 0 && v.externalLink === '';

/**
 * Lines for "Check first": every choice in `wire` the launch flow cannot enter yet. A zero field written
 * "FROM_LAUNCH_FLOW" has already taken the launch flow's zero (spec-input.mjs), so it is never reported.
 */
export function launchFlowGaps(model, wire) {
  const gaps = [];
  for (const name of facts(model).zeroFields ?? []) {
    if (name in wire && !isZero(wire[name])) gaps.push(plainNote(model, 'launchFlowZero', { what: fieldLabel(model, name).toLowerCase(), field: name }));
  }
  const keyOf = (entry) => model.addOnById.get(entry.id)?.key;
  const valuesOf = (key) => wire.addOns.filter((e) => keyOf(e) === key).map((e) => addOnValues(model, e));
  if (facts(model).royaltiesOffLeftOut && valuesOf('royalties').some((v) => BigInt(v?.bps ?? 1) === 0n)) gaps.push(plainNote(model, 'launchFlowRoyaltiesOff'));
  if (facts(model).collectionPageEmptyLeftOut && valuesOf('collection-metadata').some(emptyPage)) gaps.push(plainNote(model, 'launchFlowCollectionPageEmpty'));
  for (const [key, max] of Object.entries(facts(model).maxRepeats ?? {})) {
    const count = wire.addOns.filter((e) => keyOf(e) === key).length;
    if (count > max) gaps.push(plainNote(model, 'launchFlowRepeats', { count, max, what: model.plain.addOns[key]?.label ?? key }));
  }
  return gaps;
}

/** The menu's line under the fee kinds: what the launch flow offers. */
export const launchFlowFeeLine = () => '  The launch flow offers each side on its own: any pair the check accepts.';
