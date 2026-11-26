import { describe, expect, it } from 'vitest';
import { zeroHash } from 'viem';
import { buildSetCommitment, verifySetPages, SetReason } from '../../src/set-v2/index';

const collection = '0x1111111111111111111111111111111111111111' as const;
const ids = Array.from({ length: 33 }, (_, i) => BigInt(i));
ids[32] = (1n << 256n) - 1n;
const build = () => buildSetCommitment(collection, ids);

describe('SET-02 / ADMIT-04 commitments', () => {
  it.each([9, 10, 10000, 10001])('count %s', (count) => {
    const members = Array.from({ length: count }, (_, i) => BigInt(i));
    if (count < 10 || count > 10000) expect(() => buildSetCommitment(collection, members)).toThrow();
    else {
      const { commitment, pages } = buildSetCommitment(collection, members);
      expect(verifySetPages(commitment, pages)).toEqual({ reason: 0, field: 0 });
      expect(pages).toHaveLength(Math.ceil(count / 32));
    }
  });
  it('accepts zero and max uint256; preserves order and zero tiers through 32+1 pages', () => {
    const { commitment, pages } = build();
    expect(pages.map((p) => p.ids.length)).toEqual([32, 1]);
    expect(pages.flatMap((p) => p.ids)).toEqual(ids);
    expect(pages.flatMap((p) => p.tiers).every((x) => x === 0)).toBe(true);
    expect(pages.at(-1)?.nextHash).toBe(zeroHash);
    expect(verifySetPages(commitment, pages)).toEqual({ reason: 0, field: 0 });
  });
  it.each(['order', 'hash', 'count', 'tier', 'collection', 'short', 'extra', 'terminal', 'oversize', 'empty'] as const)(
    'refuses %s', (caseName) => {
      const { commitment, pages } = build();
      const first = pages[0];
      const last = pages[1];
      if (!first || !last) throw new Error('fixture');
      switch (caseName) {
        case 'order': [first.ids[0], first.ids[1]] = [1n, 0n]; break;
        case 'hash': commitment.setHash = zeroHash; break;
        case 'count': commitment.count = 32; break;
        case 'tier': first.tiers[0] = 1; break;
        case 'collection': first.collections[0] = '0x2222222222222222222222222222222222222222'; break;
        case 'short': pages.pop(); break;
        case 'extra': pages.push(last); break;
        case 'terminal': last.nextHash = commitment.setHash; break;
        case 'oversize': first.ids.push(99n); break;
        case 'empty': pages.length = 0; break;
      }
      expect(verifySetPages(commitment, pages).reason).not.toBe(0);
    },
  );
  it.each([1, 32])('refuses a duplicate across offset %s even when the attacker recomputes the hash', (offset) => {
    const members = [...ids];
    members[offset] = 0n;
    expect(() => buildSetCommitment(collection, members)).toThrow(/34/);
  });
  it('refuses invalid ids and unsafe numeric JSON ids', () => {
    for (const id of [-1n, 1n << 256n, 9007199254740992, '1e3', '01']) {
      expect(() => buildSetCommitment(collection, [id, ...ids.slice(1)])).toThrow();
    }
    expect(buildSetCommitment(collection, ids.map(String))).toEqual(build());
    expect(SetReason.DUPLICATE_ID).toBe(34);
  });
  it('refuses nonzero collection and page limits outside 1..32', () => {
    for (const pageSize of [0, 33, 1.5]) expect(() => buildSetCommitment(collection, ids, pageSize)).toThrow();
    expect(verifySetPages(build().commitment, buildSetCommitment(collection, ids, 1).pages).reason).toBe(0);
  });
});
