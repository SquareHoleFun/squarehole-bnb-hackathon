/**
 * Each fee side's menu (box creation flow § 2.2, F70): built from the catalog's members and the factory's own check,
 * so the table in the flow doc is what the page offers. ETH is the only listed Q: Burn ETH is left out, holder kinds
 * are offered in the Demo only, marked "Pending legal review" (F74 U1; off on Sepolia and mainnet), and BP-13's pair
 * (sellers' Burn FIT beside buyers' Burn KITE) is off with its reason.
 */
import { CONTEXT_V2, DEMO_OPEN_ART, DEMO_TOKEN_ONLY, NETWORKS, QClass, QStream, Reason, TStream, validateBoxSpecV1, type BoxSpecV1, type QAsset, type VersionContext } from '@squarehole/box-spec';
import type { Address } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import { NEUTRAL_TOKEN_ONLY, PROBE_TOKEN_ONLY, creatorOnEitherSide, firstChoice, isOffered, pairAllowed, qBurns, qSymbol, sellsLine, sideChoices, sideFacts, sidePending, sideWords } from './fee-kinds';
import { HOLDERS_PENDING, noteOn, offeredOn, offeredSomewhere, pendingNote, specNetwork } from './spec-network';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/**
 * The flow doc's § 2.2 table as the factory must answer it, written out (never derived from validate or pairAllowed),
 * for ETH, the only listed Q: rows are buyers' values 1-7, columns sellers' values 1-7. ok: allowed; off17 / off18:
 * NOT_OFFERED (holder payouts, S14); menu17: MENU_RULE at qStream (BURN_Q needs a Q with a real burn); menu18: MENU_RULE
 * at tStream (BP-13: SELL_FOR_Q beside BUYBACK_BURN_T); addon18: ADD_ON_REQUIRED (PER_ITEM_STREAM, box 0's stream).
 */
const COLUMNS = [TStream.BURN_T, TStream.PAY_HOLDERS_T, TStream.SELL_FOR_Q, TStream.PER_ITEM_STREAM, TStream.TO_CREATOR, TStream.CREATOR_IN_Q, TStream.HOLDERS_IN_Q];
const MATRIX: readonly (readonly [number, readonly string[]])[] = [
  [QStream.BUYBACK_BURN_T, ['ok', 'off18', 'menu18', 'addon18', 'ok', 'ok', 'off18']],
  [QStream.ALL_TO_FIT, ['ok', 'off18', 'ok', 'addon18', 'ok', 'ok', 'off18']],
  [QStream.BURN_Q, ['menu17', 'off18', 'menu17', 'menu17', 'menu17', 'menu17', 'off18']],
  [QStream.PAY_HOLDERS_Q, ['off17', 'off17', 'off17', 'off17', 'off17', 'off17', 'off17']],
  [QStream.TO_CREATOR, ['ok', 'off18', 'ok', 'addon18', 'ok', 'ok', 'off18']],
  [QStream.CREATOR_IN_T, ['ok', 'off18', 'ok', 'addon18', 'ok', 'ok', 'off18']],
  [QStream.HOLDERS_IN_T, ['off17', 'off17', 'off17', 'off17', 'off17', 'off17', 'off17']],
];
const WORD: Readonly<Record<string, { reason: number; field: number }>> = {
  ok: { reason: Reason.OK, field: 0 },
  off17: { reason: Reason.NOT_OFFERED, field: 17 },
  off18: { reason: Reason.NOT_OFFERED, field: 18 },
  menu17: { reason: Reason.MENU_RULE, field: 17 },
  menu18: { reason: Reason.MENU_RULE, field: 18 },
  addon18: { reason: Reason.ADD_ON_REQUIRED, field: 18 },
};

/** A valid box of either type with this pair (the creator's address named when a side pays the creator). */
function withPair(base: BoxSpecV1, qStream: number, tStream: number): BoxSpecV1 {
  const creator = creatorOnEitherSide(qStream, tStream);
  const recipient = base.marketplaceOwner === ZERO ? DEMO_TOKEN_ONLY.creatorFeeRecipient : base.marketplaceOwner;
  return { ...base, qStream, tStream, creatorFeeRecipient: creator ? recipient : ZERO, creatorBuy: 0n, addOns: base === DEMO_TOKEN_ONLY ? [] : base.addOns };
}

