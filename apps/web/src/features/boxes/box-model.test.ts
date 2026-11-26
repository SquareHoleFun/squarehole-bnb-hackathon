import { getSqrtPriceAtTick } from '@squarehole/indexer/client';
import { describe, expect, it } from 'vitest';
import { liveDataFromDirect } from '../fit-pair/direct-source';
import { DEMO_FIT_TARGET, FIT_ISSUANCE_RAW, type FitMarketTarget } from '../fit-pair/fit-target';
import type { LiveData } from '../fit-pair/live-model';
import { boxPath, formatBoxId, parseAddress, parseBoxId, parseBoxRoute, walletPath } from './box-id';
import { approxDuration, decimalToRaw, demoSummary, launchSummary, marketCapWei, type SummaryFreshness } from './box-figure';
import { BOX_STATES, type BoxState, type BoxSummary } from './box-model';
import { filterSummaries, matchesQuery, mixedAssets, sortAvailability, sortSummaries, stateCounts, walletQuery } from './box-feed';
import { DEFAULT_BOX_FEED, pairFeedRedirect, parseBoxFeedParams, serialiseBoxFeedParams } from './box-feed-params';
import { boxesFor, launchRecord } from './box-sources';
import { launchBoxState } from './box-state';
import { DEMO_BOXES } from './demo-boxes';

const T: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', rpcUrl: 'http://127.0.0.1:8599' };
const HASH = `0x${'12'.repeat(32)}` as const;
const MID_TICK = Math.round((T.curve.tickLower + T.curve.tickUpper) / 2 / 60) * 60;

/** Chain data at `block`, in a phase, at a price (the box reads the phase, the window, the figures and the burn). */
function at(block: bigint, phase: 'curve' | 'completed' | 'migrated' = 'curve', sqrt = T.curve.sqrtPriceUpperX96, burned = 5_000_000n * 10n ** 18n): LiveData {
  return liveDataFromDirect(
    {
      block: { number: block, hash: HASH, timestamp: 1_790_726_400n },
      safeBlock: null,
      finalizedBlock: null,
      sqrtPriceX96: sqrt,
      tick: 0,
      phase,
      completedBlock: phase === 'curve' ? null : block - 40n,
      migratedBlock: phase === 'migrated' ? block - 8n : null,
      liquidityOpensAtBlock: null,
      openBlock: T.openBlock,
      totalSupplyRaw: FIT_ISSUANCE_RAW - burned,
    },
    T,
  );
}

describe('box ids (/box/:id)', () => {
  it('round-trips chain id and lowercase token, and refuses junk without repairing it', () => {
    const id = formatBoxId(11_155_111, '0x07cB5710D589c9763192E76694FCd3E8F5a0B353');
    expect(id).toBe('11155111-0x07cb5710d589c9763192e76694fcd3e8f5a0b353');
    expect(parseBoxId(id)).toEqual({ chainId: 11_155_111, token: '0x07cb5710d589c9763192e76694fcd3e8f5a0b353' });
    // Mixed case is accepted and canonicalised; the identity is the address.
    expect(parseBoxId('31337-0x000000000000000000000000000000000000F17E')?.token).toBe('0x000000000000000000000000000000000000f17e');
    for (const junk of [undefined, '', '__proto__', 'constructor', '1-0x00', '1-0x000000000000000000000000000000000000f17e', '31337-0xzz0000000000000000000000000000000000f17e', `31337-0x${'0'.repeat(40)}-x`, ' 31337-0x000000000000000000000000000000000000f17e']) {
      expect(parseBoxId(junk), String(junk)).toBeNull();
    }
    // The path is BOX-INTERFACE § 9's: /box/<chain>/<address>; its params parse to the same id, junk to null.
    expect(boxPath(id)).toBe('/box/11155111/0x07cb5710d589c9763192e76694fcd3e8f5a0b353');
    expect(parseBoxRoute('11155111', '0x07cB5710D589c9763192E76694FCd3E8F5a0B353')).toEqual(parseBoxId(id));
    for (const [chain, address] of [['1', '0x07cb5710d589c9763192e76694fcd3e8f5a0b353'], ['11155111', '__proto__'], [undefined, '0x07cb5710d589c9763192e76694fcd3e8f5a0b353'], ['11155111', undefined]] as const) {
      expect(parseBoxRoute(chain, address), `${chain}/${address}`).toBeNull();
    }
    expect(() => boxPath('__proto__')).toThrow();
    expect(walletPath('0xDe00000000000000000000000000000000000A11')).toBe('/wallet/0xde00000000000000000000000000000000000a11');
    expect(parseAddress(' 0xDe00000000000000000000000000000000000A11 ')).toBe('0xde00000000000000000000000000000000000a11');
    expect(parseAddress('0xDe00')).toBeNull();
  });
});

