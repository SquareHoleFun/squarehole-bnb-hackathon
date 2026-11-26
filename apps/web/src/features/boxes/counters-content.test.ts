import { describe, expect, it } from 'vitest';
import { DEMO_FIT_TARGET } from '../fit-pair/fit-target';
import type { BoxState } from './box-model';
import { launchRecord } from './box-sources';
import { countersFor, NOT_IN_APP, notBuilt, phoneBarNote, primaryAction, type Counter } from './counters';
import { DEMO_BOXES } from './demo-boxes';
import { compositionAddsUp, compositionFor, familyCount, ORDINARY_POOL, RARE_ART, TEASERS } from './misfits-content';
import { chainWalletBox, DEMO_WALLET_A, DEMO_WALLET_B, demoWalletBox, holdsSomething, isOwnWallet, walletStats } from './wallet-box';

const misfits = launchRecord(DEMO_FIT_TARGET);
const LINK = { href: 'https://app.uniswap.org/explore/tokens/ethereum/0x1', host: 'app.uniswap.org' };

/** "label: open (actions…) / closed (reason)" per counter, for a readable table. */
function row(counters: readonly Counter[]): string[] {
  return counters.map((c) => `${c.label}: ${c.open ? `${c.actions.map((a) => `${a.label}${a.enabled ? '' : '×'}`).join(' / ')}${c.reason ? ` · ${c.reason}` : ''}` : `closed · ${c.reason}`}`);
}

describe('the Misfits counters per state (no vault or claim writer in this launch set)', () => {
  const table: readonly (readonly [BoxState, readonly string[]])[] = [
    ['upcoming', ['Conversion: closed · Opens with the curve', 'Claims: closed · After graduation', 'Market: closed · Starts with the curve']],
    ['window', [`Conversion: Get a placeholder× · ${NOT_IN_APP}`, 'Claims: closed · After graduation', 'Market: closed · not live yet']],
    ['bonding', [`Conversion: Get a placeholder× · ${NOT_IN_APP}`, 'Claims: closed · After graduation', 'Market: Open on Uniswap']],
    ['graduating', ['Conversion: closed · Graduation pending', 'Claims: closed · After graduation', 'Market: Open on Uniswap']],
    ['graduated', [`Conversion: Take one out× / Put it back× · ${NOT_IN_APP}`, 'Claims: closed · Not built yet', 'Market: Open on Uniswap']],
  ];
  for (const [state, expected] of table) {
    it(state, () => {
      const link = state === 'window' ? null : LINK;
      expect(row(countersFor({ record: misfits, state, marketLink: link, marketReason: 'not live yet' }))).toEqual(expected);
    });
  }

  it('never enables a vault action; only a verified market link works, and the phone bar shows it or says why not', () => {
    for (const state of ['upcoming', 'window', 'bonding', 'graduating', 'graduated', 'failed'] as const) {
      for (const marketLink of [null, LINK]) {
        const counters = countersFor({ record: misfits, state, marketLink, marketReason: 'No links in Demo' });
        const enabled = counters.flatMap((c) => c.actions.filter((a) => a.enabled));
        expect(enabled.every((a) => a.href === LINK.href)).toBe(true);
        if (marketLink === null) expect(enabled).toEqual([]);
      }
    }
    const none = countersFor({ record: misfits, state: 'bonding', marketLink: null, marketReason: 'No links in Demo' });
    expect(primaryAction(none)).toEqual({ reason: NOT_IN_APP });
    expect(primaryAction(countersFor({ record: misfits, state: 'upcoming', marketLink: null, marketReason: 'x' }))).toEqual({ reason: 'Opens with the curve' });
    const withLink = primaryAction(countersFor({ record: misfits, state: 'bonding', marketLink: LINK, marketReason: '' }));
    expect('action' in withLink && withLink.action).toMatchObject({ label: 'Open on Uniswap', href: LINK.href, enabled: true });
    expect(row(countersFor({ record: misfits, state: null, marketLink: null, marketReason: 'x' }))).toEqual(['Conversion: closed · Unavailable', 'Claims: closed · After graduation', 'Market: closed · Unavailable']);
  });

  it('follows each Demo box’s capabilities, not only its state', () => {
    const [kites, stamps, trains, , cans] = DEMO_BOXES;
    if (!kites || !stamps || !trains || !cans) throw new Error('missing Demo box');
    const demo = (record: typeof kites, state: BoxState) => row(countersFor({ record, state, marketLink: null, marketReason: 'No links in Demo' }));
    expect(demo(kites, 'upcoming')).toEqual(['Conversion: closed · Opens with the curve', 'Claims: closed · No claims in this set-up', 'Market: closed · Starts with the curve']);
    // Existing NFTs: no placeholders, a pick instead of a draw.
    expect(demo(stamps, 'bonding')[0]).toBe('Conversion: closed · Opens at graduation');
    expect(demo(stamps, 'graduated')[0]).toBe(`Conversion: Pick one out× / Put it back× · ${NOT_IN_APP}`);
    // Holder claims (the Demo only, F74 U1): the same words as their tile and the About row.
    expect(demo(stamps, 'bonding')[1]).toBe('Claims: closed · Pending legal review');
    expect(demo(cans, 'failed')).toEqual([`Conversion: Open placeholder× / Hand back× · ${NOT_IN_APP}`, 'Claims: closed · No claims in this set-up', 'Market: closed · No links in Demo']);
  });

  it('the phone bar: a failed box points at its refund; an action not built yet reads like a closed counter', () => {
    const cans = DEMO_BOXES[4];
    if (!cans) throw new Error('missing Tin Cans');
    const failed = countersFor({ record: cans, state: 'failed', marketLink: null, marketReason: 'No links in Demo' });
    expect(phoneBarNote(failed, 'failed')).toBe('Refund · No links in Demo');
    const bonding = countersFor({ record: misfits, state: 'bonding', marketLink: null, marketReason: 'No links in Demo' });
    expect(phoneBarNote(bonding, 'bonding')).toBeNull();
    expect(bonding.map(notBuilt)).toEqual([true, false, false]);
    const live = countersFor({ record: misfits, state: 'bonding', marketLink: LINK, marketReason: '' });
    expect(live.map(notBuilt)).toEqual([true, false, false]);
  });
});

