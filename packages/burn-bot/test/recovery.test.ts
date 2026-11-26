import { describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Bot } from '../src/bot';
import { Journal, MemoryAppendStore } from '../src/journal';
import { addr, hash, lot, manifest, quote, snapshot } from './fixtures';

describe('CQ11-E2 durable reservations and confirmation', () => {
  const start = () => {
    const store = new MemoryAppendStore(); const journal = new Journal(store);
    return { store, journal, bot: new Bot(manifest, journal) };
  };
  const request = { kind: 'sale', lotId: 'lot-1', routeId: 'coin-eth', amount: 100n, quote: quote() };
  it('deduplicates receipts by chain transaction/log and quarantines unattributed conversion receipts', () => {
    const { bot } = start(); bot.receive(lot());
    expect(() => bot.receive({ ...lot(), id: 'renamed' })).toThrow(/duplicate/);
    expect(() => bot.receive({ ...lot(), role: 'conversion', boxId: null })).toThrow();
    expect(() => bot.receive({ ...lot(), role: 'conversion', kind: 'earned' })).toThrow();
  });
  it('reserves before publication, survives restart and does not resell on service outage', async () => {
    const account = privateKeyToAccount(keccak256(stringToHex('CQ11-E2 outage fake signer, no funds')));
    const m = { ...manifest, owners: { ...manifest.owners, bot: account.address.toLowerCase() as typeof account.address } };
    const s = { ...snapshot(), owners: Object.values(m.owners) };
    const store = new MemoryAppendStore(), bot = new Bot(m, new Journal(store)); bot.receive(lot());
    const proposal = bot.plan(s, request);
    const signer = { signDigest: vi.fn(async (digest: Hex) => account.sign({ hash: digest })) };
    const service = { propose: vi.fn().mockRejectedValue(new Error('offline')) };
    const reader = { snapshot: vi.fn().mockResolvedValue(s), simulate: vi.fn().mockResolvedValue(true) };
    await expect(bot.propose(proposal.id, reader, service, signer)).rejects.toThrow('offline');
    expect(signer.signDigest).toHaveBeenCalledExactlyOnceWith(proposal.id);
    expect(store.read()).not.toContain('"signature":');
    const restarted = new Bot(m, new Journal(store));
    expect(restarted.available('lot-1')).toBe(900n);
    expect(() => restarted.plan(s, request)).toThrow(/nonce/);
    expect(() => restarted.resolve(proposal.id, { chainId: manifest.chainId, safe: proposal.snapshot.safe, logIndex: 0n, status: 'cancelled', canonical: false, txHash: hash(30n), safeTxHash: proposal.id, nonce: 0n, nonceAfter: 1n })).toThrow();
    expect(restarted.available('lot-1')).toBe(900n);
  });
  it('requires verified money effects, and consumed nonce failures release only after canonical proof', () => {
    const { bot } = start(); bot.receive(lot()); const p = bot.plan(snapshot(), request);
    expect(() => bot.resolve(p.id, { chainId: manifest.chainId, safe: p.snapshot.safe, logIndex: 0n, status: 'success', canonical: true, txHash: hash(30n), safeTxHash: p.id, nonce: 0n, nonceAfter: 1n, amountIn: 100n, amountOut: 200n, effectsVerified: false })).toThrow();
    bot.resolve(p.id, { chainId: manifest.chainId, safe: p.snapshot.safe, logIndex: 0n, status: 'failed', canonical: true, txHash: hash(30n), safeTxHash: p.id, nonce: 0n, nonceAfter: 1n, effectsVerified: true });
    expect(bot.available('lot-1')).toBe(1000n);
    expect(() => bot.plan(snapshot(), request)).toThrow(/nonce/);
    expect(() => bot.resolve(p.id, { chainId: manifest.chainId, safe: p.snapshot.safe, logIndex: 0n, status: 'failed', canonical: true, txHash: hash(30n), safeTxHash: p.id, nonce: 0n, nonceAfter: 1n, effectsVerified: true })).toThrow();
  });


  it.each(['failed', 'cancelled'] as const)('replays separate %s execution logs and releases each reservation once', status => {
    const { bot, store } = start(); bot.receive(lot());
    const first = bot.plan(snapshot(), request);
    const second = bot.plan({ ...snapshot(), nonce: 1n }, request);
    const result = { status, chainId: manifest.chainId, safe: first.snapshot.safe, logIndex: 7n,
      canonical: true, effectsVerified: true, txHash: hash(60n), nonce: 0n, nonceAfter: 2n,
      safeTxHash: status === 'cancelled' ? hash(61n) : first.id };
    bot.resolve(first.id, result);
    const restarted = new Bot(manifest, new Journal(store));
    restarted.resolve(second.id, { ...result, logIndex: 8n, nonce: 1n, safeTxHash: status === 'cancelled' ? hash(62n) : second.id });
    expect(new Bot(manifest, new Journal(store)).available('lot-1')).toBe(1000n);
    expect(() => restarted.resolve(second.id, { ...result, logIndex: 9n })).toThrow(/resolved/);
  });
  it.each([
    { chainId: 2n }, { safe: addr(99n) }, { nonce: 1n }, { safeTxHash: hash(90n) },
    { logIndex: undefined }, { logIndex: -1n }, { logIndex: 1 },
  ])('requires the canonical execution identity bound to its proposal: %s', patch => {
    const { bot, journal } = start(); bot.receive(lot()); const p = bot.plan(snapshot(), request);
    const result = { status: 'success', canonical: true, effectsVerified: true, chainId: manifest.chainId,
      safe: p.snapshot.safe, txHash: hash(50n), logIndex: 0n, safeTxHash: p.id, nonce: 0n, nonceAfter: 2n, amountIn: 100n, amountOut: 210n };
    expect(() => bot.resolve(p.id, { ...result, ...patch })).toThrow();
    expect(journal.entries).toHaveLength(2);
    expect(bot.available('lot-1')).toBe(900n);
    bot.resolve(p.id, result);
  });
  it('lets one Safe execution log resolve only one proposal, live and after replay', () => {
    const { bot, store } = start(); bot.receive(lot('fit', zeroAddress));
    const fund = { kind: 'fund', lotId: 'lot-1', amount: 100n };
    const first = bot.plan(snapshot(), fund), second = bot.plan({ ...snapshot(), nonce: 1n }, fund);
    const proof = { status: 'success', chainId: manifest.chainId, safe: manifest.safes.fit, canonical: true, effectsVerified: true,
      txHash: hash(80n), logIndex: 0n, amountIn: 100n, amountOut: 0n, budgetFunded: 100n };
    bot.resolve(first.id, { ...proof, safeTxHash: first.id, nonce: 0n, nonceAfter: 1n });
    const replayed = new Bot(manifest, new Journal(store));
    // The second proposal cannot borrow the first execution's (chainId, txHash, logIndex).
    for (const b of [bot, replayed]) {
      expect(() => b.resolve(second.id, { ...proof, safeTxHash: second.id, nonce: 1n, nonceAfter: 2n })).toThrow(/duplicate/);
    }
    replayed.resolve(second.id, { ...proof, logIndex: 1n, safeTxHash: second.id, nonce: 1n, nonceAfter: 2n });
    expect(new Bot(manifest, new Journal(store)).available('lot-1')).toBe(800n);
  });
  it.each(['6', '8', '18'])('keeps ETH proceeds at 18 decimals after selling a %s-decimal fee coin and restarting', decimals => {
    const store = new MemoryAppendStore();
    const m = { ...manifest, assetDecimals: { ...manifest.assetDecimals, [lot().asset]: decimals } };
    const bot = new Bot(m, new Journal(store));
    const input = { ...lot(), decimals }; bot.receive(input);
    const sale = bot.plan(snapshot(), request);
    bot.resolve(sale.id, { status: 'success', canonical: true, effectsVerified: true, chainId: manifest.chainId,
      safe: sale.snapshot.safe, txHash: hash(70n), logIndex: 0n, safeTxHash: sale.id, nonce: 0n, nonceAfter: 1n,
      amountIn: 100n, amountOut: 210n });
    const outputId = `${sale.id}:output`;
    for (const resumed of [bot, new Bot(m, new Journal(new MemoryAppendStore(store.read())))]) {
      const funding = resumed.plan({ ...snapshot(), nonce: 1n }, { kind: 'fund', lotId: outputId, amount: 210n });
      expect(funding.draft.source).toMatchObject({ asset: zeroAddress, decimals: '18', amount: 210n, source: input.source });
      expect(funding.transaction.value).toBe(210n);
      expect(sale.draft.source).toMatchObject({ asset: input.asset, decimals, source: input.source });
      expect(resumed.available(input.id)).toBe(900n);
    }
  });

  it('holds before graduation, checks fresh state before signing, and freezes on reorg', async () => {
    const { bot } = start(); bot.receive(lot('fit', zeroAddress));
    const request = { kind: 'fund', lotId: 'lot-1', amount: 10n };
    expect(() => bot.plan({ ...snapshot(), box0: { ...snapshot().box0, graduated: false } }, request)).toThrow();
    const p = bot.plan(snapshot(), request);
    const signer = { signDigest: vi.fn() }; const service = { propose: vi.fn() };
    await expect(bot.propose(p.id, { snapshot: async () => ({ ...snapshot(), box0: { ...snapshot().box0, graduated: false } }), simulate: async () => true }, service, signer)).rejects.toThrow();
    expect(signer.signDigest).not.toHaveBeenCalled();
    bot.freeze(hash(100n));
    expect(() => bot.plan({ ...snapshot(), nonce: 1n }, request)).toThrow(/reconciliation/);
  });
});
