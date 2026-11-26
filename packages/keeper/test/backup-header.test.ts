import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { backupHeader } from '../src/backup-header';
import { vector } from './support/backup';

const rpc = (block: Record<string, unknown>, raw?: unknown) => ({ request: vi.fn(async ({ method }: { method: string }) => {
  if (method === 'debug_getRawHeader') {
    if (raw === undefined) throw new Error('private provider payload');
    return raw;
  }
  return block;
}) });

describe('backup headers are bound to their block hash', () => {
  it.each(['MAINNET', 'SEPOLIA'] as const)('re-encodes the %s Solidity vector byte for byte with minimal integer bytes', async name => {
    const v = vector(name), client = rpc(v.block);
    const header = await backupHeader(client, BigInt(v.block.number as string));
    expect(header).toBe(v.raw); expect(keccak256(header)).toBe(v.hash);
    expect(client.request).toHaveBeenCalledWith({ method: 'eth_getBlockByNumber', params: [v.block.number, false] });
    expect(client.request.mock.calls[0]?.[0].method).toBe('debug_getRawHeader');
  });
  it.each(['changed', 'unknown', 'gap', 'missing', 'malformed'] as const)('refuses a %s field with fixed text', async kind => {
    const block = { ...vector('MAINNET').block };
    if (kind === 'changed') block.gasUsed = '0x1';
    if (kind === 'unknown') block.futureHeaderRoot = `0x${'12'.repeat(32)}`;
    if (kind === 'gap') block.blobGasUsed = undefined;
    if (kind === 'missing') block.nonce = undefined;
    if (kind === 'malformed') block.difficulty = '-0x1';
    await expect(backupHeader(rpc(block), 26233781n)).rejects.toThrow(/^backup header mismatch$/);
  });
  it('uses a matching raw header as is and falls back on a mismatching answer', async () => {
    const v = vector('MAINNET');
    expect(await backupHeader(rpc({ hash: v.hash }, v.raw), 26233781n)).toBe(v.raw);
    expect(await backupHeader(rpc(v.block, '0xc0'), 26233781n)).toBe(v.raw);
  });
  it('never exposes provider text when neither RPC method answers', async () => {
    await expect(backupHeader({ request: async () => { throw new Error('private provider payload'); } }, 1n))
      .rejects.toThrow(/^backup header mismatch$/);
  });
});
