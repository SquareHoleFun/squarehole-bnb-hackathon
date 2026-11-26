/**
 * SH-SITE-FIXES-10: what a box link may say while its box is not among the source's boxes (box-sources.ts lookupOf):
 * nothing while any part of the source has not answered, unavailable while a part could not be read at all, and "not
 * found" only once every part answered.
 */
import { describe, expect, it } from 'vitest';
import { lookupOf, type CoreSourcesState, type LookupPart } from './box-sources';

const READY: CoreSourcesState = { status: 'ready', via: 'indexer', summaries: new Map(), dropped: 0 };
const LOADING: CoreSourcesState = { status: 'loading' };
const FAILED: CoreSourcesState = { status: 'error', reason: 'The indexer did not answer: no answer within 8 s' };
const NONE: CoreSourcesState = { status: 'none', reason: 'No core deployment.' };
const part = (patch: Partial<LookupPart>): LookupPart => ({ loading: false, answered: true, error: null, ...patch });

describe('lookupOf', () => {
  it('the ship 9 case: core v1 answered, v2 not yet: loading, never "not found"', () => {
    expect(lookupOf(READY, part({ loading: true, answered: false }))).toEqual({ status: 'loading' });
  });
  it('v2 could not be read at all (no answer kept): unreachable with its reason, whatever v1 said', () => {
    expect(lookupOf(READY, part({ answered: false, error: 'V2 data unavailable' }))).toEqual({ status: 'unreachable', reason: 'V2 data unavailable' });
    expect(lookupOf(NONE, part({ answered: false, error: 'V2 data unavailable' }))).toEqual({ status: 'unreachable', reason: 'V2 data unavailable' });
  });
  it('a failed refresh after an answer keeps the answer: a box not in it is not there', () => {
    expect(lookupOf(READY, part({ answered: true, error: 'V2 data unavailable' }))).toEqual({ status: 'answered' });
  });
  it('core v1 still loading, or unreadable (the indexer and the chain): loading, or unreachable', () => {
    expect(lookupOf(LOADING, part({}))).toEqual({ status: 'loading' });
    expect(lookupOf(FAILED, part({}))).toEqual({ status: 'unreachable', reason: FAILED.status === 'error' ? FAILED.reason : '' });
  });
  it('loading wins over unreachable: a part still reading may hold the box', () => {
    expect(lookupOf(FAILED, part({ loading: true, answered: false }))).toEqual({ status: 'loading' });
    expect(lookupOf(READY, part({ answered: false, error: 'V2 data unavailable' }), part({ loading: true, answered: false }))).toEqual({ status: 'loading' });
  });
  it('the add-on counts like v2; every part answered: answered', () => {
    expect(lookupOf(READY, part({}), part({ answered: false, error: 'The add-on’s boxes could not be read.' }))).toEqual({ status: 'unreachable', reason: 'The add-on’s boxes could not be read.' });
    expect(lookupOf(READY, part({}), part({}))).toEqual({ status: 'answered' });
    expect(lookupOf(READY)).toEqual({ status: 'answered' });
    expect(lookupOf(NONE)).toEqual({ status: 'answered' });
  });
});
