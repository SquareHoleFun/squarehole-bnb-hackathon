import { describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Bot } from '../src/bot';
import { contentHash, Journal, MemoryAppendStore } from '../src/journal';
import type { SafeServicePayload } from '../src/types';
import { addr, hash, lot, manifest, must, quote, snapshot } from './fixtures';

const request = { kind: 'sale', lotId: 'lot-1', routeId: 'coin-eth', amount: 100n, quote: quote() };
const nextManifest = () => ({ ...structuredClone(manifest), policyVersion: 'reviewed-2',
  boxes: [...manifest.boxes, { id: '3', receiver: addr(30n), p: zeroAddress }],
  routes: manifest.routes.map(r => r.id === 'coin-eth' ? { ...r, version: '2', slippageBps: 50n } : r) });

describe('FABLE item 1: explicit manifest migration preserves the shared ledger', () => {
  it('replays old rows unchanged, carries reserved/consumed lots and nonces, and keeps proceeds at the FIT Safe', async () => {
    const store = new MemoryAppendStore(); const bot = new Bot(manifest, new Journal(store));
    bot.receive(lot());
    const sold = bot.plan(snapshot(), request);
    const result = { chainId: manifest.chainId, safe: manifest.safes.fit, logIndex: 0n,
      status: 'success', canonical: true, effectsVerified: true, txHash: hash(40n), safeTxHash: sold.id,
      nonce: 0n, nonceAfter: 1n, amountIn: 100n, amountOut: 210n };
    bot.resolve(sold.id, result);
    const pending = bot.plan({ ...snapshot(), nonce: 1n }, request);
    const prefix = store.read(); const next = nextManifest();
    // A new configuration alone cannot silently adopt or reset an old journal.
    expect(() => new Bot(next, new Journal(store))).toThrow(/manifest/);
    bot.migrateManifest(next);
    expect(store.read().startsWith(prefix)).toBe(true);
    expect(new Journal(store).entries).toHaveLength(5);
    const restarted = new Bot(next, new Journal(store));
    expect(restarted.available('lot-1')).toBe(800n);
    expect(restarted.available(`${sold.id}:output`)).toBe(210n);
    expect(() => restarted.receive(lot())).toThrow(/duplicate/);
    expect(() => restarted.resolve(sold.id, result)).toThrow(/resolved/);
    const currentRequest = { ...request, quote: { ...quote(), routeVersion: '2' } };
    for (const nonce of [0n, 1n]) {
      expect(() => restarted.plan({ ...snapshot(), nonce }, currentRequest)).toThrow(/nonce/);
    }
    const signer = { signDigest: vi.fn() }; const service = { propose: vi.fn() };
    await expect(restarted.propose(pending.id, { snapshot: async () => ({ ...snapshot(), nonce: 1n }),
      simulate: async () => true }, service, signer)).rejects.toThrow(/quote binding/);
    expect(signer.signDigest).not.toHaveBeenCalled();
    // Already signed historical calldata may still execute. Reconcile it using its recorded minimum and identity.
    restarted.resolve(pending.id, { ...result, txHash: hash(41n), safeTxHash: pending.id, nonce: 1n, nonceAfter: 2n });
    const replayed = new Bot(next, new Journal(store));
    expect(replayed.available('lot-1')).toBe(800n);
    const third = { ...next, policyVersion: 'reviewed-3', routes: next.routes.filter(r => r.id !== 'coin-eth') };
    replayed.migrateManifest(third);
    expect(new Bot(third, new Journal(store)).available(`${pending.id}:output`)).toBe(210n);
    expect(() => new Bot(next, new Journal(store))).toThrow(/manifest/);
  });

  it.each([
    { policyVersion: manifest.policyVersion },
    { chainId: 2n }, { safes: { ...manifest.safes, conversion: addr(31n) } }, { safes: { ...manifest.safes, platform: addr(31n) } },
    { owners: { ...manifest.owners, founder: addr(31n) } },
    { boxes: manifest.boxes.slice(1) },
    { boxes: [{ ...must(manifest.boxes[0]), receiver: addr(31n) }, must(manifest.boxes[1])] },
    { boxes: [{ ...must(manifest.boxes[0]), p: zeroAddress }, must(manifest.boxes[1])] },
    { assetDecimals: { ...manifest.assetDecimals, [manifest.box0.fit]: '6' } },
    { routes: manifest.routes.map(r => r.id === 'fit-p' ? { ...r, slippageBps: 50n } : r) },
  ])('refuses an unsafe or unversioned migration without appending: %s', patch => {
    const store = new MemoryAppendStore(); const bot = new Bot(manifest, new Journal(store));
    bot.receive(lot()); const before = store.read();
    expect(() => bot.migrateManifest({ ...nextManifest(), ...patch })).toThrow();
    expect(store.read()).toBe(before);
    expect(new Bot(manifest, new Journal(store)).available('lot-1')).toBe(1000n);
  });

  it('preserves FIT reservations, refuses reused versions and cannot unfreeze a reorg', () => {
    const store = new MemoryAppendStore(); const bot = new Bot(manifest, new Journal(store));
    bot.receive(lot('fit', zeroAddress));
    const funding = bot.plan(snapshot(), { kind: 'fund', lotId: 'lot-1', amount: 400n });
    bot.migrateManifest(nextManifest());
    const replayed = new Bot(nextManifest(), new Journal(store));
    expect(replayed.available('lot-1')).toBe(600n);
    expect(replayed.inspect().proposals.map(p => p.id)).toEqual([funding.id]);
    expect(() => replayed.migrateManifest({ ...nextManifest(), policyVersion: manifest.policyVersion })).toThrow(/version/);
    replayed.freeze(hash(99n));
    expect(() => replayed.migrateManifest({ ...nextManifest(), policyVersion: 'reviewed-3' })).toThrow(/reconciliation/);
    expect(() => new Bot(nextManifest(), new Journal(store)).plan({ ...snapshot(), nonce: 1n },
      { kind: 'fund', lotId: 'lot-1', amount: 1n })).toThrow(/reconciliation/);
  });
});

