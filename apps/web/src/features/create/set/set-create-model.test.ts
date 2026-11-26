/**
 * SH-EXISTING-NFTS-E08C: the spec the set Create flow builds and the checks of each step. The spec E-01's validator
 * accepts is the one Create would send; the list file round-trips to its commitment, and its acknowledgement is bound
 * to the set hash (a reordered list, other ids or another collection need a new file).
 */
import { keccak256, stringToHex, zeroAddress, zeroHash } from 'viem';
import { sha256Hex } from '@squarehole/artwork';
import { describe, expect, it } from 'vitest';
import { SET_LIST_SCHEMA, buildSetCommitment, parseSetListFile, validateSetSpecV2 } from '@squarehole/box-spec';
import { DEMO_LISTINGS } from '../v2/listings';
import { SET_CONTROL, buildSetSpec, collectionOf, itemsOf, listingOf, setIssues } from './set-create-model';
import { EMPTY_SET_DRAFT, parseSetDraft, type SetDraft } from './set-draft';
import { listAckFor, listSavedFor, setListFile } from './set-list-file';

const COLLECTION = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const logo = { sha256: keccak256(stringToHex('logo')).toLowerCase() as `0x${string}`, url: null, bytes: 4, data: btoa('logo') };
const listings = DEMO_LISTINGS;
const draft = (patch: Partial<SetDraft> = {}): SetDraft => ({ ...EMPTY_SET_DRAFT, name: 'Outside Set', ticker: 'OUT', logo, collection: COLLECTION, ids: '0-39', ...patch });

describe('the set spec and its checks', () => {
  it('builds the factory’s spec from the draft: the listing’s raise, opening once loaded, the set hash of the ids in pasted order', () => {
    const d = draft({ ids: '7 3 5 1 0 2 4 6 8 9', pickFeeBps: 2_500, deadlineDays: 90, firstIn: '0.5', about: 'Ten old friends' });
    const listing = listingOf(d, listings);
    if (!listing) throw new Error('no listing');
    const items = itemsOf(d);
    const spec = buildSetSpec(d, listing, items);
    const ids = [7n, 3n, 5n, 1n, 0n, 2n, 4n, 6n, 8n, 9n];
    expect(items?.ids).toEqual(ids);
    expect(spec).toMatchObject({ format: 2, tokenName: 'Outside Set', tokenSymbol: 'OUT', pricing: { listingId: 0, token: zeroAddress }, raise: listing.raise, openAt: 0,
      deadlineDays: 90, creatorBuy: 500_000_000_000_000_000n, count: 10, pickFeeBps: 2_500, description: 'Ten old friends', logoSha256: logo.sha256 });
    expect(spec.collection.toLowerCase()).toBe(COLLECTION);
    expect(spec.setHash).toBe(buildSetCommitment(collectionOf(COLLECTION) as `0x${string}`, ids).commitment.setHash);
    expect(validateSetSpecV2(spec, { listing: { id: listing.id, token: listing.token, decimals: listing.decimals, class: listing.class, kind: listing.kind, raise: listing.raise }, timestamp: 0n })).toEqual({ reason: 0, field: 0 });
    expect(setIssues(d, listings)).toEqual([]);
  });

  it('names each step’s problems on its controls', () => {
    const issues = setIssues({ ...EMPTY_SET_DRAFT, name: 'Bad "name"', ticker: 'TOO-LONG-TICKER', collection: '0x123', ids: '1-5', firstIn: 'x' }, listings);
    const at = (control: string) => issues.find((issue) => issue.control === control)?.message ?? null;
    expect(at(SET_CONTROL.name)).toBe('Plain letters, numbers and punctuation only. No " \\ or emoji.');
    expect(at(SET_CONTROL.ticker)).toBe('Up to 11 characters');
    expect(at(SET_CONTROL.logo)).toBe('Add a logo');
    expect(at(SET_CONTROL.collection)).toBe('Not a full 0x address');
    expect(at(SET_CONTROL.ids)).toBe('At least 10 ids · 5 now');
    expect(at(SET_CONTROL.firstIn)).toBe('Use a number like 0.05');
    expect(issues.map((issue) => issue.step)).toEqual(['set-basics', 'set-basics', 'set-basics', 'set-items', 'set-items', 'set-raise']);
    expect(setIssues(draft({ collection: '0x0000000000000000000000000000000000000000' }), listings).map((i) => i.control)).toEqual([SET_CONTROL.collection]);
    expect(setIssues(draft({ pricing: '0x00000000000000000000000000000000000000ff' }), listings).map((i) => i.control)).toEqual([SET_CONTROL.pricing]);
    const eth = listingOf(draft(), listings);
    expect(setIssues(draft({ firstIn: '1000000' }), listings).map((i) => [i.control, i.message])).toEqual([[SET_CONTROL.firstIn, 'Less than the raise']]);
    expect(eth?.symbol).toBe('ETH');
  });

  it('the list file round-trips to the commitment; its acknowledgement is bound to the set hash', () => {
    const items = itemsOf(draft({ ids: '0-39' }));
    if (!items) throw new Error('no items');
    const file = setListFile(items, 'OUT');
    expect(file.name).toBe(`out-list-${items.commitment.setHash.slice(2, 10)}.json`);
    const parsed = parseSetListFile(JSON.parse(file.text), items.commitment);
    expect(parsed.ids).toEqual(items.ids);
    expect(JSON.parse(file.text)).toMatchObject({ schema: SET_LIST_SCHEMA, count: 40, setHash: items.commitment.setHash, ids: items.ids.map(String) });
    expect(file.ack).toEqual(listAckFor(items.commitment));
    expect(listSavedFor(file.ack, items.commitment)).toBe(true);
    // Another order, other ids or another collection: a new set hash, so no file is saved for it yet.
    for (const other of [draft({ ids: '39-39 0-38' }), draft({ ids: '1-40' }), draft({ collection: '0x6b175474e89094c44da98b954eedeac495271d0f' })]) {
      const next = itemsOf(other);
      expect(listSavedFor(file.ack, next?.commitment ?? null)).toBe(false);
    }
    expect(listSavedFor(null, items.commitment)).toBe(false);
    expect(listSavedFor({ schema: SET_LIST_SCHEMA, setHash: zeroHash }, items.commitment)).toBe(false);
  });

  it('the stored draft is read back checked field by field; a logo whose bytes do not match its hash drops it', () => {
    const real = { sha256: sha256Hex(new TextEncoder().encode('logo')).toLowerCase(), url: null, bytes: 4, data: btoa('logo') };
    const stored = { ...draft(), logo: real, listSaved: { schema: SET_LIST_SCHEMA, setHash: zeroHash } };
    expect(parseSetDraft(JSON.stringify(stored))?.logo).toEqual(real);
    expect(parseSetDraft(JSON.stringify({ ...stored, logo: { ...real, sha256: zeroHash } }))).toBeNull();
    expect(parseSetDraft(JSON.stringify({ ...stored, pickFeeBps: 300 }))).toBeNull();
    expect(parseSetDraft(JSON.stringify({ ...stored, ids: 7 }))).toBeNull();
    expect(parseSetDraft('{')).toBeNull();
    expect(parseSetDraft(JSON.stringify({ ...stored, logo: null }))?.listSaved).toEqual({ schema: SET_LIST_SCHEMA, setHash: zeroHash });
  });
});
