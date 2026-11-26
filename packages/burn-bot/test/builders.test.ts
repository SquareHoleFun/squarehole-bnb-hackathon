import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, parseAbi, zeroAddress } from 'viem';
import { buildAction, validateManifest } from '../src/builders';
import { must, addr, lot, manifest, quote, snapshot } from './fixtures';

const routerAbi = parseAbi([
  'function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256)',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
]);
const approveAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
const sale = { kind: 'sale' as const, lotId: 'lot-1', amount: 100n, routeId: 'coin-eth', quote: quote() };
describe('CQ11-E2 restricted builders', () => {
  it('pins exact approvals, native output/refund recipient and a positive executable minimum', () => {
    const draft = buildAction(manifest, snapshot(), lot(), sale);
    const calls = draft.calls;
    expect(calls.every(c => c.operation === 0)).toBe(true);
    expect(calls.map(c => c.to)).toEqual([addr(15n), addr(15n), addr(16n), addr(15n)]);
    expect(calls.filter(c => c.to === addr(15n)).map(c => decodeFunctionData({ abi: approveAbi, data: c.data }).args))
      .toEqual([[addr(16n), 0n], [addr(16n), 100n], [addr(16n), 0n]]);
    const swap = decodeFunctionData({ abi: routerAbi, data: must(calls[2]).data });
    expect(swap.functionName).toBe('multicall');
    if (swap.functionName !== 'multicall') throw new Error('wrong router call');
    const inner = swap.args[0].map(data => decodeFunctionData({ abi: routerAbi, data }));
    expect(inner[0]).toMatchObject({ functionName: 'exactInput', args: [{ recipient: addr(16n), amountIn: 100n, amountOutMinimum: 198n, deadline: 100200n }] });
    expect(inner[1]).toEqual({ functionName: 'unwrapWETH9', args: [198n, manifest.safes.fit] });
    expect(draft.minimumOut).toBe(198n);
  });
  it.each([
    { chainId: 2n }, { routeVersion: '2' }, { tokenIn: addr(99n) }, { tokenOut: addr(99n) },
    { amountIn: 101n }, { quotedOut: 0n }, { quotedOut: 1n }, { deadline: 100000n }, { deadline: 101000n },
    { block: { ...snapshot().block, hash: `0x${'aa'.repeat(32)}` } },
  ])('rejects unbound or unsafe quotes: %s', (patch) => {
    expect(() => buildAction(manifest, snapshot(), lot(), { ...sale, quote: { ...quote(), ...patch } })).toThrow();
  });
  it('refuses unknown routes, arbitrary calldata and unknown request fields', () => {
    expect(() => buildAction(manifest, snapshot(), lot(), { ...sale, routeId: 'unknown' })).toThrow();
    expect(() => buildAction(manifest, snapshot(), lot(), { ...sale, data: '0x1234' })).toThrow();
    expect(() => validateManifest({ ...manifest, routes: [{ ...manifest.routes[0], spender: addr(99n) }] })).toThrow();
  });
  it.each([
    { amount: 1001n }, { lotId: 'somebody-elses-lot' },
  ])('refuses another lot or too much input', patch => {
    expect(() => buildAction(manifest, snapshot(), lot(), { ...sale, ...patch })).toThrow();
  });

  it('unwraps WETH 1:1 without treating it as unknown profit', () => {
    const q = { ...quote('weth-eth'), quotedOut: 100n };
    const draft = buildAction(manifest, snapshot(), lot('fit', addr(8n)), { ...sale, routeId: 'weth-eth', quote: q });
    expect(draft.calls[0]).toEqual({ to: addr(8n), value: 0n, operation: 0,
      data: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [addr(17n), 100n] }) });
    const unwrap = decodeFunctionData({ abi: parseAbi(['function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])']), data: must(draft.calls[1]).data });
    expect(unwrap.args[0]).toBe(100200n);
    expect(decodeFunctionData({ abi: routerAbi, data: must(unwrap.args[1][0]) })).toEqual({ functionName: 'unwrapWETH9', args: [100n, manifest.safes.fit] });
    expect(draft.minimumOut).toBe(100n);
  });
  it('never sells the FIT Safe\'s FIT, even with an admitted FIT route: it is reserved for burn (F164 D2)', () => {
    const source = lot('fit', manifest.box0.fit);
    expect(() => buildAction(manifest, snapshot(), source,
      { kind: 'sale', routeId: 'fit-p', lotId: 'lot-1', amount: 100n, quote: quote('fit-p') })).toThrow(/reserved for burn/);
    expect(must(buildAction(manifest, snapshot(), source, { kind: 'burn', lotId: 'lot-1', amount: 100n }).calls[0]).to).toBe(manifest.box0.fit);
  });
  it('rechecks a later signing block while preserving the canonical quote block and deadline', () => {
    const s = { ...snapshot(), block: { ...snapshot().block, number: 101n, timestamp: 100050n }, quoteBlocks: [snapshot().block] };
    expect(buildAction(manifest, s, lot(), sale).minimumOut).toBe(198n);
    expect(() => buildAction(manifest, { ...s, quoteBlocks: [] }, lot(), sale)).toThrow();
  });
  it.each(['fund', 'burn'] as const)('gates %s on canonical box-0 graduation and uses only the fixed target', kind => {
    const source = lot('fit', kind === 'fund' ? zeroAddress : manifest.box0.fit);
    const request = { kind, lotId: source.id, amount: 123n };
    const result = buildAction(manifest, snapshot(), source, request);
    expect(result.calls[0]).toMatchObject({ to: kind === 'fund' ? manifest.box0.executor : manifest.box0.fit, value: kind === 'fund' ? 123n : 0n });
    for (const box0 of [{ graduated: false }, { graduated: undefined }, { failed: true }, { executor: addr(99n) }]) {
      expect(() => buildAction(manifest, { ...snapshot(), box0: { ...snapshot().box0, ...box0 } }, source, request)).toThrow();
    }
    expect(() => buildAction(manifest, { ...snapshot(), canonical: false }, source, request)).toThrow();
  });

  it('pins selectors to the frozen caller rules without editing box 0', () => {
    const source = readFileSync(new URL('../../contracts/src/box-v2/interfaces/IBoxReceiverV2.sol', import.meta.url), 'utf8');
    expect(source).toContain('Anyone: accepts only exact P');
    expect(source).toContain('function fundRoyalty(address token, uint256 amount) external payable');
    const draft = buildAction(manifest, snapshot(), lot('fit', zeroAddress), { kind: 'fund', lotId: 'lot-1', amount: 1n });
    expect(must(draft.calls[0]).data).toBe(encodeFunctionData({ abi: parseAbi(['function fundBudget() payable']), functionName: 'fundBudget' }));
  });
  it('requires pinned decimals for output assets and cannot override native ETH decimals', () => {
    const assets = { [addr(15n)]: '6', [addr(13n)]: '8', [manifest.weth]: '18', [manifest.box0.fit]: '18' };
    expect(() => validateManifest({ ...manifest, assetDecimals: assets })).not.toThrow();
    const { [addr(13n)]: omitted, ...missingOutput } = assets;
    expect(omitted).toBe('8');
    expect(() => validateManifest({ ...manifest, assetDecimals: missingOutput })).toThrow(/missing pinned asset decimals/);
    expect(() => validateManifest({ ...manifest, assetDecimals: undefined })).toThrow();
    for (const decimals of [undefined, '5', '19', '06', '1e1', 8, 8n]) {
      expect(() => validateManifest({ ...manifest, assetDecimals: { ...assets, [addr(13n)]: decimals } })).toThrow();
    }
    expect(() => validateManifest({ ...manifest, assetDecimals: { ...assets, [zeroAddress]: '6' } })).toThrow(/native ETH decimals/);
    expect(() => validateManifest({ ...manifest, assetDecimals: { ...assets, [manifest.weth]: '8' } })).toThrow(/WETH decimals/);
    expect(() => buildAction({ ...manifest, assetDecimals: assets }, snapshot(), lot(), sale)).toThrow(/decimals/);
  });
});
