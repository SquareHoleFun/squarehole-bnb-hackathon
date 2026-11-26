import { describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Bot } from '../src/bot';
import { Journal, MemoryAppendStore } from '../src/journal';
import { reconcileAsset } from '../src/reconcile';
import { hash, lot, manifest, quote, snapshot } from './fixtures';

describe('CQ11-E2 operational boundaries', () => {
  const start = () => {
    const store = new MemoryAppendStore(); const journal = new Journal(store);
    return { store, journal, bot: new Bot(manifest, journal) };
  };
  it('refuses to release a signed reservation without proof its nonce was consumed', () => {
    const { bot } = start(); bot.receive(lot('fit', zeroAddress));
    const p = bot.plan(snapshot(), { kind: 'fund', lotId: 'lot-1', amount: 100n });
    expect(() => bot.resolve(p.id, { chainId: manifest.chainId, safe: p.snapshot.safe, logIndex: 0n, status: 'failed', canonical: true, effectsVerified: true, txHash: hash(40n), safeTxHash: p.id, nonce: 0n })).toThrow(/nonce/);
    expect(bot.available('lot-1')).toBe(900n);
  });
  it('proposes a daily sequence without waiting for the previous Safe nonce to execute', async () => {
    const account = privateKeyToAccount(keccak256(stringToHex('CQ11-E2 daily sequence fake signer, no funds')));
    const m = { ...manifest, owners: { ...manifest.owners, bot: account.address.toLowerCase() as typeof account.address } };
    const s = { ...snapshot(), owners: Object.values(m.owners) };
    const bot = new Bot(m, new Journal(new MemoryAppendStore())); bot.receive(lot());
    const action = { kind: 'sale', lotId: 'lot-1', amount: 100n, routeId: 'coin-eth', quote: quote() };
    const first = bot.plan(s, action);
    const second = bot.plan({ ...s, nonce: 1n }, action);
    expect(first.batchId).toBe(second.batchId);
    const service = { propose: vi.fn().mockResolvedValue(undefined) };
    await bot.propose(second.id, { snapshot: async () => s, simulate: async () => true }, service,
      { signDigest: async (digest: Hex) => account.sign({ hash: digest }) });
    expect(service.propose).toHaveBeenCalledOnce();
    expect(bot.available('lot-1')).toBe(800n);
  });
  it('publishes identity, UTC time, decoded calldata and tx hashes while proposals stay unexecuted', () => {
    const { bot, journal } = start(); bot.receive(lot());
    bot.plan(snapshot(), { kind: 'sale', lotId: 'lot-1', amount: 100n, routeId: 'coin-eth', quote: quote() });
    expect(journal.entries[1]?.record).toMatchObject({ schemaVersion: '1', chainId: '1', safe: manifest.safes.fit,
      status: 'awaiting-signatures', txHash: null, recordedUtc: expect.stringMatching(/Z$/),
      decodedCalls: expect.arrayContaining([expect.objectContaining({ functionName: 'approve' })]),
    });
  });
  it('checks exact per-asset conservation above the JS safe-integer range', () => {
    const opening = 2n ** 120n;
    expect(reconcileAsset({ opening, receipts: 1000n, swapOutputs: 200n, consumedInputs: 100n, returns: 50n,
      funds: 60n, burns: 70n, transfers: 80n, unrelatedIn: 0n, unrelatedOut: 0n, closing: opening + 840n, reserved: 10n, liabilities: 20n })).toBe(opening + 840n);
    expect(() => reconcileAsset({ opening: 1n, receipts: 0n, swapOutputs: 0n, consumedInputs: 2n, returns: 0n,
      funds: 0n, burns: 0n, transfers: 0n, unrelatedIn: 0n, unrelatedOut: 0n, closing: 0n, reserved: 0n, liabilities: 0n })).toThrow();
  });
  it('publishes waiting/unattributed transfers without making them spendable', () => {
    const { bot, journal } = start();
    bot.quarantine({ ...lot(), boxId: null, receiver: null }, 'unattributed');
    expect(() => bot.available('lot-1')).toThrow();
    expect(journal.entries[0]?.record).toMatchObject({ kind: 'quarantine', status: 'waiting', reason: 'unattributed' });
  });
  it('replays older quarantine rows and persists unverified transfer evidence without duplicate inventory', () => {
    const { bot, store } = start(), source = lot('fit');
    bot.quarantine(source, 'unsupported-route'); // Existing journal rows have no transfer-evidence field.
    const replay = new Bot(manifest, new Journal(store));
    expect(replay.inspect().quarantined).toMatchObject([{ lot: source, reason: 'unsupported-route' }]);
    replay.quarantine(source, 'unsupported-route', 'unverified');
    const resumed = new Bot(manifest, new Journal(store));
    resumed.quarantine(source, 'unsupported-route', 'unverified');
    expect(resumed.inspect().quarantined).toMatchObject([{ lot: source, transferEvidence: 'unverified' }]);
    expect(resumed.inspect().lots).toEqual([]);
    expect(() => resumed.available(source.id)).toThrow();
    const rows = new Journal(store).entries.filter(e => (e.record as { kind?: string }).kind === 'quarantine');
    expect(rows).toHaveLength(2); // Immutable historical row + one evidence update, never one per restart.
    expect(rows[1]?.record).toMatchObject({ transferEvidence: 'unverified' });
  });
  it('uses FIFO lots for sales and cannot label a partial spend as a failed atomic batch', () => {
    const { bot } = start(); bot.receive(lot());
    bot.receive({ ...lot('fit', lot().asset, 'lot-2'), source: { ...lot().source, logIndex: 2n } });
    const action = { kind: 'sale', lotId: 'lot-2', amount: 100n, routeId: 'coin-eth', quote: quote() };
    expect(() => bot.plan(snapshot(), action)).toThrow(/FIFO/);
    const p = bot.plan(snapshot(), { ...action, lotId: 'lot-1' });
    expect(() => bot.resolve(p.id, { chainId: manifest.chainId, safe: p.snapshot.safe, logIndex: 0n, status: 'failed', canonical: true, effectsVerified: true, txHash: hash(41n),
      safeTxHash: p.id, nonce: 0n, nonceAfter: 1n, amountIn: 1n })).toThrow(/atomic/);
  });
  it('publishes aggregate executor burns once, separately from funding lots', () => {
    const { bot, store } = start();
    const event = { chainId: 1n, executor: manifest.box0.executor, token: manifest.box0.fit,
      source: lot().source, bought: 20n, unsolicited: 3n, supplyReduction: 23n, canonical: true };
    bot.recordExecutorBurn(event);
    expect(bot.executorBurned()).toBe(23n);
    expect(() => bot.recordExecutorBurn(event)).toThrow(/duplicate/);
    expect(new Bot(manifest, new Journal(store)).executorBurned()).toBe(23n);
    expect(() => bot.recordExecutorBurn({ ...event, source: { ...event.source, logIndex: 2n }, supplyReduction: 24n })).toThrow();
  });
});