describe('what is in the Misfits box (F45, F47)', () => {
  it('shows a composition only when its rows add up to N from the data', () => {
    for (const size of [4_200n, 4_269n]) {
      const table = compositionFor(size);
      expect(table?.size).toBe(size);
      expect(table && compositionAddsUp(table)).toBe(true);
    }
    expect(compositionFor(4_269n)?.families.at(-1)).toMatchObject({ id: 'Icons', count: 69n, sealed: true, avatar: null });
    // 4,269 is the 4,200 table plus the Icons: an assumption until the founder confirms it (open question 3).
    expect(compositionFor(4_269n)?.assumed).toBe(true);
    expect(compositionFor(4_200n)?.assumed).toBe(false);
    expect(compositionFor(4_200n)?.finishes.map((f) => [f.id, f.count])).toEqual([
      ['Diamond', 26n],
      ['Glass', 28n],
      ['Gold', 31n],
    ]);
    for (const size of [null, 0n, 4_201n, 10_000n]) expect(compositionFor(size)).toBeNull();
    expect(familyCount(compositionFor(4_200n), 'Coin')?.count).toBe(520n);
  });

  it('teases eight ordinary pieces only: no one-of-one, Classic, Diamond, Glass, Gold or Icon (F47 guard)', () => {
    expect(TEASERS).toHaveLength(8);
    // One per family in the legend's order, then two more named by family and role; no proper names among them.
    const legend = (compositionFor(4_269n)?.families ?? []).filter((row) => !row.sealed).map((row) => row.id);
    expect(TEASERS.slice(0, legend.length).map((teaser) => teaser.title)).toEqual(legend);
    expect(TEASERS.slice(legend.length).map((teaser) => teaser.title)).toEqual(['Coin · Mechanic', 'RWA · Explorer']);
    for (const teaser of TEASERS) expect(teaser.title.startsWith(teaser.family), teaser.slug).toBe(true);
    expect(new Set(TEASERS.map((teaser) => `${teaser.family}, ${teaser.role}`)).size).toBe(8);
    for (const teaser of TEASERS) {
      expect(RARE_ART.has(teaser.slug), teaser.slug).toBe(false);
      expect(ORDINARY_POOL.get(teaser.family)?.includes(teaser.slug), teaser.slug).toBe(true);
      expect(teaser.finish).toBe('Standard');
      expect(teaser.title).not.toMatch(/diamond|glass|gold|icon|classic|one-of-one|#\d/i);
    }
    for (const row of compositionFor(4_269n)?.families ?? []) {
      if (row.avatar !== null) expect(RARE_ART.has(row.avatar), row.id).toBe(false);
      if (['One-of-ones', 'Classics', 'Icons'].includes(row.id)) expect(row).toMatchObject({ sealed: true, avatar: null });
    }
  });
});

describe('wallet boxes (view only, no totals, never 0 for unread)', () => {
  it('Demo wallet A during the curve and B after graduation; anyone else holds nothing from a supported box', () => {
    const boxes = [launchRecord(DEMO_FIT_TARGET), ...DEMO_BOXES];
    const a = demoWalletBox(DEMO_WALLET_A, boxes);
    expect(a.holdings.map((h) => [h.record.ticker, h.state, h.sealed, h.revealed])).toEqual([
      ['FIT', 'bonding', 2n, 0n],
      ['POTS', 'bonding', 0n, 0n],
    ]);
    expect(walletStats(a)).toEqual({ boxes: 2, items: 2n });
    const b = demoWalletBox(DEMO_WALLET_B, boxes);
    expect(b.holdings.map((h) => [h.record.ticker, h.revealed, h.scenario])).toEqual([
      ['FIT', 3n, 'migrated'],
      ['CHOO', 4n, null],
    ]);
    expect(walletStats(b)).toEqual({ boxes: 2, items: 7n });
    const other = demoWalletBox('0x0000000000000000000000000000000000000001', boxes);
    expect(other.holdings).toEqual([]);
    expect(walletStats(other)).toEqual({ boxes: 0, items: 0n });
  });

  it('a chain read keeps a contract the deployment does not name as unknown, never zero', () => {
    const record = launchRecord(DEMO_FIT_TARGET);
    const wallet = chainWalletBox(
      { block: { number: 9n, hash: `0x${'ab'.repeat(32)}`, timestamp: 1n }, account: DEMO_WALLET_A, tokenBalance: 0n, collectionBalance: null, placeholderBalance: null },
      record,
      'bonding',
    );
    expect(holdsSomething(wallet.holdings[0] ?? (null as never))).toBe(false);
    expect(walletStats(wallet)).toEqual({ boxes: 0, items: null });
    expect(isOwnWallet(DEMO_WALLET_A.toLowerCase(), DEMO_WALLET_A)).toBe(true);
    expect(isOwnWallet(DEMO_WALLET_A, null)).toBe(false);
  });
});
