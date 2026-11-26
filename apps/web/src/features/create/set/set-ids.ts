/**
 * SH-EXISTING-NFTS-E08C: the pasted ids of a set, in the order typed (the order the set hash commits).
 *
 * The same text the shop's starter ids take (SH-SHOP-CREATE): decimal ids and ranges "5-9" (low end first), in comma
 * groups, each holding ids separated by spaces or new lines ("1, 2, 5-9" or one id per line). Every id is a full
 * uint256 written canonically (0 is an id; no leading zeros, signs, exponents or hex), and a set holds 10 to 10,000
 * distinct ids. Ids are bigint from the first character: nothing passes through Number.
 */
import { SET_MAX_COUNT, SET_MIN_COUNT } from '@squarehole/box-spec';
import { formatCount } from '../../fit-pair/fit-format';

const MAX_UINT256 = (1n << 256n) - 1n;
const ID_TEXT = /^(0|[1-9][0-9]{0,77})$/;

export type SetIdsProblem =
  | { readonly kind: 'empty' }
  | { readonly kind: 'format'; readonly part: string }
  | { readonly kind: 'few'; readonly count: number }
  | { readonly kind: 'many' }
  | { readonly kind: 'duplicate'; readonly id: bigint };

export type SetIdsParse = { readonly ok: true; readonly ids: readonly bigint[] } | { readonly ok: false; readonly problem: SetIdsProblem };

const id = (part: string): bigint | null => {
  if (!ID_TEXT.test(part)) return null;
  const value = BigInt(part);
  return value <= MAX_UINT256 ? value : null;
};

let last: { readonly text: string; readonly parsed: SetIdsParse } | null = null;

/** The ids the text names, in typed order, or the first problem with it. Rebuilt only when the text changes. */
export function parseSetIds(text: string): SetIdsParse {
  if (last?.text === text) return last.parsed;
  const parsed = parse(text);
  last = { text, parsed };
  return parsed;
}

function parse(text: string): SetIdsParse {
  if (text.trim() === '') return { ok: false, problem: { kind: 'empty' } };
  const groups = text.split(',');
  const blank = groups.find((group) => group.trim() === '');
  if (blank !== undefined) return { ok: false, problem: { kind: 'format', part: ',' } };
  const parts = groups.flatMap((group) => group.replace(/\s*-\s*/g, '-').trim().split(/\s+/));
  const ids: bigint[] = [];
  const seen = new Set<bigint>();
  for (const part of parts) {
    const range = /^([^-]+)-([^-]+)$/.exec(part);
    const low = id(range ? range[1] ?? '' : part);
    const high = range ? id(range[2] ?? '') : low;
    if (low === null || high === null || high < low) return { ok: false, problem: { kind: 'format', part } };
    if (BigInt(ids.length) + (high - low) + 1n > BigInt(SET_MAX_COUNT)) return { ok: false, problem: { kind: 'many' } };
    for (let value = low; value <= high; value += 1n) {
      if (seen.has(value)) return { ok: false, problem: { kind: 'duplicate', id: value } };
      seen.add(value);
      ids.push(value);
    }
  }
  if (ids.length < SET_MIN_COUNT) return { ok: false, problem: { kind: 'few', count: ids.length } };
  return { ok: true, ids: Object.freeze(ids) };
}

/** The problem in the page's words (one short line). */
export function idsProblemText(problem: SetIdsProblem): string {
  switch (problem.kind) {
    case 'empty': return 'Paste the ids';
    case 'format': return problem.part === ',' ? 'An empty group between commas' : `Not an id: ${problem.part.length > 24 ? `${problem.part.slice(0, 24)}…` : problem.part}`;
    case 'few': return `At least ${SET_MIN_COUNT} ids · ${problem.count} now`;
    case 'many': return `At most ${formatCount(BigInt(SET_MAX_COUNT))} ids`;
    case 'duplicate': return `#${problem.id.toString()} is listed twice`;
  }
}
