/**
 * SH-EXISTING-NFTS-E08C: what the existing-NFTs Create flow builds: one SetSpecV2 (E-01's fixed domains) and its
 * ordered commitment (collection, count, set hash: design § 1), and the checks of each step.
 *
 * The spec is the factory's (`SetFactoryV2.createBox`): the price coin's listing and its current raise, the names,
 * opening "once loaded" (openAt 0), the deadline, the creator's optional first buy, the collection, the count and set
 * hash of the ids in the order pasted, the pick fee preset, About, and the logo's SHA-256. E-01's validator
 * (`validateSetSpecV2`) runs last on the very spec Create would send; a refusal the steps did not name is a bug line.
 */
import { getAddress, isAddress, zeroAddress, zeroHash, type Address } from 'viem';
import {
  SET_FORMAT, SET_RELEASE, SET_SCHEMA, buildSetCommitment, validateSetSpecV2, type SetCommitment, type SetSpecV2,
} from '@squarehole/box-spec';
import { MESSAGES } from '../reason-copy';
import { parseEthText } from '../create-model';
import { offeredListings, type SiteListing } from '../v2/listings';
import { SET_DEADLINE_DAYS, SET_PICK_FEES, type SetDraft } from './set-draft';
import { idsProblemText, parseSetIds } from './set-ids';
import type { SetStepId } from './set-steps';

export const SET_CONTROL = /* @__PURE__ */ Object.freeze({
  pricing: 'create-set-pricing', name: 'create-set-name', ticker: 'create-set-ticker', logo: 'create-set-logo', about: 'create-set-about',
  collection: 'create-set-collection', ids: 'create-set-ids', pickFee: 'create-set-pick-fee', deadline: 'create-set-deadline', firstIn: 'create-set-first-in',
});

export interface SetIssue {
  readonly step: SetStepId;
  readonly control: string;
  readonly message: string;
}

/** The chosen price coin among the offered ones (the first one until another is chosen); null when none is offered. */
export function listingOf(draft: Pick<SetDraft, 'pricing'>, listings: readonly SiteListing[]): SiteListing | null {
  const offered = offeredListings(listings);
  return offered.find((l) => l.token.toLowerCase() === draft.pricing.toLowerCase()) ?? offered[0] ?? null;
}

/** The typed collection as a checksummed address, or null (not a full address, or the zero address). */
export function collectionOf(text: string): Address | null {
  const trimmed = text.trim();
  if (!isAddress(trimmed, { strict: false })) return null;
  const address = getAddress(trimmed);
  return address === zeroAddress ? null : address;
}

export interface SetItems {
  readonly collection: Address;
  readonly ids: readonly bigint[];
  readonly commitment: SetCommitment;
}

let lastItems: { readonly key: string; readonly items: SetItems | null } | null = null;

/** The collection and ids with their commitment (built once per text); null until both are valid. */
export function itemsOf(draft: Pick<SetDraft, 'collection' | 'ids'>): SetItems | null {
  const key = `${draft.collection}\u0000${draft.ids}`;
  if (lastItems?.key === key) return lastItems.items;
  const collection = collectionOf(draft.collection);
  const parsed = parseSetIds(draft.ids);
  let items: SetItems | null = null;
  if (collection !== null && parsed.ok) {
    try {
      items = { collection, ids: parsed.ids, commitment: buildSetCommitment(collection, parsed.ids).commitment };
    } catch {
      items = null;
    }
  }
  lastItems = { key, items };
  return items;
}

/** The first buy in the price coin's raw units; null when it is not a plain amount within the coin's decimals. */
export const firstInOf = (draft: Pick<SetDraft, 'firstIn'>, listing: Pick<SiteListing, 'decimals'>): bigint | null => parseEthText(draft.firstIn, listing.decimals);

/**
 * The spec Create would send. Unfinished parts build as neutral values (a zero hash, a zero address, count 0), which
 * the checks below refuse, so a spec with them is never sent.
 */
export function buildSetSpec(draft: SetDraft, listing: SiteListing, items: SetItems | null): SetSpecV2 {
  return {
    format: SET_FORMAT, schema: SET_SCHEMA, release: SET_RELEASE, tokenName: draft.name.trim(), tokenSymbol: draft.ticker.trim(),
    pricing: { listingId: listing.id, token: listing.token }, raise: listing.raise, openAt: 0, deadlineDays: draft.deadlineDays,
    creatorBuy: firstInOf(draft, listing) ?? 0n, collection: items?.collection ?? zeroAddress, count: items?.commitment.count ?? 0,
    setHash: items?.commitment.setHash ?? zeroHash, pickFeeBps: draft.pickFeeBps, description: draft.about.trim(), logoSha256: draft.logo?.sha256 ?? zeroHash,
  };
}

/** E-01's text rule: 32..126 bytes except `"` and `\`, within the byte bounds. */
function textProblem(value: string, min: number, max: number): string | null {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length < min) return MESSAGES.required;
  if (bytes.length > max) return MESSAGES.upTo(BigInt(max));
  return bytes.some((c) => c < 32 || c > 126 || c === 34 || c === 92) ? MESSAGES.badCharacter : null;
}

/** Every check, by step, in step order. */
export function setIssues(draft: SetDraft, listings: readonly SiteListing[]): SetIssue[] {
  const issues: SetIssue[] = [];
  const add = (step: SetStepId, control: string, message: string | null) => { if (message) issues.push({ step, control, message }); };
  const listing = listingOf(draft, listings);
  add('set-basics', SET_CONTROL.pricing, listing === null || (draft.pricing !== '' && listing.token.toLowerCase() !== draft.pricing.toLowerCase()) ? 'Choose a current price coin.' : null);
  add('set-basics', SET_CONTROL.name, textProblem(draft.name.trim(), 1, 32));
  add('set-basics', SET_CONTROL.ticker, textProblem(draft.ticker.trim(), 1, 11));
  add('set-basics', SET_CONTROL.logo, draft.logo === null ? MESSAGES.addLogo : null);
  add('set-basics', SET_CONTROL.about, textProblem(draft.about.trim(), 0, 1024));
  add('set-items', SET_CONTROL.collection, collectionOf(draft.collection) === null ? MESSAGES.notAddress : null);
  const parsed = parseSetIds(draft.ids);
  add('set-items', SET_CONTROL.ids, parsed.ok ? null : idsProblemText(parsed.problem));
  add('set-items', SET_CONTROL.pickFee, SET_PICK_FEES.includes(draft.pickFeeBps) ? null : MESSAGES.pickOption);
  add('set-raise', SET_CONTROL.deadline, SET_DEADLINE_DAYS.includes(draft.deadlineDays) ? null : MESSAGES.pickOption);
  if (listing) {
    const first = firstInOf(draft, listing);
    add('set-raise', SET_CONTROL.firstIn, first === null ? MESSAGES.number : first >= listing.raise ? 'Less than the raise' : null);
  }
  if (issues.length === 0 && listing) {
    const spec = buildSetSpec(draft, listing, itemsOf(draft));
    const verdict = validateSetSpecV2(spec, { listing: { id: listing.id, token: listing.token, decimals: listing.decimals, class: listing.class, kind: listing.kind, raise: listing.raise }, timestamp: 0n });
    if (verdict.reason !== 0) issues.push({ step: 'set-overview', control: SET_CONTROL.pricing, message: MESSAGES.bug });
  }
  return issues;
}
