import { mkdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Bot } from '../src/bot';
import { Journal } from '../src/journal';
import { SqliteAppendStore } from '../src/store';
import { must, hash, lot, manifest, snapshot } from './fixtures';

describe('CQ11-E2 durable append and external digest signer', () => {
  it('restarts from an atomic SQLite journal, publishes JSONL and refuses stale writers', () => {
    const directory = new URL('../../../.cache/cq11-e2/', import.meta.url);
    mkdirSync(directory, { recursive: true });
    const file = new URL(`journal-${crypto.randomUUID()}.sqlite`, directory);
    const store = new SqliteAppendStore(file); const a = new Journal(store); const b = new Journal(store);
    a.append({ kind: 'receipt', amountRaw: '123', txHash: hash(1n) });
    expect(() => b.append({ kind: 'waiting' })).toThrow(/stale/);
    const output = new URL(`published-${crypto.randomUUID()}.jsonl`, directory);
    store.publish(output); const text = readFileSync(output, 'utf8');
    expect(text).toBe(store.read()); store.close();
    const reopened = new SqliteAppendStore(file);
    expect(new Journal(reopened, a.head).entries).toHaveLength(1); reopened.close();
  });
  it('signs only the verified Safe digest, records no signature, and still needs another owner', async () => {
    // Deterministic fake signer only; the package never loads keys. No production key material in fixtures.
    const account = privateKeyToAccount(keccak256(stringToHex('CQ11-E2 fake signer with no funds')));
    const m = { ...manifest, owners: { ...manifest.owners, bot: account.address.toLowerCase() as typeof account.address } };
    const s = snapshot(); s.owners = Object.values(m.owners);
    const directory = new URL('../../../.cache/cq11-e2/', import.meta.url); mkdirSync(directory, { recursive: true });
    const store = new SqliteAppendStore(new URL(`sign-${crypto.randomUUID()}.sqlite`, directory));
    const bot = new Bot(m, new Journal(store)); bot.receive(lot('fit', zeroAddress));
    const p = bot.plan(s, { kind: 'fund', lotId: 'lot-1', amount: 10n });
    const service = { propose: vi.fn().mockResolvedValue(undefined) };
    const signer = { signDigest: vi.fn(async (digest: `0x${string}`) => account.sign({ hash: digest })) };
    await bot.propose(p.id, { snapshot: async () => s, simulate: async () => true }, service, signer);
    expect(signer.signDigest).toHaveBeenCalledExactlyOnceWith(p.id);
    expect(must(service.propose.mock.calls[0])[0].signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(store.read()).not.toContain('"signature":');
    expect(store.read()).not.toContain(must(service.propose.mock.calls[0])[0].signature);
    expect(bot.available('lot-1')).toBe(990n); // Proposed is still reserved, not funded/burned.
    store.close();
  });
});