/** A Q with a real burn (FIT itself as the pair asset; not listed in version 2, S12): a test-only version context. */
const FIT_Q: QAsset = Object.freeze({ token: '0x000000000000000000000000000000000000f17e' as Address, decimals: 18, qClass: QClass.FIT, raisePresets: [10n ** 24n] });
const FIT_CONTEXT: VersionContext = Object.freeze({ ...CONTEXT_V2, qList: [FIT_Q] });

const menu = (side: 'buyers' | 'sellers', other: number, network: 'demo' | 'sepolia' | 'mainnet' = 'mainnet') =>
  Object.fromEntries(sideChoices(side, other, undefined, undefined, network).map((choice) => [choice.kind, choice.members.map((member) => `${member.token}${member.converts ? `:${member.converts}` : ''}${member.disabled ? ' (off)' : ''}`)]));

describe('each fee side (§ 2.2)', () => {
  it('buyers’ fees (ETH): You in ETH or KITE (a buy), Holders later, Burn KITE (bought back) or FIT; no Burn ETH for ETH', () => {
    expect(menu('buyers', TStream.BURN_T)).toEqual({ creator: ['Q', 'T:buys'], holders: [], burn: ['T:buys', 'FIT'] });
  });

  it('sellers’ fees (KITE): You in KITE or ETH (a sell), Holders later, Burn KITE or FIT (a sell, off beside buyers’ Burn KITE)', () => {
    expect(menu('sellers', QStream.BUYBACK_BURN_T)).toEqual({ creator: ['T', 'Q:sells'], holders: [], burn: ['T', 'FIT:sells (off)'] });
    expect(menu('sellers', QStream.ALL_TO_FIT)).toEqual({ creator: ['T', 'Q:sells'], holders: [], burn: ['T', 'FIT:sells'] });
    // And the other way round: buyers' Burn KITE is off beside sellers' Burn FIT.
    expect(menu('buyers', TStream.SELL_FOR_Q).burn).toEqual(['T:buys (off)', 'FIT']);
  });

  it('a kind starts on its first choice allowed beside the other side', () => {
    const burn = sideChoices('buyers', TStream.SELL_FOR_Q).find((choice) => choice.kind === 'burn');
    expect(burn && firstChoice(burn)).toBe(QStream.ALL_TO_FIT);
    const you = sideChoices('sellers', QStream.BUYBACK_BURN_T).find((choice) => choice.kind === 'creator');
    expect(you && firstChoice(you)).toBe(TStream.TO_CREATOR);
    const holders = sideChoices('sellers', QStream.BUYBACK_BURN_T).find((choice) => choice.kind === 'holders');
    expect(holders && firstChoice(holders)).toBeNull();
  });

  it('the factory answers every pair as § 2.2 says, for both box types; pairAllowed is that answer', () => {
    for (const [qStream, row] of MATRIX) {
      COLUMNS.forEach((tStream, index) => {
        const word = row[index] ?? 'missing';
        for (const base of [DEMO_TOKEN_ONLY, DEMO_OPEN_ART]) {
          expect(validateBoxSpecV1(withPair(base, qStream, tStream), CONTEXT_V2), `${base.boxType} ${qStream}/${tStream}`).toEqual(WORD[word]);
        }
        expect(pairAllowed(qStream, tStream), `${qStream}/${tStream}`).toBe(word === 'ok');
      });
    }
    // Every member is in the table: a new value must be added here (and to the flow doc) before the page offers it.
    expect(MATRIX.map(([value]) => value).sort()).toEqual(Object.values(QStream).sort());
    expect([...COLUMNS].sort()).toEqual(Object.values(TStream).sort());
  });

  it('a Q with a real burn (FIT): Burn Q is offered, and a sale still says it sells and burns Q, never FIT', () => {
    expect(qBurns(FIT_Q)).toBe(true);
    const menu = (side: 'buyers' | 'sellers', other: number) =>
      Object.fromEntries(sideChoices(side, other, FIT_Q, FIT_CONTEXT).map((choice) => [choice.kind, choice.members.map((member) => `${member.token}${member.converts ? `:${member.converts}` : ''}${member.disabled ? ' (off)' : ''}`)]));
    expect(menu('buyers', TStream.BURN_T).burn).toEqual(['T:buys', 'FIT', 'Q']);
    expect(menu('sellers', QStream.ALL_TO_FIT).burn).toEqual(['T', 'Q:sells']);
    // BP-13 holds for any Q.
    expect(menu('sellers', QStream.BUYBACK_BURN_T).burn).toEqual(['T', 'Q:sells (off)']);
    const q = qSymbol(FIT_Q.token);
    const sale = sideFacts('sellers', TStream.SELL_FOR_Q, qBurns(FIT_Q));
    expect(sale).toEqual({ kind: 'burn', token: 'Q', converts: 'sells', pending: null });
    expect(sideWords(sale, 'KITE', q, true)).toBe(`Burn · ${q}`);
  });

  it('the facts and words a side shows: kind, token, conversion; "Sells KITE for ETH" for a sell', () => {
    expect(sideFacts('buyers', QStream.CREATOR_IN_T)).toEqual({ kind: 'creator', token: 'T', converts: 'buys', pending: null });
    expect(sideFacts('sellers', TStream.CREATOR_IN_Q)).toEqual({ kind: 'creator', token: 'Q', converts: 'sells', pending: null });
    expect(sideFacts('sellers', TStream.SELL_FOR_Q)).toEqual({ kind: 'burn', token: 'FIT', converts: 'sells', pending: null });
    expect(sideFacts('sellers', TStream.SELL_FOR_Q, true)).toEqual({ kind: 'burn', token: 'Q', converts: 'sells', pending: null });
    expect(sideFacts('buyers', QStream.BURN_Q)).toEqual({ kind: 'burn', token: 'Q', converts: null, pending: null });
    // F74 U1: a holder payout carries its note, wherever it is shown.
    expect(sideFacts('buyers', QStream.HOLDERS_IN_T)).toEqual({ kind: 'holders', token: 'T', converts: 'buys', pending: 'Pending legal review' });
    expect(sideFacts('sellers', TStream.HOLDERS_IN_Q)).toEqual({ kind: 'holders', token: 'Q', converts: 'sells', pending: 'Pending legal review' });
    expect(sideWords(sideFacts('buyers', QStream.PAY_HOLDERS_Q), 'KITE', 'ETH')).toBe('Holders · ETH');
    expect(sideFacts('buyers', 99)).toBeNull();
    expect(sideWords(sideFacts('buyers', QStream.TO_CREATOR), 'KITE', 'ETH')).toBe('Creator · ETH');
    expect(sideWords(sideFacts('buyers', QStream.TO_CREATOR), 'KITE', 'ETH', true)).toBe('You · ETH');
    expect(sideWords(sideFacts('sellers', TStream.BURN_T), 'KITE', 'ETH')).toBe('Burn · KITE');
    expect(sideWords(sideFacts('buyers', QStream.ALL_TO_FIT), 'KITE', 'ETH')).toBe('Burn · FIT');
    expect(sellsLine('KITE', 'ETH')).toBe('Sells KITE for ETH');
    expect(qSymbol('0x0000000000000000000000000000000000000000')).toBe('ETH');
  });
});

