// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { X_HANDLE } from './alpha-api';
import { SETUP_HINT_ITEM, SETUP_HINT_KEY, readSetupHint, writeSetupHint } from './setup-hint';
import { appCopyFraming, unnegatedReturnFraming } from '../legal/wording';

/** A storage double: what was written, and a refusal on demand. */
function storage(initial: Record<string, string> = {}, refuse = false) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => { if (refuse) throw new Error('blocked'); return items.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (refuse) throw new Error('blocked'); items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

const ID = '0b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60';

/** F166 (SH-ALPHA-ONBOARDING): this device's hint of how far "Set me up" got, for one X account; a hint only. */
describe('the setup’s hint on this device (F166)', () => {
  it('keeps one account’s state, and the claim its setup made, and gives them back for that account only', () => {
    const store = storage();
    writeSetupHint({ handle: 'Tester_1', state: 'started' }, store);
    expect(JSON.parse(store.items.get(SETUP_HINT_KEY) ?? '')).toEqual({ handle: 'Tester_1', state: 'started', claimId: null });
    expect(readSetupHint('tester_1', store)).toEqual({ state: 'started', claimId: null });
    expect(readSetupHint('someone_else', store)).toBeNull();
    writeSetupHint({ handle: 'Tester_1', state: 'started', claimId: ID }, store);
    expect(readSetupHint('Tester_1', store)).toEqual({ state: 'started', claimId: ID });
    for (const state of ['done', 'ended', 'manual'] as const) {
      writeSetupHint({ handle: 'Tester_1', state }, store);
      expect(readSetupHint('Tester_1', store)).toEqual({ state, claimId: null });
    }
    // The hint before af1 (no claim): read as one with no claim.
    expect(readSetupHint('tester', storage({ [SETUP_HINT_KEY]: '{"handle":"tester","state":"started"}' }))).toEqual({ state: 'started', claimId: null });
  });

  it('is never trusted as more than it is: none, unreadable, malformed or of another form reads as none', () => {
    for (const raw of ['', 'not json', 'null', '[]', '{"handle":"tester"}', '{"handle":"tester","state":"finished"}', '{"handle":"has space","state":"done"}', '{"handle":"waytoolonghandle1","state":"done"}',
      '{"handle":"tester","state":"started","claimId":"not-a-claim"}', '{"handle":"tester","state":"started","claimId":7}']) {
      expect(readSetupHint('tester', storage({ [SETUP_HINT_KEY]: raw })), raw).toBeNull();
    }
    expect(readSetupHint('tester', storage({}, true))).toBeNull();
    expect(readSetupHint('tester', null)).toBeNull();
    // A refused write keeps nothing and throws nothing; a hint of another form is not written.
    expect(() => writeSetupHint({ handle: 'tester', state: 'done' }, storage({}, true))).not.toThrow();
    const store = storage();
    writeSetupHint({ handle: 'not a handle', state: 'done' }, store);
    writeSetupHint({ handle: 'tester', state: 'finished' as never }, store);
    writeSetupHint({ handle: 'tester', state: 'started', claimId: 'not-a-claim' }, store);
    expect(store.items.size).toBe(0);
  });

  it('holds X’s handle rule as alpha-api.ts does', () => {
    for (const handle of ['a', 'ada_builds', 'A1_b2_C3_d4_E5f', 'x'.repeat(15)]) {
      const store = storage();
      writeSetupHint({ handle, state: 'done' }, store);
      expect(readSetupHint(handle, store)?.state ?? null, handle).toBe(X_HANDLE.test(handle) ? 'done' : null);
    }
    for (const handle of ['', 'x'.repeat(16), 'dash-ed', 'émile']) {
      const store = storage();
      writeSetupHint({ handle, state: 'done' }, store);
      expect(store.items.size, handle).toBe(X_HANDLE.test(handle) ? 1 : 0);
    }
  });

  it('is listed for the privacy notice by its key, in this file, in plain words', () => {
    expect(SETUP_HINT_ITEM).toMatchObject({ key: 'sh.alpha.setup.v1', store: 'localStorage', source: 'apps/web/src/features/alpha-sepolia/setup-hint.ts' });
    expect(SETUP_HINT_ITEM.writer).toBeUndefined();
    expect(unnegatedReturnFraming([SETUP_HINT_ITEM.what])).toEqual([]);
    expect(appCopyFraming([SETUP_HINT_ITEM.what])).toEqual([]);
  });
});