describe('launch box state', () => {
  it('maps every phase × window × gate, never to failed, and unknown data to null', () => {
    expect(launchBoxState(at(T.openBlock - 11n), { gateOpen: false })).toBe('upcoming');
    expect(launchBoxState(at(T.openBlock + 3n), { gateOpen: false })).toBe('window');
    expect(launchBoxState(at(T.closeBlock + 3n), { gateOpen: false })).toBe('bonding');
    expect(launchBoxState(at(T.closeBlock + 3n, 'completed'), { gateOpen: false })).toBe('graduating');
    expect(launchBoxState(at(T.closeBlock + 90n, 'migrated'), { gateOpen: false })).toBe('graduated');
    expect(launchBoxState(at(T.closeBlock + 90n, 'migrated'), null)).toBe('graduated');
    // The vault's gate decides even before the curve data arrives.
    expect(launchBoxState(null, { gateOpen: true })).toBe('graduated');
    expect(launchBoxState(null, { gateOpen: false })).toBeNull();
    expect(launchBoxState(null, null)).toBeNull();
    const seen = new Set<BoxState | null>();
    for (const block of [T.openBlock - 11n, T.openBlock + 3n, T.closeBlock + 3n]) {
      for (const phase of ['curve', 'completed', 'migrated'] as const) for (const gateOpen of [false, true, null]) seen.add(launchBoxState(at(block, phase), { gateOpen }));
    }
    expect(seen.has('failed')).toBe(false);
  });
});