function barrier() {
  let release = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

describe('FABLE fix round finding 1: migration waits for proposal operations', () => {
  const account = privateKeyToAccount(keccak256(stringToHex('FABLE migration fake signer, no funds')));
  const m = { ...manifest, owners: { ...manifest.owners, bot: account.address.toLowerCase() as typeof account.address } };
  const next = { ...m, policyVersion: 'retired-route-2', routes: m.routes.filter(r => r.id !== 'coin-eth') };
  const saleRequest = { kind: 'sale', lotId: 'lot-1', routeId: 'coin-eth', amount: 100n, quote: quote() };
  const cases = [
    ...['snapshot', 'simulation', 'signing', 'submission'].map(stage => ({ kind: 'action', stage })),
    ...['snapshot', 'simulation', 'signing', 'submission'].map(stage => ({ kind: 'cancellation', stage })),
  ];

  it.each(cases)('refuses migration during $kind $stage and binds submission to the validated policy', async ({ kind, stage }) => {
    const store = new MemoryAppendStore(); const journal = new Journal(store); const bot = new Bot(m, journal);
    const entered = barrier(); const resume = barrier();
    const pause = async (at: string) => { if (stage === at) { entered.release(); await resume.wait; } };
    const s = { ...snapshot(), owners: Object.values(m.owners) };
    bot.receive(lot());
    const original = bot.plan(s, saleRequest);
    const id = kind === 'cancellation' ? bot.planCancellation(original.id, s).id : original.id;
    const reader = { snapshot: async () => { await pause('snapshot'); return s; },
      simulate: async () => { await pause('simulation'); return true; } };
    const signer = { signDigest: vi.fn(async (digest: Hex) => { await pause('signing'); return account.sign({ hash: digest }); }) };
    const service = { propose: vi.fn(async (payload: SafeServicePayload) => {
      expect(payload.contractTransactionHash).toBe(id); await pause('submission');
    }) };
    const running = kind === 'cancellation' ? bot.proposeCancellation(id, reader, service, signer)
      : bot.propose(id, reader, service, signer);
    await entered.wait;
    const before = store.read();
    try {
      expect(() => bot.migrateManifest(next)).toThrow(/proposal.*in progress/);
      expect(store.read()).toBe(before);
      expect(bot.manifest.policyVersion).toBe(m.policyVersion);
      if (stage === 'snapshot' || stage === 'simulation') expect(signer.signDigest).not.toHaveBeenCalled();
      if (stage !== 'submission') expect(service.propose).not.toHaveBeenCalled();
    } finally { resume.release(); await Promise.allSettled([running]); }
    await running;
    expect(service.propose).toHaveBeenCalledOnce();
    expect(must(service.propose.mock.calls[0])[0].origin).toBe(`Square Hole ${m.policyVersion}`);
    expect(journal.entries.slice(-2).map(entry => entry.record)).toEqual([
      expect.objectContaining({ kind: 'submission', manifestHash: contentHash(m), policyVersion: m.policyVersion }),
      expect.objectContaining({ kind: 'proposed', manifestHash: contentHash(m), policyVersion: m.policyVersion }),
    ]);
    bot.migrateManifest(next);
    const restarted = new Bot(next, new Journal(store));
    if (kind === 'action') {
      await expect(restarted.propose(id, reader, service, signer)).rejects.toThrow(/route/);
      expect(service.propose).toHaveBeenCalledOnce();
      expect(restarted.available('lot-1')).toBe(900n);
    }
  });

  it('keeps migration blocked until every concurrent operation settles, including rejected submissions', async () => {
    const bot = new Bot(m, new Journal(new MemoryAppendStore())); bot.receive(lot());
    const s = { ...snapshot(), owners: Object.values(m.owners) };
    const first = bot.plan(s, saleRequest); const second = bot.plan({ ...s, nonce: 1n }, saleRequest);
    const firstEntered = barrier(); const firstResume = barrier(); const secondEntered = barrier(); const secondResume = barrier();
    const reader = { snapshot: async () => s, simulate: async () => true };
    const signer = { signDigest: async (digest: Hex) => account.sign({ hash: digest }) };
    const a = bot.propose(first.id, reader, { propose: async () => { firstEntered.release(); await firstResume.wait; } }, signer);
    const b = bot.propose(second.id, reader, { propose: async () => {
      secondEntered.release(); await secondResume.wait; throw new Error('service unavailable');
    } }, signer);
    const failed = expect(b).rejects.toThrow('service unavailable');
    await Promise.all([firstEntered.wait, secondEntered.wait]);
    try {
      expect(() => bot.migrateManifest(next)).toThrow(/proposal.*in progress/);
      firstResume.release(); await a;
      expect(() => bot.migrateManifest(next)).toThrow(/proposal.*in progress/);
    } finally { firstResume.release(); secondResume.release(); await a; await failed; }
    bot.migrateManifest(next);
    expect(bot.manifest.policyVersion).toBe(next.policyVersion);
    expect(bot.available('lot-1')).toBe(800n);
  });
});
