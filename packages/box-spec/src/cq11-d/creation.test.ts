import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { modelForV2, checkSpecV2, renderMenuV2, readMenu, type Twin } from '../../scripts/lib/check-spec-v2.mjs';
import * as twin from '../generated/box-spec.v2';

const zero = `0x${'00'.repeat(20)}`;
const hash = `0x${'11'.repeat(32)}`;
const blank = `0x${'00'.repeat(32)}`;
const side = { split: 'NoSplit', a: { leg: 'BuyT', dest: 'Eat' } };
const draft = () => ({ format: 'squarehole.boxspec-draft/2', spec: {
  format: 2, version: 2, boxType: 'TOKEN_ONLY', tokenName: 'Test', tokenSymbol: 'TEST',
  collectionName: '', collectionSymbol: '', description: '', n: 0, firstId: '0', pricing: 'ETH', raise: 'LISTING',
  layout: 'CURVE_V1', gradLayout: 'FULL_RANGE', launchFormat: 'CURVE', openAt: 0, deadlineDays: 30,
  buyers: structuredClone(side), sellers: structuredClone(side), artMode: 0, revealRoot: blank, metadataTable: '0x',
  generatorHash: blank, coverSha256: hash, revealListId: blank, marketplaceOwner: zero, creatorFeeRecipient: zero,
  creatorBuy: '0', collectionCoverSha256: blank, addOns: [], contentsParams: '0x', pickFeeBps: 0,
} });
const options = { network: 'demo', twin: twin as unknown as Twin };
const copy = () => JSON.parse(readFileSync(new URL('../../listings.demo.json', import.meta.url), 'utf8'));

describe('CQ11-D: creation tools follow the permanent listing snapshot', () => {
  it('accepts the three buttons and emits only one listing in the validation context', () => {
    const model = modelForV2(options);
    const result = checkSpecV2(model, draft());
    expect(result.problems ?? []).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.ctx ?? {})).toEqual(['listing']);
    expect(renderMenuV2(model)).toMatch(/keep.*burn.*grow/i);
    expect(renderMenuV2(model)).not.toMatch(/list by rule|legs |Splits:|lowest reading|cap preset/i);
  });

  it('accepts an indexer raise update on the same id and refreshes the spec hash', () => {
    const old = checkSpecV2(modelForV2(options), draft());
    const answer = copy();
    answer.listings[0].raise = '8400000000000000000';
    const model = modelForV2({ ...options, indexer: answer });
    const fresh = checkSpecV2(model, draft());
    expect(fresh.ok).toBe(true);
    expect(fresh.wire.raise).toBe(8_400_000_000_000_000_000n);
    expect(fresh.specHash).not.toBe(old.specHash);
    const stale = structuredClone(draft());
    stale.spec.raise = String(old.wire.raise);
    expect(checkSpecV2(model, stale).verdict?.reasonName).toBe('RAISE_NOT_A_PRESET');
    expect(old.wire.raise).not.toBe(fresh.wire.raise);
  });

  it.each([undefined, false, true])('keeps release retirement during a raise refresh with retired=%s (F122 R36H)', (retired) => {
    const answer = copy();
    const row = answer.listings.find((listing: { id: number }) => listing.id === 5);
    expect(row.retired).toBe(true);
    answer.listings = [Object.fromEntries(Object.entries({ ...row, raise: '9600000000000000000000' }).filter(([key]) => key !== 'retired'))];
    if (retired !== undefined) answer.listings[0].retired = retired;

    const offline = modelForV2(options);
    const refreshed = modelForV2({ ...options, indexer: answer });
    expect(refreshed.menu.source).toBe('indexer');
    expect(refreshed.menu.listings.find((listing) => listing.id === 5)?.raise).toBe(9_600_000_000_000_000_000_000n);
    for (const model of [offline, refreshed]) {
      expect.soft(model.menu.listings.find((listing) => listing.id === 5)?.retired).toBe(true);
      expect.soft(model.menu.offered.has('susds')).toBe(false);
      expect.soft(renderMenuV2(model)).not.toContain('sUSDS');
      for (const pricing of [row.symbol, row.address, { listingId: 5 }]) {
        const doc = draft();
        const result = checkSpecV2(model, { ...doc, spec: { ...doc.spec, pricing } });
        expect.soft(result.ok).toBe(false);
        expect.soft(result.problems).toEqual([expect.objectContaining({ path: 'pricing' })]);
        if (typeof pricing === 'object') expect.soft(result.problems?.[0]).toEqual(expect.objectContaining({ message: expect.stringMatching(/retired/) }));
      }
    }
  });

  it('allows a coin again only after the release copy explicitly clears retirement', () => {
    const policy = copy();
    policy.listings.find((listing: { id: number }) => listing.id === 5).retired = false;
    const scratch = fileURLToPath(new URL('../../../../.cache/lane/cq11-d-af1/', import.meta.url));
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(join(scratch, 'retirement-policy-'));
    writeFileSync(join(dir, 'listings.demo.json'), JSON.stringify(policy));
    copyFileSync(new URL('../../plug-ins.v2.json', import.meta.url), join(dir, 'plug-ins.v2.json'));
    const answer = copy();
    const row = answer.listings.find((listing: { id: number }) => listing.id === 5);
    answer.listings = [Object.fromEntries(Object.entries({ ...row, raise: '9600000000000000000000' }).filter(([key]) => key !== 'retired'))];
    const model = modelForV2({ ...options, dir, indexer: answer });
    expect(model.menu.offered.has('susds')).toBe(true);
    expect(renderMenuV2(model)).toContain('Demo sUSDS');
    const doc = draft();
    const result = checkSpecV2(model, { ...doc, spec: { ...doc.spec, pricing: { listingId: 5 } } });
    expect(result.ok).toBe(true);
    expect(result.wire.raise).toBe(9_600_000_000_000_000_000_000n);
    expect(readMenu('demo').listings.find((listing) => listing.id === 5)?.retired).toBe(true);
  });

  it('refuses a second id for the same coin and immutable identity drift', () => {
    const answer = copy();
    answer.listings.push({ ...answer.listings[0], id: 999 });
    expect(() => readMenu('demo', { indexer: answer })).toThrow();
    const drift = copy();
    drift.listings[0].decimals = 6;
    expect(() => readMenu('demo', { indexer: drift })).toThrow(/never changes/);
  });
});
