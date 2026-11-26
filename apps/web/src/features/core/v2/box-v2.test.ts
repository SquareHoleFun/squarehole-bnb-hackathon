/**
 * The v2 box page's model (M1-53-b; F99, F100, F103, F104): when "Close box" is offered and which entry it sends, the
 * closing price in the box's own pricing token (bigint only), and when the token card may say "clone, not upgradeable".
 */
import { describe, expect, it } from 'vitest';
import { closeStateOf, closingPricePerMillion, implementationHref, tokenFormOf, type BoxV2Facts } from './box-v2';

const DAY = 86_400n;
const T0 = 1_790_000_000n;
const IMPL = '0x00000000000000000000000000000000000c10e1' as const;

const open: BoxV2Facts = {
  network: 'sepolia',
  coordinator: '0x00000000000000000000000000000000000c00d1',
  pricing: { symbol: 'ETH', decimals: 18, address: null },
  openAt: T0,
  gateOpen: true,
  effectiveOpenAt: T0,
  deadline: T0 + 30n * DAY,
  curve: 'open',
  failure: null,
  tipMaxQ: 10n ** 15n,
  tImplementation: IMPL,
  releaseTImplementation: IMPL,
};
const gated: BoxV2Facts = { ...open, gateOpen: false, effectiveOpenAt: 0n, deadline: 0n };

describe('closeStateOf: "Close box" only once the box can be closed (F99; IBoxCoordinatorV2 fail, failClosed)', () => {
  it('an open curve: from its deadline, by fail()', () => {
    expect(closeStateOf(open, open.deadline - 1n)).toEqual({ kind: 'waiting', from: open.deadline });
    expect(closeStateOf(open, open.deadline)).toEqual({ kind: 'closable', call: 'fail', since: open.deadline });
    expect(closeStateOf(open, open.deadline + 5n * DAY)).toEqual({ kind: 'closable', call: 'fail', since: open.deadline });
  });

  it('a gate still holding: from openAt + 14 days, by failClosed(); its deadline of 0 is no deadline', () => {
    const cap = T0 + 14n * DAY;
    expect(closeStateOf(gated, T0)).toEqual({ kind: 'waiting', from: cap });
    expect(closeStateOf(gated, cap - 1n)).toEqual({ kind: 'waiting', from: cap });
    expect(closeStateOf(gated, cap)).toEqual({ kind: 'closable', call: 'failClosed', since: cap });
    expect(closeStateOf(gated, cap + 40n * DAY)).toEqual({ kind: 'closable', call: 'failClosed', since: cap });
  });

  it('CQ11-E4: a filled curve closes exactly seven days after its first fill, never after graduation', () => {
    const filled = { ...open, curve: 'filled' as const, closedAt: T0 };
    expect(closeStateOf(filled, T0 + 7n * DAY - 1n)).toEqual({ kind: 'waiting', from: T0 + 7n * DAY });
    expect(closeStateOf(filled, T0 + 7n * DAY)).toEqual({ kind: 'closable', call: 'fail', since: T0 + 7n * DAY });
    expect(closeStateOf({ ...open, curve: 'filled' }, open.deadline + DAY)).toEqual({ kind: 'cannot' });
    expect(closeStateOf({ ...open, curve: 'graduated' }, open.deadline + DAY)).toEqual({ kind: 'cannot' });
  });

  it('a closed box is closed, whatever the clock says', () => {
    const closing = { pInRange: 5n, tOutstanding: 7n, tip: 1n };
    const closed: BoxV2Facts = { ...open, failure: { cause: 'deadline', at: open.deadline + 9n, closing } };
    expect(closeStateOf(closed, 0n)).toEqual({ kind: 'closed', cause: 'deadline', at: open.deadline + 9n, closing });
  });
});

describe('closingPricePerMillion: P per 1M tokens, from the closing range (bigint, 5 significant digits, truncated)', () => {
  it('in ETH (18 decimals)', () => {
    // 1.7248 ETH over 410M tokens: 0.0042068292… ETH per 1M.
    expect(closingPricePerMillion({ pInRange: 1_724_800_000_000_000_000n, tOutstanding: 410_000_000n * 10n ** 18n, tip: 0n }, 18)).toBe('0.0042068');
  });

  it('in USDC (6 decimals), never through a JS number', () => {
    // 8,412.5 USDC over 612,345,678.9 tokens: 13.738155… USDC per 1M.
    expect(closingPricePerMillion({ pInRange: 8_412_500_000n, tOutstanding: 6_123_456_789n * 10n ** 17n, tip: 0n }, 6)).toBe('13.738');
  });

  it('thousands keep every whole digit with separators; nothing left to pay is null, an empty pool 0', () => {
    expect(closingPricePerMillion({ pInRange: 2_500_000n * 10n ** 18n, tOutstanding: 1_000_000n * 10n ** 18n, tip: 0n }, 18)).toBe('2,500,000');
    expect(closingPricePerMillion({ pInRange: 1n, tOutstanding: 0n, tip: 0n }, 18)).toBeNull();
    expect(closingPricePerMillion({ pInRange: 0n, tOutstanding: 10n ** 18n, tip: 0n }, 18)).toBe('0');
  });

  it('a broken answer is null, never a wrong price or a throw: a negative pool, decimals outside 0-36', () => {
    const closing = { pInRange: 8_412_500_000n, tOutstanding: 6_123_456_789n * 10n ** 17n, tip: 0n };
    expect(closingPricePerMillion({ ...closing, pInRange: -8_412_500_000n }, 6)).toBeNull();
    for (const decimals of [-1, 37, 1.5, Number.NaN]) expect(closingPricePerMillion(closing, decimals), String(decimals)).toBeNull();
    expect(closingPricePerMillion(closing, 0)).toBe('13,738,155');
    expect(closingPricePerMillion(closing, 36)).toBe(`0.${'0'.repeat(28)}13738`);
  });
});

describe('tokenFormOf and implementationHref: "clone, not upgradeable" only for the release’s T implementation (F103)', () => {
  it('the indexer’s implementation equal to the release’s (any case): a clone, linked on Sepolia to the code tab', () => {
    expect(tokenFormOf({ ...open, tImplementation: IMPL.toUpperCase().replace('0X', '0x') as `0x${string}` })).toEqual({ kind: 'clone', implementation: IMPL.toUpperCase().replace('0X', '0x') });
    expect(implementationHref(open)).toBe(`https://sepolia.etherscan.io/address/${IMPL}#code`);
  });

  it('another implementation, or one not read, is never called a clone of the release', () => {
    expect(tokenFormOf({ ...open, tImplementation: '0x00000000000000000000000000000000000bad01' })).toEqual({ kind: 'unchecked' });
    expect(tokenFormOf({ ...open, tImplementation: null })).toEqual({ kind: 'unchecked' });
    expect(tokenFormOf({ ...open, releaseTImplementation: null })).toEqual({ kind: 'unchecked' });
  });

  it('no link off Sepolia: the Demo and a local chain have no public explorer', () => {
    expect(implementationHref({ ...open, network: 'demo' })).toBeNull();
    expect(implementationHref({ ...open, network: 'local' })).toBeNull();
    expect(implementationHref({ ...open, tImplementation: '0x00000000000000000000000000000000000bad01' })).toBeNull();
  });
});