describe('holder payouts per network (F74 U1)', () => {
  it('the Demo offers Holders on each side, paid in either token, marked "Pending legal review"; Sepolia and mainnet do not', () => {
    expect(menu('buyers', TStream.BURN_T, 'demo')).toEqual({ creator: ['Q', 'T:buys'], holders: ['Q', 'T:buys'], burn: ['T:buys', 'FIT'] });
    expect(menu('sellers', QStream.ALL_TO_FIT, 'demo')).toEqual({ creator: ['T', 'Q:sells'], holders: ['T', 'Q:sells'], burn: ['T', 'FIT:sells'] });
    for (const network of ['sepolia', 'mainnet'] as const) {
      expect(menu('buyers', TStream.BURN_T, network).holders, network).toEqual([]);
      expect(menu('sellers', QStream.ALL_TO_FIT, network).holders, network).toEqual([]);
    }
    const demo = sideChoices('buyers', TStream.BURN_T, undefined, undefined, 'demo');
    expect(demo.map((choice) => [choice.kind, choice.pending])).toEqual([
      ['creator', null],
      ['holders', 'Pending legal review'],
      ['burn', null],
    ]);
    // On a chain source the kind is shown off with no note (its reason is "Demo only").
    expect(sideChoices('buyers', TStream.BURN_T, undefined, undefined, 'sepolia').find((choice) => choice.kind === 'holders')).toEqual({ kind: 'holders', members: [], pending: null });
    // Sepolia: only what core v1 builds (no conversion, no sell).
    expect(menu('buyers', TStream.BURN_T, 'sepolia')).toEqual({ creator: ['Q'], holders: [], burn: ['T:buys', 'FIT'] });
    expect(menu('sellers', QStream.ALL_TO_FIT, 'sepolia')).toEqual({ creator: ['T'], holders: [], burn: ['T'] });
  });

  it('a value’s words on a network: its pending note where it is offered early, "Not offered here yet" (no Demo word, F130) or "Not on testnet yet" where it is not', () => {
    expect(noteOn('qStream', 'QStream', QStream.PAY_HOLDERS_Q, 'demo')).toBe('Pending legal review');
    expect(noteOn('qStream', 'QStream', QStream.PAY_HOLDERS_Q, 'sepolia')).toBe('Not offered here yet');
    expect(noteOn('tStream', 'TStream', TStream.HOLDERS_IN_Q, 'mainnet')).toBe('Not offered here yet');
    expect(noteOn('addOns.creator-fee-cap.excess', 'CapExcess', 1, 'sepolia')).toBe('Not offered here yet');
    expect(noteOn('addOns.creator-fee-cap.excess', 'CapExcess', 1, 'demo')).toBe('Pending legal review');
    expect(noteOn('qStream', 'QStream', QStream.CREATOR_IN_T, 'sepolia')).toBe('Not on testnet yet');
    expect(noteOn('tStream', 'TStream', TStream.SELL_FOR_Q, 'sepolia')).toBe('Not on testnet yet');
    for (const network of NETWORKS) expect(noteOn('qStream', 'QStream', QStream.TO_CREATOR, network), network).toBeNull();
    expect(noteOn('qStream', 'QStream', QStream.CREATOR_IN_T, 'mainnet')).toBeNull();
  });

  it('the factory’s check on each network: what mainnet refuses as NOT_OFFERED only for a holder payout, the Demo accepts unless another rule refuses it; Sepolia also leaves out what core v1 does not build', () => {
    // Core v1's receiver builds these for other boxes (BoxReceiver.initialize; BUYBACK_BURN_T kept on Sepolia: box 0
    // builds it and it is the default, an open item for S7; PER_ITEM_STREAM since box 0's own review W3-U9-3: S8 built
    // the stream and Sepolia's box 0 runs it). Written out, not read from OFFERED_ON.
    const SEPOLIA_Q: readonly number[] = [QStream.BUYBACK_BURN_T, QStream.ALL_TO_FIT, QStream.TO_CREATOR];
    const SEPOLIA_T: readonly number[] = [TStream.BURN_T, TStream.PER_ITEM_STREAM, TStream.TO_CREATOR];
    for (const [qStream, row] of MATRIX) {
      COLUMNS.forEach((tStream, index) => {
        const word = row[index] ?? 'missing';
        const spec = withPair(DEMO_TOKEN_ONLY, qStream, tStream);
        expect(validateBoxSpecV1(spec, CONTEXT_V2, 'mainnet'), `mainnet ${qStream}/${tStream}`).toEqual(WORD[word]);
        const sepolia = !SEPOLIA_Q.includes(qStream) ? WORD.off17 : !SEPOLIA_T.includes(tStream) ? WORD.off18 : WORD[word];
        expect(validateBoxSpecV1(spec, CONTEXT_V2, 'sepolia'), `sepolia ${qStream}/${tStream}`).toEqual(sepolia);
        const demo = validateBoxSpecV1(spec, CONTEXT_V2, 'demo');
        if (word === 'ok') expect(demo, `demo ${qStream}/${tStream}`).toEqual(WORD.ok);
        else expect(demo.reason, `demo ${qStream}/${tStream}`).not.toBe(Reason.NOT_OFFERED);
        expect(pairAllowed(qStream, tStream, undefined, undefined, 'demo')).toBe(demo.reason === Reason.OK);
      });
    }
    // Every holder pair the Demo accepts carries a holder payout; mainnet never offers one.
    for (const value of [QStream.PAY_HOLDERS_Q, QStream.HOLDERS_IN_T]) {
      expect([isOffered('buyers', value, 'demo'), isOffered('buyers', value, 'sepolia'), isOffered('buyers', value)]).toEqual([true, false, false]);
      expect(sidePending('buyers', value)).toBe('Pending legal review');
    }
    for (const value of [TStream.PAY_HOLDERS_T, TStream.HOLDERS_IN_Q]) {
      expect([isOffered('sellers', value, 'demo'), isOffered('sellers', value, 'sepolia'), isOffered('sellers', value)]).toEqual([true, false, false]);
    }
    expect(sidePending('buyers', QStream.TO_CREATOR)).toBeNull();
  });

  it('a source’s network: the Demo; Sepolia’s rules on Sepolia and the local chain; the strictest anywhere else, never a holder payout on mainnet', () => {
    expect(specNetwork({ isDemo: true, chainId: 31_337 })).toBe('demo');
    expect(specNetwork({ isDemo: false, chainId: 31_337 })).toBe('sepolia');
    expect(specNetwork({ isDemo: false, chainId: 11_155_111 })).toBe('sepolia');
    expect(specNetwork({ isDemo: false, chainId: 1 })).toBe('mainnet');
    expect(specNetwork({ isDemo: false, chainId: 8453 })).toBe('mainnet');
    expect(NETWORKS).toEqual(['demo', 'sepolia', 'mainnet']);
    // The cap's excess follows the sides (holders: the Demo only).
    expect([1, 2, 3].map((excess) => NETWORKS.map((network) => offeredOn('addOns.creator-fee-cap.excess', excess, network)))).toEqual([
      [true, false, false],
      [true, true, true],
      [true, true, true],
    ]);
    expect([offeredSomewhere('qStream', QStream.HOLDERS_IN_T), offeredSomewhere('qStream', 8)]).toEqual([true, false]);
    expect(pendingNote('CapExcess', 1)).toBe('Pending legal review');
    expect(pendingNote('CapExcess', 2)).toBeNull();
    expect(HOLDERS_PENDING).toBe('Pending legal review');
  });
});

/**
 * SH-V2-FE6: the production site ships no Demo fixture, so its fee check probes with a neutral token-only box. It must
 * answer every pair on every network and for every listed Q exactly as the Demo fixture does.
 */
describe('the production probe (no Demo fixture)', () => {
  it('answers every pair, network and Q as the Demo fixture does; the Demo build keeps the fixture', () => {
    expect(PROBE_TOKEN_ONLY).toBe(DEMO_TOKEN_ONLY);
    expect(JSON.stringify(NEUTRAL_TOKEN_ONLY, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/demo|0xde0/i);
    let compared = 0;
    for (const qStream of Object.values(QStream)) {
      for (const tStream of Object.values(TStream)) {
        for (const network of NETWORKS) {
          for (const asset of CONTEXT_V2.qList) {
            expect(pairAllowed(qStream, tStream, asset, CONTEXT_V2, network, NEUTRAL_TOKEN_ONLY), `${qStream}/${tStream} ${network} ${asset.token}`).toBe(pairAllowed(qStream, tStream, asset, CONTEXT_V2, network, DEMO_TOKEN_ONLY));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  });
});
