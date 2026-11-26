import { describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Bot } from '../src/bot';
import { Journal, MemoryAppendStore } from '../src/journal';
import type { Manifest } from '../src/types';
import { hash, lot, manifest, quote, snapshot } from './fixtures';

describe('FABLE fix round finding 2: historical gas charges survive migration', () => {
  it.each([
    { oldGas: 200000n, newGas: 100000n, admitted: 2n },
    { oldGas: 100000n, newGas: 200000n, admitted: 5n },
  ])('charges nine confirmed actions at $oldGas after changing to $newGas and restarting', ({ oldGas, newGas, admitted }) => {
    const initial = { ...manifest, limits: { ...manifest.limits, transactionGas: oldGas } };
    const store = new MemoryAppendStore(); const bot = new Bot(initial, new Journal(store));
    bot.receive(lot('fit', zeroAddress));
    const request = { kind: 'fund', lotId: 'lot-1', amount: 1n };
    for (let nonce = 0n; nonce < 9n; nonce++) {
      const p = bot.plan({ ...snapshot(), nonce }, request);
      bot.resolve(p.id, { status: 'success', canonical: true, effectsVerified: true, chainId: manifest.chainId,
        safe: p.snapshot.safe, txHash: hash(1000n + nonce), logIndex: 0n, safeTxHash: p.id,
        nonce, nonceAfter: nonce + 1n, amountIn: 1n, amountOut: 0n, budgetFunded: 1n });
    }
    const prefix = store.read();
    const next = { ...initial, policyVersion: 'gas-2', limits: { ...initial.limits, transactionGas: newGas } };
    bot.migrateManifest(next);
    expect(store.read().startsWith(prefix)).toBe(true);
    let restarted = new Bot(next, new Journal(store));
    for (let i = 0n; i < admitted; i++) {
      restarted.plan({ ...snapshot(), nonce: 9n + i }, request);
      restarted = new Bot(next, new Journal(store));
    }
    const before = store.read();
    expect(() => restarted.plan({ ...snapshot(), nonce: 9n + admitted }, request)).toThrow(/daily.*gas budget/);
    expect(store.read()).toBe(before);
    expect(restarted.available('lot-1')).toBe(1000n - 9n - admitted);
    // A new UTC day has its own budget, even while yesterday's proposals remain pending.
    expect(restarted.plan({ ...snapshot(), nonce: 9n + admitted,
      block: { ...snapshot().block, timestamp: snapshot().block.timestamp + 86400n } }, request)).toBeDefined();
  });

  const kinds = ['action', 'cancellation'] as const;
  it.each(kinds.flatMap(history => kinds.map(attempt => ({ history, attempt }))))(
    'preserves $history charges when budgeting a new $attempt', ({ history, attempt }) => {
      const { m, bot, store, s, sale } = fitSetup();
      let nonce = 0n;
      const proof = (id: Hex) => ({ chainId: m.chainId, safe: s.safe, canonical: true, effectsVerified: true,
        nonce, nonceAfter: nonce + 1n, safeTxHash: id, txHash: hash(2000n + nonce), logIndex: 0n });
      for (let i = 0; i < (history === 'cancellation' ? 4 : 8); i++) {
        const p = bot.plan({ ...s, nonce }, sale);
        if (history === 'action') bot.resolve(p.id, { ...proof(p.id), status: 'failed' });
        else {
          const c = bot.planCancellation(p.id, { ...s, nonce });
          bot.resolveCancellation(c.id, { ...proof(c.id), status: 'success' });
        }
        nonce++;
      }
      // Nine attempts reserve 1.8M gas: confirmed failures/cancellations and this pending sale all count.
      const pending = bot.plan({ ...s, nonce }, sale);
      const next = { ...m, policyVersion: 'gas-2', limits: { ...m.limits, transactionGas: 100000n } };
      bot.migrateManifest(next);
      let restarted = new Bot(next, new Journal(store));
      const cancellation = restarted.planCancellation(pending.id, { ...s, nonce });
      restarted.resolveCancellation(cancellation.id, { ...proof(cancellation.id), status: 'success' });
      nonce++;
      restarted = new Bot(next, new Journal(store));
      const second = restarted.plan({ ...s, nonce }, sale);
      if (attempt !== 'cancellation') {
        restarted.resolve(second.id, { ...proof(second.id), status: 'failed' });
        nonce++;
      }
      restarted = new Bot(next, new Journal(store));
      const before = store.read();
      expect(() => {
        if (attempt === 'action') restarted.plan({ ...s, nonce }, sale);
        else restarted.planCancellation(second.id, { ...s, nonce });
      }).toThrow(/daily.*gas budget/);
      expect(store.read()).toBe(before);
      // The next UTC day has its own budget (a nonce after the pending one, if any).
      expect(restarted.plan({ ...s, nonce: nonce + 1n, block: { ...s.block, timestamp: s.block.timestamp + 86400n } },
        { kind: 'fund', lotId: 'fit-eth', amount: 1n })).toBeDefined();
    },
  );

  it.each(kinds.flatMap(kind => [100000n, 300000n].map(newGas => ({ kind, newGas }))))(
    'bounds a pending $kind simulation by its reservation and the new $newGas limit', async ({ kind, newGas }) => {
      const { m, bot, store, s, sale, signer } = fitSetup();
      const original = bot.plan(s, sale);
      const id = kind === 'cancellation' ? bot.planCancellation(original.id, s).id : original.id;
      const next = { ...m, policyVersion: 'gas-2', limits: { ...m.limits, transactionGas: newGas } };
      bot.migrateManifest(next);
      const restarted = new Bot(next, new Journal(store));
      const reader = { snapshot: async () => s, simulate: vi.fn().mockResolvedValue(true) };
      const service = { propose: vi.fn().mockResolvedValue(undefined) };
      if (kind === 'action') await restarted.propose(id, reader, service, signer);
      else await restarted.proposeCancellation(id, reader, service, signer);
      expect(reader.simulate).toHaveBeenCalledExactlyOnceWith(s.safe,
        expect.anything(), s.block, newGas < m.limits.transactionGas ? newGas : m.limits.transactionGas);
      expect(service.propose).toHaveBeenCalledOnce();
    },
  );
});

function fitSetup() {
  const account = privateKeyToAccount(keccak256(stringToHex('FABLE gas budget fake signer, no funds')));
  const m: Manifest = { ...manifest, owners: { ...manifest.owners, bot: account.address.toLowerCase() as typeof account.address } };
  const store = new MemoryAppendStore(); const bot = new Bot(m, new Journal(store));
  bot.receive({ ...lot('fit', zeroAddress, 'fit-eth'), amount: 10n ** 19n });
  bot.receive({ ...lot(), source: { ...lot().source, logIndex: 2n } });
  const s = { ...snapshot(), owners: Object.values(m.owners), block: { ...snapshot().block, timestamp: 2592100n },
    balances: { ...snapshot().balances, [zeroAddress]: 10n ** 19n } };
  const sale = { kind: 'sale', lotId: 'lot-1', routeId: 'coin-eth', amount: 100n,
    quote: { ...quote(), block: s.block, deadline: s.block.timestamp + 200n } };
  const signer = { signDigest: async (digest: Hex) => account.sign({ hash: digest }) };
  return { m, bot, store, s, sale, signer };
}
