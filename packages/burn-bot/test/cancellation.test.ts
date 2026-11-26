import { describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Bot } from '../src/bot';
import { Journal, MemoryAppendStore } from '../src/journal';
import { hash, lot, manifest, must, quote, snapshot } from './fixtures';

const account = privateKeyToAccount(keccak256(stringToHex('FABLE cancellation fake signer, no funds')));
const m = { ...manifest, owners: { ...manifest.owners, bot: account.address.toLowerCase() as typeof account.address } };
const fresh = (nonce = 0n) => ({ ...snapshot(), owners: Object.values(m.owners), nonce });
const request = { kind: 'sale', lotId: 'lot-1', routeId: 'coin-eth', amount: 100n, quote: quote() };
const signer = () => ({ signDigest: vi.fn(async (digest: `0x${string}`) => account.sign({ hash: digest })) });
function setup() {
  const store = new MemoryAppendStore(); const bot = new Bot(m, new Journal(store)); bot.receive(lot());
  return { bot, store, sale: bot.plan(fresh(), request) };
}

describe('FABLE item 13: same-nonce cancellation of a GS013 clip', () => {
  it('keeps inputs reserved through GS013, proposes a co-signed zero-value self-call and releases only on confirmation', async () => {
    const { bot, store, sale } = setup();
    expect(sale.transaction.safeTxGas).toBe(0n);
    const unchanged = { chainId: m.chainId, safe: sale.snapshot.safe, nonce: 0n, nonceAfter: 0n,
      status: 'failed', canonical: true, effectsVerified: true, safeTxHash: sale.id, txHash: hash(50n), logIndex: 0n };
    expect(() => bot.resolve(sale.id, unchanged)).toThrow(/nonce consumption/);
    const expired = { ...fresh(), block: { ...fresh().block, number: 101n, timestamp: 100301n }, quoteBlocks: [fresh().block] };
    const service = { propose: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined) };
    const reader = { snapshot: async () => expired, simulate: vi.fn().mockResolvedValue(true) };
    await expect(bot.propose(sale.id, reader, service, signer())).rejects.toThrow(/expired/);
    const cancel = bot.planCancellation(sale.id, expired);
    expect(cancel.transaction).toEqual({ to: sale.snapshot.safe, value: 0n, data: '0x', operation: 0,
      safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: 0n });
    expect(cancel.id).not.toBe(sale.id);
    const signing = signer();
    await expect(bot.proposeCancellation(cancel.id, reader, service, signing)).rejects.toThrow('offline');
    expect(bot.available('lot-1')).toBe(900n);
    const restarted = new Bot(m, new Journal(store));
    await restarted.proposeCancellation(cancel.id, reader, service, signing);
    expect(signing.signDigest).toHaveBeenCalledWith(cancel.id);
    expect(must(service.propose.mock.calls[1])[0]).toMatchObject({ contractTransactionHash: cancel.id,
      nonce: '0', value: '0', to: sale.snapshot.safe, sender: m.owners.bot });
    expect(store.read()).not.toContain(must(service.propose.mock.calls[1])[0].signature);
    expect(() => restarted.plan(fresh(), request)).toThrow(/nonce/);
    const proof = { ...unchanged, status: 'success', safeTxHash: cancel.id, nonceAfter: 1n };
    expect(() => restarted.resolveCancellation(cancel.id, { ...proof, nonceAfter: 0n })).toThrow(/nonce consumption/);
    expect(restarted.available('lot-1')).toBe(900n);
    restarted.resolveCancellation(cancel.id, proof);
    const resolved = new Bot(m, new Journal(store));
    expect(resolved.available('lot-1')).toBe(1000n);
    expect(() => resolved.resolveCancellation(cancel.id, proof)).toThrow(/pending/);
    expect(() => resolved.plan(fresh(), request)).toThrow(/nonce/);
    expect(resolved.plan(fresh(1n), request).transaction.nonce).toBe(1n);
  });

  it('cancels after a route migration without rebuilding the retired trade', async () => {
    const { bot, store, sale } = setup();
    const next = { ...m, policyVersion: 'cancel-route-2', routes: m.routes.filter(r => r.id !== 'coin-eth') };
    bot.migrateManifest(next);
    const restarted = new Bot(next, new Journal(store)); const cancel = restarted.planCancellation(sale.id, fresh());
    const service = { propose: vi.fn().mockResolvedValue(undefined) };
    await restarted.proposeCancellation(cancel.id, { snapshot: async () => fresh(), simulate: async () => true }, service, signer());
    expect(service.propose).toHaveBeenCalledOnce();
    expect(new Bot(next, new Journal(store)).available('lot-1')).toBe(900n);
  });

  it('reconciles the original if it wins the race, invalidating its cancellation without releasing spent inputs', async () => {
    const { bot, store, sale } = setup(); const cancel = bot.planCancellation(sale.id, fresh());
    await expect(bot.propose(sale.id, { snapshot: async () => fresh(), simulate: async () => true },
      { propose: vi.fn() }, signer())).rejects.toThrow(/cancellation/);
    bot.resolve(sale.id, { status: 'success', canonical: true, effectsVerified: true, chainId: m.chainId,
      safe: sale.snapshot.safe, txHash: hash(51n), logIndex: 0n, safeTxHash: sale.id, nonce: 0n, nonceAfter: 1n,
      amountIn: 100n, amountOut: 210n });
    const restarted = new Bot(m, new Journal(store));
    expect(restarted.available('lot-1')).toBe(900n);
    expect(restarted.available(`${sale.id}:output`)).toBe(210n);
    await expect(restarted.proposeCancellation(cancel.id, { snapshot: async () => fresh(1n), simulate: async () => true },
      { propose: vi.fn() }, signer())).rejects.toThrow(/pending/);
  });

  it('refuses changed custody, consumed nonces, failed simulation and a wrong signer', async () => {
    const { bot, sale } = setup();
    expect(() => bot.planCancellation(sale.id, { ...fresh(), modules: [m.owners.bot] })).toThrow(/Safe configuration/);
    expect(() => bot.planCancellation(sale.id, fresh(1n))).toThrow(/consumed/);
    const cancel = bot.planCancellation(sale.id, fresh());
    expect(() => bot.planCancellation(sale.id, fresh())).toThrow(/cancellation/);
    const service = { propose: vi.fn() }; const signing = signer();
    await expect(bot.proposeCancellation(cancel.id, { snapshot: async () => fresh(), simulate: async () => false }, service, signing)).rejects.toThrow(/simulation/);
    expect(signing.signDigest).not.toHaveBeenCalled();
    await expect(bot.proposeCancellation(cancel.id, { snapshot: async () => fresh(), simulate: async () => true }, service,
      { signDigest: async () => '0x00' })).rejects.toThrow(/signature/);
    expect(service.propose).not.toHaveBeenCalled();
    expect(bot.available('lot-1')).toBe(900n);
  });
});
