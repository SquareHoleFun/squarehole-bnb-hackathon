import { describe, expect, it, vi } from 'vitest';
import { keccak256, stringToHex, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Bot } from '../src/bot';
import { Journal, MemoryAppendStore } from '../src/journal';
import { runCycle, type RunnerReader } from '../src/runner';
import { FakeSafeService } from '../src/service';
import { servicePayload, safeTransaction } from '../src/safe';
import { buildAction } from '../src/builders';
import { parseCliArgs } from '../src/cli';
import type { Manifest } from '../src/types';
import { hash, lot, manifest, must, quote, snapshot } from './fixtures';

function fixture(m: Manifest = manifest) {
  const store = new MemoryAppendStore(), journal = new Journal(store), bot = new Bot(m, journal);
  const observed = { snapshots: { fit: { ...snapshot('fit'), owners: Object.values(m.owners) } },
    lots: [lot('fit', zeroAddress)], credits: [] };
  const reader: RunnerReader = {
    observe: async () => observed, snapshot: async role => observed.snapshots[role], simulate: vi.fn(async () => true),
    reconcile: vi.fn(async () => []),
  };
  const service = new FakeSafeService(), signer = { signDigest: vi.fn() };
  const quotes = { quote: vi.fn(async (_routeId: string, amount: bigint) => ({ ...quote(), amountIn: amount })) };
  return { store, journal, bot, observed, reader, service, signer, quotes };
}
describe('daily runner and CLI', () => {
  it('defaults CLI to dry run and requires explicit mainnet and signer flags to act', async () => {
    expect(parseCliArgs(['--config', 'fake.json'])).toMatchObject({ dryRun: true, allowMainnet: false });
    expect(() => parseCliArgs(['--config', 'fake.json', '--propose', '--dry-run'])).toThrow();
    const f = fixture();
    await expect(runCycle({ ...f, dryRun: false, allowMainnet: true, signer: undefined })).rejects.toThrow(/signer/);
    await expect(runCycle({ ...f, dryRun: true })).rejects.toThrow(/mainnet/);
    expect(f.journal.entries).toHaveLength(0);
  });
  it('plans, simulates and journals but never signs or sends; restart preserves reservations', async () => {
    const f = fixture(); const send = vi.spyOn(f.service, 'propose');
    const result = await runCycle({ ...f, dryRun: true, allowMainnet: true });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.transaction.value).toBe(1000n);
    expect(f.reader.reconcile).toHaveBeenCalled(); expect(f.reader.simulate).toHaveBeenCalled();
    expect(f.signer.signDigest).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    const bot = new Bot(manifest, new Journal(f.store));
    const replay = await runCycle({ ...f, bot, dryRun: true, allowMainnet: true });
    expect(replay.proposals).toHaveLength(0);
    expect(bot.available('lot-1')).toBe(0n);
    expect(f.store.read()).toContain('runner-reconciliation');
  });
  it('holds before graduation and refuses to spend unbacked royalties or foreign pending nonces', async () => {
    const f = fixture(); f.observed.snapshots.fit.box0.graduated = false;
    expect((await runCycle({ ...f, dryRun: true, allowMainnet: true })).proposals).toHaveLength(0);
    f.observed.snapshots.fit.box0.graduated = true;
    f.observed.snapshots.fit.balances[zeroAddress] = 1n;
    await expect(runCycle({ ...f, dryRun: true, allowMainnet: true })).rejects.toThrow(/unbacked/);
    expect(f.bot.available('lot-1')).toBe(1000n);
  });
  it('records quote/simulation failure without inventing a proposal or releasing inventory', async () => {
    const f = fixture(); f.observed.lots = [lot()];
    f.reader.simulate = async () => false;
    const result = await runCycle({ ...f, dryRun: true, allowMainnet: true });
    expect(result.proposals).toHaveLength(0); expect(result.waiting.length).toBeGreaterThan(0);
    expect(f.bot.available('lot-1')).toBe(1000n);
  });
  it('cannot reuse a dry journal to make live proposals', async () => {
    const f = fixture(); await runCycle({ ...f, dryRun: true, allowMainnet: true });
    await expect(runCycle({ ...f, dryRun: false, allowMainnet: true })).rejects.toThrow(/journal mode/);
  });

  it('signs FIT proposals with the managed signer and waits on unknown service reservations', async () => {
    const account = privateKeyToAccount(keccak256(stringToHex('CQ11 runner fake signer, no funds')));
    const f = fixture({ ...manifest, owners: { ...manifest.owners, bot: account.address.toLowerCase() as typeof account.address } });
    const signer = { signDigest: vi.fn(async (digest: Hex) => account.sign({ hash: digest })) };
    const result = await runCycle({ ...f, signer, dryRun: false, allowMainnet: true });
    expect(result.proposals).toHaveLength(1);
    expect(f.service.proposals.size).toBe(1);
    const id = must(result.proposals[0]).id;
    expect([...f.service.proposals.values()][0]).toMatchObject({ safe: manifest.safes.fit, contractTransactionHash: id,
      sender: account.address.toLowerCase(), signature: expect.stringMatching(/^0x[0-9a-f]{130}$/) });
    expect(signer.signDigest).toHaveBeenCalledExactlyOnceWith(id);
    const other = fixture(), s = snapshot();
    const draft = buildAction(manifest, s, lot('fit', zeroAddress), { kind: 'fund', lotId: 'lot-1', amount: 100n });
    await other.service.propose({ ...servicePayload(manifest, 'fit', safeTransaction(manifest, s, draft), null), contractTransactionHash: hash(777n) });
    const blocked = await runCycle({ ...other, dryRun: true, allowMainnet: true });
    expect(blocked.proposals).toHaveLength(0);
    expect(blocked.waiting).toContainEqual({ id: 'fit', reason: 'foreign-pending-proposal' });
  });

});
