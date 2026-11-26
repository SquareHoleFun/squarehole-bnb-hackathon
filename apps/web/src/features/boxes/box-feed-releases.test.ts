// @vitest-environment node
/**
 * SH-300: v2 boxes of two releases in the feed's "New" order. Every v2 record has `order` 0, so the indexer's order
 * stood; with two releases it can list one release after the other. Where the deployment lists two releases, the New
 * order keeps v2 boxes in creation order; with one release every sort returns exactly what it returned before.
 */
import { describe, expect, it } from 'vitest';
import { sortSummaries } from './box-feed';
import type { BoxSort } from './box-feed-params';
import type { BoxSummary } from './box-model';

const manifest = (releases: number) => ({ releases: Array.from({ length: releases }, () => ({})) });
const v2 = (name: string, creationBlock: bigint, releases: number, token = `0x${name.padStart(40, '0').slice(-40).replace(/[^0-9a-f]/gi, '0')}`): BoxSummary => ({
  state: 'graduated', progressBps: null, mcapRaw: 1n, volumeRaw: 1n,
  record: { name, token, featured: false, order: 0, pairAsset: 'BNB', chainId: 97, v2Chain: { source: { manifest: manifest(releases) }, snapshot: { record: { creationBlock, q: '0x0000000000000000000000000000000000000000' } } } },
}) as never;
const other = (name: string, order: number, token = '0x0000000000000000000000000000000000000000', chainId = 97): BoxSummary => ({ state: 'graduated', mcapRaw: 1n, volumeRaw: 1n, record: { name, token, featured: false, order, pairAsset: 'BNB', chainId } }) as never;
const names = (list: readonly BoxSummary[]) => list.map((s) => s.record.name);
const SORTS: readonly BoxSort[] = ['new', 'progress', 'mcap', 'volume'];

describe('one release: every sort as before', () => {
  // Before SH-300 the comparator's last key was `order`, so tied boxes kept the feed's (input) order in every sort.
  it('the input order stands for tied boxes in every sort, whatever their creation blocks', () => {
    const feed = [v2('c', 300n, 1), v2('a', 100n, 1), v2('b', 200n, 1)];
    for (const sort of SORTS) expect(names(sortSummaries(feed, sort)), sort).toEqual(['c', 'a', 'b']);
  });
  it('records with an order keep theirs', () => {
    expect(names(sortSummaries([v2('a', 5n, 1), other('ordered', 3), v2('b', 1n, 1)], 'new'))).toEqual(['ordered', 'a', 'b']);
  });
});

describe('two releases: the New order by creation block, the other sorts as before', () => {
  it('v2 boxes by creation block, whichever release the indexer listed first', () => {
    const feed = [v2('first release, old', 100n, 2), v2('first release, new', 300n, 2), v2('second release', 200n, 2)];
    expect(names(sortSummaries(feed, 'new'))).toEqual(['first release, old', 'second release', 'first release, new']);
    for (const sort of ['progress', 'mcap', 'volume'] as const) expect(names(sortSummaries(feed, sort)), sort).toEqual(['first release, old', 'first release, new', 'second release']);
  });
  it('a record with an order keeps its place before them; equal blocks by token address', () => {
    const b = v2('b', 5n, 2, '0x00000000000000000000000000000000000000b2');
    const a = v2('a', 5n, 2, '0x00000000000000000000000000000000000000a1');
    expect(names(sortSummaries([b, other('ordered', 3), a], 'new'))).toEqual(['ordered', 'a', 'b']);
  });
  it('a box without a creation block: after the v2 boxes, the v2 boxes still in creation order ([300, none, 100])', () => {
    expect(names(sortSummaries([v2('300', 300n, 2), other('none', 0), v2('100', 100n, 2)], 'new'))).toEqual(['100', '300', 'none']);
  });
  it('the order is total: every arrangement of one list sorts the same (same block, no block, two chains)', () => {
    const list = [
      v2('a7', 7n, 2, '0x00000000000000000000000000000000000000a1'),
      v2('b7', 7n, 2, '0x00000000000000000000000000000000000000B2'),
      v2('c5', 5n, 2, '0x00000000000000000000000000000000000000c3'),
      other('none d', 0, '0x00000000000000000000000000000000000000d4'),
      other('none e', 0, '0x00000000000000000000000000000000000000e5'),
      other('none e, chain 56', 0, '0x00000000000000000000000000000000000000e5', 56),
    ];
    const want = ['c5', 'a7', 'b7', 'none e, chain 56', 'none d', 'none e'];
    const perms = (xs: readonly BoxSummary[]): BoxSummary[][] => xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    for (const p of perms(list)) expect(names(sortSummaries(p, 'new'))).toEqual(want);
  });
  it('decided once for the list: one two-release box puts every box in the list in creation order', () => {
    // Two one-release boxes out of order and a two-release box after them: a comparator that decided per pair would
    // leave 9 before 3 (that pair has no two-release box) and return the feed's order.
    const list = [v2('one release, 9', 9n, 1), v2('one release, 3', 3n, 1), v2('two releases, 12', 12n, 2)];
    expect(names(sortSummaries(list, 'new'))).toEqual(['one release, 3', 'one release, 9', 'two releases, 12']);
  });
});
