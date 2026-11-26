import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { buildAction, validateManifest } from '../src/builders';
import { safeTransaction } from '../src/safe';
import { Bot } from '../src/bot';
import { Journal, MemoryAppendStore } from '../src/journal';
import { addr, lot, manifest, must, quote, snapshot } from './fixtures';

// Keep fake deployments away from EVM precompiles. Only test fixture addresses change.
function relocate(value: unknown): unknown {
  if (typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value) && value !== zeroAddress) return addr(BigInt(value) + 0x100000n);
  if (Array.isArray(value)) return value.map(relocate);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [relocate(k), relocate(v)]));
  return value;
}
it('pins the actual builder calldata executed by both EVM test runs', () => {
  const first = must(manifest.routes[0]);
  if (first.kind !== 'v3') throw new Error('fixture');
  const m = validateManifest(relocate(manifest));
  const vectors: Record<string, unknown> = {};
  // The FIT Safe's sale forms. FIT itself is only burned; the platform's FIT sale (fit_p) left with F164 D2.
  for (const [id, role, input] of [
    ['coin-eth', 'fit', addr(15n)], ['weth-eth', 'fit', manifest.weth],
  ] as const) {
    const originalQuote = quote(id);
    if (id === 'weth-eth') originalQuote.quotedOut = 100n;
    const s = relocate(snapshot(role)); const source = relocate(lot(role, input));
    const request = relocate({ kind: 'sale', routeId: id, lotId: 'lot-1', amount: 100n, quote: originalQuote });
    const draft = buildAction(m, s, source, request);
    const tx = safeTransaction(m, snapshotForVector(s), draft);
    const route = must(m.routes.find(r => r.id === id));
    vectors[id.replaceAll('-', '_')] = {
      safe: draft.safe, helper: m.multiSend.address, router: route.router, weth: m.weth,
      input: draft.inputAsset, output: draft.outputAsset, to: tx.to, data: tx.data,
      amountIn: '100', amountOut: originalQuote.quotedOut.toString(), deadline: '100200',
      value: tx.value.toString(), operation: tx.operation.toString(),
    };
    if (id === 'coin-eth') {
      const bot = new Bot(m, new Journal(new MemoryAppendStore())); bot.receive(source);
      const sale = bot.plan(s, request); const cancellation = bot.planCancellation(sale.id, s);
      vectors.cancellation = { safe: draft.safe, to: cancellation.transaction.to, data: cancellation.transaction.data,
        value: cancellation.transaction.value.toString(), operation: cancellation.transaction.operation.toString(),
        nonce: cancellation.transaction.nonce.toString(), safeTxGas: cancellation.transaction.safeTxGas.toString() };
    }
  }
  const file = new URL('./fixtures/calldata.json', import.meta.url);
  if (process.env.SH_BOT_WRITE_VECTORS === '1') {
    mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
    writeFileSync(file, `${JSON.stringify(vectors, null, 2)}\n`);
  }
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(vectors);
});
function snapshotForVector(input: unknown) {
  // Validate the relocated snapshot without relying on an unchecked cast.
  return snapshotSchema.parse(input);
}
import { snapshotSchema } from '../src/schema';
