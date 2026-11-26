import { authorizeRevealTestTarget } from './reveal-test-seam.test-support';
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readRevealProgress, revealProgressKey, saveRevealIntent, webRevealLock, type RevealIntent } from './reveal-items-store';
import { addr, digest } from './reveal-items.test-support';

describe('SH202 durable public journal', () => {
  it('round trips decimal amounts and never retains calldata or a batch cursor', async () => {
    let text: string | null = null;
    const store = { get: async () => text, put: async (_key: string, value: string) => { text = value; } }; authorizeRevealTestTarget(store);
    const key = revealProgressKey(11155111, addr(2));
    const progress = await readRevealProgress(store, key, digest(1));
    const intent: RevealIntent = { attempt: 'attempt', ids: ['1', '2'], account: addr(50), nonce: '9007199254740994', createdAt: 0,
      capWei: '1000000000000000000000', status: 'intent' };
    const next = await saveRevealIntent(store, key, progress, intent);
    expect(await readRevealProgress(store, key, digest(1))).toEqual(next);
    expect(text).not.toMatch(/calldata|salt|proof|batchIndex/);
  });
  it.each(['bad-json', 'wrong-spec', 'negative-nonce', 'repeated-id', 'descending-id', 'missing-hash', 'duplicate-attempt'])('refuses corrupted progress: %s', async kind => {
    const intent = { attempt: 'a', ids: ['1', '2'], account: addr(50), nonce: '0', createdAt: 0, capWei: '10', status: 'intent' };
    const progress = { version: 1, specHash: digest(1), intents: [intent] };
    if (kind === 'wrong-spec') progress.specHash = digest(2);
    if (kind === 'negative-nonce') intent.nonce = '-1';
    if (kind === 'repeated-id') intent.ids = ['1', '1'];
    if (kind === 'descending-id') intent.ids = ['2', '1'];
    if (kind === 'missing-hash') intent.status = 'submitted';
    if (kind === 'duplicate-attempt') progress.intents.push({ ...intent });
    const store = { get: async () => kind === 'bad-json' ? '{' : JSON.stringify(progress), put: async () => {} }; authorizeRevealTestTarget(store);
    await expect(readRevealProgress(store, 'key', digest(1))).rejects.toThrow();
  });
  it('Web Locks uses exclusive ifAvailable and waits for the work promise before release', async () => {
    const calls: unknown[] = []; let held = false;
    const request = async (key: string, options: LockOptions, callback: (lock: Lock | null) => Promise<unknown>) => {
      calls.push([key, options]);
      if (held) return callback(null);
      held = true;
      try { return await callback({ name: key, mode: 'exclusive' }); } finally { held = false; }
    };
    const lock = webRevealLock({ request } as Pick<LockManager, 'request'>);
    if (!lock) throw new Error();
    await lock.run('box', async () => {
      expect(held).toBe(true); expect(await lock.run('box', async () => 2)).toEqual({ acquired: false });
    });
    expect(held).toBe(false); expect(calls[0]).toEqual(['box', { mode: 'exclusive', ifAvailable: true }]);
    expect(await lock.run('box', async () => 3)).toEqual({ acquired: true, value: 3 });
  });
});


describe('af1 strict journal', () => {
  const intent: RevealIntent = { attempt: 'a', ids: ['1', '2'], account: addr(50), nonce: '0', capWei: '100', createdAt: 0, status: 'intent' };
  it('L1 strips unknown fields on read and write', async () => {
    let text = JSON.stringify({ version: 1, specHash: digest(1), salt: 'secret', intents: [{ ...intent, calldata: 'secret' }] });
    const store = { get: async () => text, put: async (_key: string, value: string) => { text = value; } }; authorizeRevealTestTarget(store);
    const p = await readRevealProgress(store, 'key', digest(1));
    expect(JSON.stringify(p)).not.toContain('secret');
    await saveRevealIntent(store, 'key', p, { ...intent, salt: 'secret' } as RevealIntent);
    expect(text).not.toContain('secret');
  });
  it.each([{ succeeded: ['3'] }, { emitted: ['1', '1'] }, { succeeded: '1' }, { status: 'refused', hash: digest(1) }])('L1 rejects incoherent outcome %j on both paths', async bad => {
    const p = { version: 1 as const, specHash: digest(1), intents: [{ ...intent, ...bad } as RevealIntent] };
    const store = { get: async () => JSON.stringify(p), put: async () => {} }; authorizeRevealTestTarget(store);
    await expect(readRevealProgress(store, 'key', digest(1))).rejects.toThrow();
    await expect(saveRevealIntent(store, 'key', { ...p, intents: [] }, mustIntent(p.intents[0]))).rejects.toThrow();
  });
  it('L1 refuses journal exhaustion before writing and never drops unresolved evidence', async () => {
    const p = { version: 1 as const, specHash: digest(1), intents: Array.from({ length: 30_000 }, (_, i) => ({ ...intent, attempt: `a-${i}` })) };
    let writes = 0;
    const store = { get: async () => JSON.stringify(p), put: async () => { writes++; } }; authorizeRevealTestTarget(store);
    await expect(saveRevealIntent(store, 'key', p, intent)).rejects.toThrow(); expect(writes).toBe(0);
  });
});
function mustIntent(i: RevealIntent | undefined): RevealIntent { if (!i) throw new Error(); return i; }

it('L1 enforces serialized byte size before writing without dropping pending intents', async () => {
  const intents = Array.from({ length: 30_000 }, (_, i) => ({ attempt: `${i}`.padEnd(200, 'x'), ids: Array.from({ length: 40 }, (_, id) => `${id + 1}`),
    account: addr(50), nonce: '9'.repeat(78), capWei: '9'.repeat(78), createdAt: 0, status: 'intent' as const }));
  const progress = { version: 1 as const, specHash: digest(1), intents };
  let writes = 0; const store = { get: async () => null, put: async () => { writes++; } }; authorizeRevealTestTarget(store);
  await expect(saveRevealIntent(store, 'key', progress, mustIntent(intents[0]))).rejects.toThrow('progress-invalid');
  expect(writes).toBe(0); expect(progress.intents).toHaveLength(30_000);
});

it('af2 L1 sanitizes an imported previous journal before an incremental save', async () => {
  const previous = { version: 1 as const, specHash: digest(1), intents: [{ attempt: 'old', ids: ['1'], account: addr(50), createdAt: 0,
    capWei: '123', status: 'unknown' as const, salt: 'private' }], proof: 'private' };
  let text = '';
  const store = { get: async () => null, put: async (_key: string, value: string) => { text = value; } }; authorizeRevealTestTarget(store);
  const next = await saveRevealIntent(store, 'key', previous, { attempt: 'new', ids: ['2'], account: addr(50), createdAt: 0, capWei: '456', status: 'intent' });
  expect(text).not.toContain('private'); expect(JSON.stringify(next)).not.toContain('private');
  expect(next.intents).toHaveLength(2);
});

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));
