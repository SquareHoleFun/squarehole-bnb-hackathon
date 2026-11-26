/**
 * ADR-0008 fixtures: pair-details.json (hand-maintained, validated against feed.json) and accounts.json (generated
 * by scripts/gen-claims-fixture.py from the handoff reference model). Consistency tests across both and feed.json.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BURN_NATIVE_T_ROUTE_Q_V1,
  DataValidationError,
  canonicalPairId,
  estimatePayoutRaw,
  minPayoutRaw,
  parseAccountsFixture,
  parseFeedFixture,
  parsePairDetailsFixture,
  parseRational,
  sameAssetIdentity,
  splitWholeUnits,
  type AccountsFixture,
  type PairRecord,
} from '@squarehole/domain';
import { DEMO_BLOCK_CLOCK, demoBlockAt } from './mock/demo-chain';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const REPO_ROOT = here('../../../');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

const feed = parseFeedFixture(readJson(here('./fixtures/feed.json')));
const accountsText = readFileSync(here('./fixtures/accounts.json'), 'utf8');
const accounts = parseAccountsFixture(JSON.parse(accountsText), feed);
const details = parsePairDetailsFixture(readJson(here('./fixtures/pair-details.json')), feed);
const pairOf = (pairId: string): PairRecord => {
  const pair = feed.items.find((item) => canonicalPairId(item.pairId) === canonicalPairId(pairId));
  if (!pair) throw new Error(`unknown pair ${pairId}`);
  return pair;
};
const detailOf = (slug: string) => {
  const pair = feed.items.find((item) => item.slug === slug);
  return details.details.find((detail) => detail.pairId === pair?.pairId);
};
const ledgerOf = (slug: string) => accounts.ledgers.find((ledger) => ledger.slug === slug);
const persona = (id: string) => accounts.personas.find((p) => p.id === id);

interface ArtManifest {
  assets: { id: string }[];
}
const manifest = readJson(`${REPO_ROOT}packages/design/art/manifest.json`) as ArtManifest;
const ART_IDS = new Set(manifest.assets.map((asset) => asset.id));

describe('pair-details.json (SH-012)', () => {
  it('is schema-valid, demo, bound to the feed snapshot, with one detail per feed pair', () => {
    expect(details.mode).toBe('demo');
    expect(details.feedSnapshotId).toBe(feed.snapshotId);
    expect(details.details.map((d) => d.pairId).sort()).toEqual(feed.items.map((p) => p.pairId).sort());
  });

  it.each(feed.items.map((pair) => [pair.slug ?? pair.pairId, pair] as const))('%s: supply identities hold', (_slug, pair) => {
    const detail = details.details.find((d) => d.pairId === pair.pairId);
    if (!detail) throw new Error('missing detail');
    const { supply } = detail;
    expect(supply.currentRaw).toBe(pair.totalSupplyRaw);
    expect(supply.feeBurnedRaw).toBe(pair.burnedRaw);
    expect(BigInt(supply.initialCapRaw)).toBe(BigInt(pair.totalSupplyRaw) + BigInt(pair.burnedRaw));
    expect(supply.initialCapBasis).toBe('demo_derived_total_plus_burned');
    expect(BigInt(supply.feeBurnedRaw) <= BigInt(supply.initialCapRaw)).toBe(true);
    expect(supply.circulatingRaw === null || BigInt(supply.circulatingRaw) <= BigInt(supply.currentRaw)).toBe(true);
    expect(supply.activeNftCount).toBeNull(); // not observed in demo; never derived
    if (pair.type === 'nft_collection') {
      expect(supply.wholeUnitCapacity?.count).toBe(splitWholeUnits(BigInt(pair.totalSupplyRaw), BigInt(pair.nftUnitRaw ?? '0')).whole.toString());
    } else {
      expect(supply.wholeUnitCapacity).toBeNull();
    }
  });

  it.each(feed.items.map((pair) => [pair.slug ?? pair.pairId, pair] as const))('%s: activity is demo, on the demo block clock and reconciles burns', (_slug, pair) => {
    const detail = details.details.find((d) => d.pairId === pair.pairId);
    if (!detail) throw new Error('missing detail');
    expect(detail.canonicalStatus).toBe('demo_not_deployed');
    expect(detail.provenance).toMatchObject({ state: 'mock', coverage: 'demo' });
    expect(detail.activity[0]).toMatchObject({ kind: 'launch', at: pair.launchedAt });
    for (const row of detail.activity) {
      expect(row.txHash).toBeNull();
      expect(row.block).toBe(demoBlockAt(row.at));
    }
    const burned = detail.activity
      .filter((row) => row.kind === 'burn')
      .flatMap((row) => row.amounts)
      .reduce((total, amount) => total + BigInt(amount.amountRaw), 0n);
    expect(burned).toBe(BigInt(pair.burnedRaw)); // FEED-07: burned economic supply reconciles
  });

  it('flags only ORCHARD as the showcase (C14) and gives it an observed history with one explicit gap', () => {
    expect(details.details.filter((d) => d.showcase).map((d) => pairOf(d.pairId).slug)).toEqual(['orchard']);
    const history = detailOf('orchard')?.priceHistory;
    if (history?.state !== 'observed') throw new Error('expected observed history');
    const orchard = pairOf(detailOf('orchard')?.pairId ?? '');
    expect(history.points.filter((point) => point.priceUsd === null)).toHaveLength(1);
    expect(history.points.at(-1)).toEqual({ t: feed.asOf, priceUsd: orchard.priceUsd });
    for (const point of history.points) {
      expect(point.t >= orchard.launchedAt && point.t <= feed.asOf).toBe(true);
    }
    const others = details.details.filter((d) => pairOf(d.pairId).slug !== 'orchard');
    expect(others.every((d) => d.priceHistory.state === 'unavailable')).toBe(true);
  });

  it('uses only reviewed art ids; the ORCHARD gallery uses the four ORCHARD tree tiles', () => {
    for (const detail of details.details) {
      if (detail.artwork.state === 'ok') expect(ART_IDS.has(detail.artwork.artId), detail.artwork.artId).toBe(true);
      for (const item of detail.nft?.gallery ?? []) if (item.artId !== null) expect(ART_IDS.has(item.artId), item.artId).toBe(true);
    }
    const gallery = detailOf('orchard')?.nft?.gallery ?? [];
    expect(gallery.map((item) => item.artId).filter((id) => id !== null)).toEqual([
      'orchard-tree',
      'orchard-tree-sunglasses',
      'orchard-tree-blossom',
      'orchard-tree-winter',
    ]);
    expect(new Set(gallery.map((item) => item.tokenId)).size).toBe(gallery.length);
    expect(gallery.some((item) => item.artId === null)).toBe(true); // unavailable-art state exercised
    expect(detailOf('unpriced-example')?.artwork).toEqual({ state: 'unavailable', reason: 'not_uploaded' });
  });

  it('reward rows equal the replayed ledger totals, per asset, never summed', () => {
    for (const ledger of accounts.ledgers) {
      const pair = pairOf(ledger.pairId);
      const rewards = details.details.find((d) => d.pairId === ledger.pairId)?.rewards ?? [];
      const quoteRow = rewards.find((row) => sameAssetIdentity(row.asset, pair.quote));
      expect(quoteRow?.accruedRaw).toBe(ledger.totals.claimableQRaw);
      if (pair.rewardSide === 'Q') {
        expect(rewards).toHaveLength(1);
        expect(quoteRow?.paidRaw).toBe(ledger.totals.claimedQRaw);
      } else {
        const tokenRow = rewards.find((row) => sameAssetIdentity(row.asset, pair.token));
        expect(tokenRow).toEqual({ asset: pair.token, paidRaw: ledger.totals.tPaidRaw, accruedRaw: null });
      }
    }
  });

  it('rejects a mutated file (unknown pair) with a typed error', () => {
    const input = readJson(here('./fixtures/pair-details.json')) as { details: { pairId: string }[] };
    const first = input.details[0];
    if (first) first.pairId = '31337:0x0000000000000000000000000000000000000099';
    expect(() => parsePairDetailsFixture(input, feed)).toThrow(DataValidationError);
  });
});

describe('accounts.json (SH-014/SH-015, generated from the reference model)', () => {
  it('was generated from the current reference model and feed fixture', () => {
    expect(accounts.referenceSha256).toBe(sha256(`${REPO_ROOT}square-hole-handoff/reference/fee_policy_model.py`));
    expect(accounts.feedFixtureSha256).toBe(sha256(here('./fixtures/feed.json')));
    expect(accounts.asOfBlock).toBe(demoBlockAt(feed.asOf));
    expect(accounts.blockClock).toEqual(DEMO_BLOCK_CLOCK);
  });

  it('uses a 12-second demo block clock and rejects times off it', () => {
    expect(demoBlockAt(DEMO_BLOCK_CLOCK.genesis)).toBe('0');
    expect(demoBlockAt('2026-09-25T12:00:00Z')).toBe('39600');
    expect(() => demoBlockAt('2026-09-20T00:00:05Z')).toThrow(RangeError);
    expect(() => demoBlockAt('2026-09-19T23:59:48Z')).toThrow(RangeError);
  });

  it('measured the same Q split from the reference model as the TS policy constants', () => {
    const { qProtocolShare: p, qHolderShare: h } = BURN_NATIVE_T_ROUTE_Q_V1;
    expect(accounts.measuredPolicy).toEqual({ qProtocolShare: `${p.num}/${p.den}`, qHolderShare: `${h.num}/${h.den}` });
    expect(accounts.claimToleranceBps).toBe(100);
  });

  it('labels every persona as demo with a synthetic address', () => {
    expect(accounts.personas.map((p) => p.id)).toEqual(['current_holder', 'past_holder', 'never_held']);
    for (const p of accounts.personas) {
      expect(p.label).toMatch(/^Demo persona: /);
      expect(p.address).toMatch(/^0x0{32}de0000[0-9a-f]{2}$/);
    }
  });

  it.each(accounts.ledgers.map((ledger) => [ledger.slug, ledger] as const))('%s: claims never exceed holder allocations', (_slug, ledger) => {
    const claimable = ledger.accounts.reduce((total, account) => total + BigInt(account.claimableQRaw), 0n);
    const claimed = ledger.accounts.reduce((total, account) => total + BigInt(account.claimedQRaw), 0n);
    const allocated = BigInt(ledger.totals.holderAllocatedQRaw);
    const deferred = BigInt(ledger.totals.deferredQRaw);
    expect(claimable + claimed + deferred <= allocated).toBe(true);
    const dust = parseRational(ledger.totals.roundingDustQ);
    expect((claimable + claimed + deferred) * dust.den + dust.num).toBe(allocated * dust.den);
    expect(dust.num < BigInt(ledger.accounts.length + ledger.totals.settledClaims) * dust.den).toBe(true);
    // ECO-03: every realised Q receipt reconciles to protocol share + holder share.
    expect(BigInt(ledger.totals.protocolQRaw) + allocated).toBe(BigInt(ledger.totals.qReceivedRaw));
    expect(BigInt(ledger.totals.protocolQRaw) * 3n).toBe(BigInt(ledger.totals.qReceivedRaw));
  });

  it.each(accounts.ledgers.map((ledger) => [ledger.slug, ledger] as const))('%s: the replay reconciles with the feed record', (_slug, ledger) => {
    const pair = pairOf(ledger.pairId);
    expect(ledger.totals.tBurnedRaw).toBe(pair.burnedRaw);
    expect(ledger.totals.totalSupplyRaw).toBe(pair.totalSupplyRaw);
    expect(ledger.totals.eligibleSupplyRaw).toBe(pair.circulatingSupplyRaw);
    for (const event of ledger.events) expect(event.block).toBe(demoBlockAt(event.at));
    const burns = ledger.events.reduce((total, event) => total + BigInt(event.feeTRaw ?? '0'), 0n);
    expect(burns).toBe(BigInt(pair.burnedRaw));
  });

  it('ECO-05: the past holder has ZERO balance on ORCHARD and still a positive earned claim', () => {
    const address = persona('past_holder')?.address;
    const account = ledgerOf('orchard')?.accounts.find((a) => a.address === address);
    expect(account?.balanceRaw).toBe('0');
    expect(BigInt(account?.claimableQRaw ?? '0') > 0n).toBe(true);
    const frames = ledgerOf('tiny-frames')?.accounts.find((a) => a.address === address);
    expect(frames?.balanceRaw).toBe('0');
    expect(BigInt(frames?.claimableQRaw ?? '0') > 0n).toBe(true);
    expect(frames?.history.map((entry) => entry.outcome)).toEqual(['settled', 'reverted']); // ECO-07
  });

  it('the current holder holds whole ORCHARD NFTs plus a fraction, whose ids are in the gallery', () => {
    const address = persona('current_holder')?.address;
    const account = ledgerOf('orchard')?.accounts.find((a) => a.address === address);
    const pair = pairOf(ledgerOf('orchard')?.pairId ?? '');
    const { whole, fraction } = splitWholeUnits(BigInt(account?.balanceRaw ?? '0'), BigInt(pair.nftUnitRaw ?? '1'));
    expect(whole > 0n && fraction > 0n).toBe(true);
    expect(BigInt(account?.nftTokenIds.length ?? 0)).toBe(whole);
    const gallery = new Set(detailOf('orchard')?.nft?.gallery.map((item) => item.tokenId));
    for (const id of account?.nftTokenIds ?? []) expect(gallery.has(id)).toBe(true);
    expect(BigInt(account?.claimableQRaw ?? '0') > 0n).toBe(true);
  });

  it('never-held appears in no ledger', () => {
    const address = persona('never_held')?.address;
    expect(accounts.ledgers.flatMap((ledger) => ledger.accounts).some((a) => a.address === address)).toBe(false);
  });

  it('R=T estimates equal floor(claimable x tPerQ) and the fixed 1% minimum (TS recomputation of the Python output)', () => {
    for (const ledger of accounts.ledgers.filter((l) => l.rewardSide === 'T')) {
      const pair = pairOf(ledger.pairId);
      for (const account of ledger.accounts) {
        const estimate = account.convertibleEstimate;
        if (BigInt(account.claimableQRaw) === 0n) {
          expect(estimate).toBeNull();
          continue;
        }
        const payout = estimatePayoutRaw(BigInt(account.claimableQRaw), ledger.quote?.tPerQ ?? '0', pair.quote.decimals, pair.token.decimals);
        expect(estimate).toEqual({ payoutRaw: payout.toString(), minPayoutRaw: minPayoutRaw(payout).toString() });
      }
    }
  });

  it('rejects a tampered fixture (claim inflated beyond the allocation identity)', () => {
    const tampered = JSON.parse(accountsText) as AccountsFixture;
    const first = tampered.ledgers[0]?.accounts[0];
    if (first) first.claimableQRaw = (BigInt(first.claimableQRaw) + 1n).toString();
    expect(() => parseAccountsFixture(tampered, feed)).toThrow(DataValidationError);
  });
});

const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasPython = probe.error === undefined && probe.status === 0;

describe('accounts.json golden', () => {
  it.skipIf(!hasPython)(
    hasPython
      ? 'committed fixture is up to date (re-runs python3 scripts/gen-claims-fixture.py --stdout)'
      : 'committed fixture is up to date - SKIPPED: python3 is not available on PATH',
    () => {
      const result = spawnSync('python3', ['scripts/gen-claims-fixture.py', '--stdout'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        timeout: 60_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(accountsText);
    },
  );
});