describe('the one figure per state (bigint, truncated; charges rounded up)', () => {
  const record = launchRecord(T);
  it('says when it opens, the window tax, progress, target reached and the market cap', () => {
    const upcoming = launchSummary(record, 'upcoming', at(T.openBlock - 300n), T);
    expect(upcoming.figure.text).toBe('Opens in ~1 h');
    const window = launchSummary(record, 'window', at(T.openBlock + 9n), T);
    expect(window.figure.text).toMatch(/^Tax \d+\.\d\d% · 22 blocks$/);
    const bonding = launchSummary(record, 'bonding', at(T.closeBlock + 3n, 'curve', getSqrtPriceAtTick(MID_TICK)), T);
    // One precision for the target and the progress, the Token tab's: 4 decimals, truncated.
    // F74 U5: the one raise exactly; the ETH kept by the curve to 4 decimals.
    expect(bonding.figure.text).toMatch(/^\d+\.\d% · \d+(\.\d{1,4})? \/ 4\.206980085 ETH$/);
    expect(bonding.figure.barBps).toBeGreaterThan(0);
    expect(launchSummary(record, 'graduating', at(T.closeBlock + 3n, 'completed'), T).figure).toEqual({ text: 'Target reached', barBps: 10_000 });
    const graduated = launchSummary(record, 'graduated', at(T.closeBlock + 90n, 'migrated'), T);
    // Price × total supply S, which includes the FIT locked in the vault: a fully diluted value, so "FDV".
    expect(graduated.figure.text).toMatch(/^FDV [\d,.]+ ETH$/);
    expect(graduated.mcapRaw).toBe(marketCapWei(at(T.closeBlock + 90n, 'migrated').state.figures.priceEthPerToken, FIT_ISSUANCE_RAW - 5_000_000n * 10n ** 18n));
    expect(launchSummary(record, null, null, T).figure.text).toBe('Unavailable');
    expect(graduated.notice).toBeNull();
  });

  it('never shows a value built from a price the page hides: unverified or unavailable data has no FDV', () => {
    const live = at(T.closeBlock + 90n, 'migrated');
    for (const freshness of ['unverified', 'unavailable'] as const) {
      const summary = launchSummary(record, 'graduated', live, T, { freshness, staleSinceBlock: null });
      expect(summary.mcapRaw, freshness).toBeNull();
      expect(summary.figure.text, freshness).toBe('FDV not available');
    }
    expect(launchSummary(record, 'graduated', live, T, { freshness: 'unverified', staleSinceBlock: null }).notice).toBe('Unverified');
    // Stale data keeps its figures and says since when.
    const stale: SummaryFreshness = { freshness: 'stale', staleSinceBlock: 21_000_512n };
    const staleSummary = launchSummary(record, 'graduated', live, T, stale);
    expect(staleSummary.mcapRaw).not.toBeNull();
    expect(staleSummary.notice).toBe('Stale · since block 21,000,512');
    for (const freshness of ['live', 'polling', 'direct', 'connecting'] as const) expect(launchSummary(record, 'graduated', live, T, { freshness, staleSinceBlock: null }).notice).toBeNull();
  });

  it('formats durations, decimals and market caps exactly', () => {
    expect([59n, 60n, 3_599n, 3_600n, 7_199n, 172_799n, 172_800n].map(approxDuration)).toEqual(['<1 min', '~1 min', '~59 min', '~1 h', '~1 h', '~47 h', '~2 d']);
    expect(decimalToRaw('6200.5', 6)).toBe(6_200_500_000n);
    expect(decimalToRaw('0.0000001', 6)).toBe(0n);
    expect(marketCapWei('0.00000004', 10n ** 27n)).toBe(40n * 10n ** 18n);
    expect(marketCapWei('not a number', 1n)).toBeNull();
  });

  it('labels every Demo box with its state’s figure, from decimal strings', () => {
    const texts = Object.fromEntries(DEMO_BOXES.map((box) => [box.ticker, demoSummary(box).figure.text]));
    // F74 U5: every box raises the same, stated exactly (4.206980085 ETH); what the curve holds keeps 4 decimals.
    expect(texts).toEqual({ KITE: 'Opens in ~2 h', STMP: '34.0% · 1.4303 / 4.206980085 ETH', CHOO: 'FDV 18.4 ETH', POTS: '62.0% · 2.6083 / 4.206980085 ETH', TINS: 'Refunds open' });
    for (const box of DEMO_BOXES) expect(demoSummary(box).notice).toBeNull();
    for (const box of DEMO_BOXES) expect([box.ticker, box.pairAsset, box.demoFigures?.target]).toEqual([box.ticker, 'ETH', '4.206980085']);
  });
});

describe('the Demo boxes (mock data stays labelled Demo)', () => {
  it('are all Demo, on invented addresses of the demo chain, with decimal-string amounts', () => {
    expect(DEMO_BOXES.map((box) => box.demoState)).toEqual(['upcoming', 'bonding', 'graduated', 'bonding', 'failed']);
    for (const box of DEMO_BOXES) {
      expect(box.demo).toBe(true);
      expect(box.featured).toBe(false);
      expect(box.chainId).toBe(31_337);
      expect(box.token).toMatch(/^0xde007[0]{31}[0-9a-f]{4}$/);
      expect(box.vault).toMatch(/^0xde00b[0]{31}[0-9a-f]{4}$/);
      expect(parseBoxId(box.id)?.token).toBe(box.token);
      for (const value of [box.demoFigures?.target, box.demoFigures?.retained, box.demoFigures?.mcap, box.demoFigures?.volume24h]) {
        if (value !== undefined) expect(value).toMatch(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
      }
    }
    expect(new Set(DEMO_BOXES.map((box) => box.id)).size).toBe(DEMO_BOXES.length);
  });
});

describe('box sources per data source', () => {
  it('Demo: the Demo Misfits, Featured, then the five Demo boxes; a chain source without a record has none', () => {
    const demo = boxesFor('demo', { fitMarkets: [], localRpcUrl: 'http://127.0.0.1:8545' });
    expect(demo.boxes.map((box) => box.ticker)).toEqual(['FIT', 'KITE', 'STMP', 'CHOO', 'POTS', 'TINS']);
    expect(demo.boxes[0]).toMatchObject({ featured: true, rehearsal: false, demo: true, itemCount: 4_269n, kind: 'genesis' });
    const sepolia = boxesFor('sepolia', { fitMarkets: [], localRpcUrl: 'http://127.0.0.1:8545' });
    expect(sepolia.boxes).toEqual([]);
    expect(sepolia.missing).toMatch(/no market record for Sepolia/);
  });

  it('a rehearsal record is a normal box: not Featured, its own names, its own N', () => {
    const neutral: FitMarketTarget = {
      ...T,
      names: { kind: 'neutral', tokenName: 'Rehearsal Token 2', tokenSymbol: 'RHT2', collectionName: 'Rehearsal Collection', collectionSymbol: 'RHC', placeholderName: 'Rehearsal placeholder', placeholderSymbol: 'RHC-P', item: 'item', items: 'items' },
      collectionSize: 4_269n,
    };
    expect(launchRecord(neutral)).toMatchObject({ featured: false, rehearsal: true, name: 'Rehearsal Collection', ticker: 'RHT2', itemCount: 4_269n, itemNoun: 'items' });
  });
});

describe('the box feed: URL state, search, counts and sorts', () => {
  it('parses untrusted params through allowlists and writes only non-defaults', () => {
    const parsed = parseBoxFeedParams(new URLSearchParams('q=%20kites%20&state=__proto__&sort=constructor&view=list&scenario=migrated&type=x'), { allowScenario: true });
    expect(parsed).toEqual({ q: 'kites', state: 'all', sort: 'new', view: 'list', scenario: 'migrated' });
    expect(parseBoxFeedParams(new URLSearchParams('scenario=migrated'), { allowScenario: false }).scenario).toBe('curve');
    expect(serialiseBoxFeedParams(DEFAULT_BOX_FEED).toString()).toBe('');
    expect(serialiseBoxFeedParams({ ...DEFAULT_BOX_FEED, state: 'bonding', sort: 'mcap' }, new URLSearchParams('keep=1')).toString()).toBe('keep=1&state=bonding&sort=mcap');
  });

  it('an old pair-feed link opens the box feed in one step, keeping its search; a box feed link stays', () => {
    // F134 R46B: the pair feed is off in every build, so an old link opens the box feed, keeping its search.
    expect(pairFeedRedirect(new URLSearchParams('type=token'))).toBe('/');
    expect(pairFeedRedirect(new URLSearchParams('q=orch&type=nft_collection'))).toBe('/?q=orch');
    expect(pairFeedRedirect(new URLSearchParams('sort=turnover'))).toBe('/');
    expect(pairFeedRedirect(new URLSearchParams('lifecycle=amm&reward=T&view=list'))).toBe('/?view=list');
    for (const boxes of ['', 'q=kites', 'state=bonding&sort=mcap&view=list', 'scenario=migrated', 'sort=__proto__']) expect(pairFeedRedirect(new URLSearchParams(boxes)), boxes).toBeNull();
  });

  const record = launchRecord(DEMO_FIT_TARGET);
  const misfits: BoxSummary = { record, state: 'bonding', figure: { text: '62.0%', barBps: 6_200 }, mcapRaw: null, progressBps: 6_200, volumeRaw: null, notice: null };
  const summaries: BoxSummary[] = [misfits, ...DEMO_BOXES.map(demoSummary)];

  it('searches names, tickers and addresses, and offers an unknown full address as a wallet', () => {
    expect(filterSummaries(summaries, 'all', 'pots').map((s) => s.record.ticker)).toEqual(['POTS']);
    expect(filterSummaries(summaries, 'all', 'fit').map((s) => s.record.ticker)).toEqual(['FIT']);
    const kites = DEMO_BOXES[0];
    if (!kites) throw new Error('no kites');
    expect(matchesQuery(demoSummary(kites), kites.token.slice(0, 10))).toBe(true);
    expect(matchesQuery(demoSummary(kites), '0x12')).toBe(false);
    // The visible short form and a bare fragment of four hex digits or more, anywhere in the address.
    expect(filterSummaries(summaries, 'all', 'f17e').map((s) => s.record.ticker)).toEqual(['FIT']);
    expect(filterSummaries(summaries, 'all', '0x0000…f17e').map((s) => s.record.ticker)).toEqual(['FIT']);
    expect(filterSummaries(summaries, 'all', '0x0000...f17e').map((s) => s.record.ticker)).toEqual(['FIT']);
    expect(filterSummaries(summaries, 'all', '0xde00…0003').map((s) => s.record.ticker)).toEqual(['CHOO']);
    expect(filterSummaries(summaries, 'all', '0xde00…0b22')).toEqual([]);
    expect(filterSummaries(summaries, 'all', 'f17')).toEqual([]);
    // 0x and four hex digits or more is a prefix: "0x0000" is the Misfits' token, not every address with zeros in it.
    expect(filterSummaries(summaries, 'all', '0x0000').map((s) => s.record.ticker)).toEqual(['FIT']);
    expect(walletQuery(summaries, '0xDe00000000000000000000000000000000000A11')).toBe('0xde00000000000000000000000000000000000a11');
    expect(walletQuery(summaries, kites.token)).toBeNull();
    expect(walletQuery(summaries, 'pots')).toBeNull();
  });

  it('counts each state and filters by it', () => {
    const counts = stateCounts(summaries);
    expect(counts).toEqual({ all: 6, upcoming: 1, window: 0, bonding: 3, graduating: 0, graduated: 1, failed: 1 });
    expect(BOX_STATES.reduce((sum, state) => sum + counts[state], 0)).toBe(6);
    expect(filterSummaries(summaries, 'bonding', '').map((s) => s.record.ticker)).toEqual(['FIT', 'STMP', 'POTS']);
  });

  it('keeps the Featured box first; market cap sorts within each pair asset; 24h volume only when every box has it', () => {
    expect(sortSummaries(summaries, 'new').map((s) => s.record.ticker)).toEqual(['FIT', 'KITE', 'STMP', 'CHOO', 'POTS', 'TINS']);
    expect(sortSummaries(summaries, 'progress').map((s) => s.record.ticker)).toEqual(['FIT', 'POTS', 'STMP', 'KITE', 'CHOO', 'TINS']);
    // Every Demo box is paired with ETH now (F74 U5: one raise; another Q's "ETH equivalent" is open, S12); upcoming last.
    expect(sortSummaries(summaries, 'mcap').map((s) => s.record.ticker)).toEqual(['FIT', 'CHOO', 'STMP', 'POTS', 'TINS', 'KITE']);
    // One price coin per chain and coin address (XR fix round 1): the Misfits' native ETH (the zero address) and the
    // Demo boxes' ETH (no address) on the same chain are one coin.
    expect(mixedAssets(summaries)).toBe(false);
    // A box in another pair asset still sorts after the ETH boxes, never converted.
    const pots = summaries.find((s) => s.record.ticker === 'POTS') as BoxSummary;
    const usdc = { ...pots, record: { ...pots.record, ticker: 'USDC-POTS', pairAsset: 'USDC' as const }, mcapRaw: 10n ** 30n };
    expect(mixedAssets([...summaries, usdc])).toBe(true);
    expect(sortSummaries([...summaries, usdc], 'mcap').map((s) => s.record.ticker)).toEqual(['FIT', 'CHOO', 'STMP', 'POTS', 'TINS', 'USDC-POTS', 'KITE']);
    expect(sortAvailability(summaries, 'volume')).toBe('Not every box has a 24h volume yet');
    // Unavailable falls back to "New", never to a made-up order.
    expect(sortSummaries(summaries, 'volume')).toEqual(sortSummaries(summaries, 'new'));
    const demoOnly = DEMO_BOXES.map(demoSummary);
    expect(sortAvailability(demoOnly, 'volume')).toBeNull();
    expect(sortSummaries(demoOnly, 'volume').map((s) => s.record.ticker)).toEqual(['CHOO', 'POTS', 'STMP', 'TINS', 'KITE']);
  });
});
