// @vitest-environment node
/**
 * SH-SEND-FEES fork proof: a wallet holding 0.001 SepETH creates Rent Free (the box the founder's Privy wallet could
 * not create on 2026-11-02) through the site's own create path (`prepareCreateV2`, `runCreateV2`, the executor's
 * `submitCreateWriteV2`) against an anvil fork of Sepolia. Skipped unless SH_SEND_FEES_FORK names the fork's loopback
 * URL; nothing here reaches any other host. Run by docs/evidence/SH-SEND-FEES.md's command:
 *
 *   anvil --fork-url <public Sepolia RPC> --port 8612, then
 *   SH_SEND_FEES_FORK=http://127.0.0.1:8612 SH_SEND_FEES_TIP=<the public RPC's eth_maxPriorityFeePerGas> [SH_SEND_FEES_OUT=<report file>] vitest run <this file>
 *
 * The fork answers every read the site makes, except the tip: anvil suggests at least 1 gwei whatever the chain does,
 * so the app RPC's tip read gets SH_SEND_FEES_TIP, the value Sepolia's public RPC suggested when the run started.
 * The control: the same createBox sent the way the executor sent it before (no fee fields, the node picks the cap),
 * which the fork refuses for this balance, as Privy's wallet refused the founder's.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, http, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { createChainReader, createHttpRequest, submitCreateWriteV2, type Eip1193Request } from '@squarehole/chain/write';
import { listingRegistryV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { labelCtxOf, prepareCreateV2, runCreateV2, type CreateChainV2, type CreateProgressV2 } from './create-send';
import { rpcCreateReads } from './useCreateSend';
import { sampleSpec } from './test-support/v2-fixtures';
import type { BoxSpecV2 } from './spec-types';

const FORK = process.env.SH_SEND_FEES_FORK ?? '';
const TIP = process.env.SH_SEND_FEES_TIP ?? '';
const STARTER = 10n ** 15n; // 0.001 SepETH
const SEPOLIA = 11_155_111;
const MANIFEST = JSON.parse(readFileSync(new URL('../../../../../../packages/contracts/deployments/core-v1/11155111.json', import.meta.url), 'utf8')) as {
  readonly releases: readonly { readonly factory: { readonly address: Address }; readonly listingRegistry: { readonly address: Address }; readonly implementations: { readonly coordinator: { readonly address: Address } } }[];
};

async function rpc(method: string, params: readonly unknown[] = []): Promise<unknown> {
  const response = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

describe.skipIf(FORK === '')('SH-SEND-FEES on a Sepolia fork', () => {
  it('a 0.001 SepETH wallet creates Rent Free through the site\'s create path', { timeout: shLimit(600_000) }, async () => {
    expect(new URL(FORK).hostname).toBe('127.0.0.1');
    expect(TIP).toMatch(/^0x[0-9a-f]+$/);
    const client = createPublicClient({ transport: http(FORK, { retryCount: 0, timeout: 180_000 }) });
    expect(await client.getChainId()).toBe(SEPOLIA);
    const release = MANIFEST.releases[0];
    if (!release) throw new Error('no release');
    const factory = release.factory.address;
    // The tUSDC listing (Rent Free's price coin), found in the release's listing registry.
    const registry = release.listingRegistry.address;
    const count = await client.readContract({ address: registry, abi: listingRegistryV2Abi, functionName: 'listingCount' });
    let listing: { id: number; token: Address; decimals: number; raise: bigint } | null = null;
    for (let id = 0; id < Number(count) && listing === null; id += 1) {
      const row = await client.readContract({ address: registry, abi: listingRegistryV2Abi, functionName: 'listing', args: [id] });
      if (row.token === zeroAddress) continue;
      const symbol = await client.readContract({ address: row.token, abi: erc20Abi, functionName: 'symbol' });
      if (symbol === 'tUSDC') listing = { id, token: row.token, decimals: row.decimals, raise: row.raise };
    }
    if (listing === null) throw new Error('no tUSDC listing');

    // A new wallet: 0.001 SepETH, enough tUSDC for the payment, signed for by the fork (impersonation).
    const creator = privateKeyToAccount(generatePrivateKey()).address;
    await rpc('anvil_setBalance', [creator, toHex(STARTER)]);
    await rpc('anvil_impersonateAccount', [creator]);
    await rpc('anvil_dealERC20', [creator, listing.token, toHex(10_000n * 10n ** BigInt(listing.decimals))]);

    // Rent Free's spec, as the examples kit builds it for this creator at the fork's head (read-only reads).
    const kit = (path: string) => import(/* @vite-ignore */ new URL(path, import.meta.url).href);
    const [{ loadExamples }, { prepareExample }] = await Promise.all([
      kit('../../../../../../packages/box-spec/examples/v2/registry.mjs') as Promise<{ loadExamples: () => { id: string }[] }>,
      kit('../../../../../../packages/chain/scripts/create-example-v2.mjs') as Promise<{ prepareExample: (...args: unknown[]) => Promise<{ spec: BoxSpecV2 }> }>,
    ]);
    const example = loadExamples().find((entry) => entry.id === 'rent-free');
    // Its open art's commitments (the trait table the chunk steps load, and the roots) as the site's own builder makes
    // them for a collection; the kit keeps Rent Free's pictures, not their commitments.
    const art = sampleSpec();
    expect(art.artMode).toBe(1);
    const commitments = { metadataTable: art.metadataTable, revealRoot: art.revealRoot, generatorHash: art.generatorHash, revealListId: art.revealListId };
    const { spec } = await prepareExample(example, { creator, factory, listingId: String(listing.id), art: commitments }, { chainId: String(SEPOLIA), client, log: () => undefined });

    // The site's create path: reads over the fork; the executor's fee and funds reads over the same RPC, with the tip
    // the public RPC suggested.
    // A fork reads cold state from the public RPC: a createBox estimate can take longer than viem's 10 s default.
    const forkRequest = createHttpRequest(FORK, { timeoutMs: 180_000 });
    const appRpc: Eip1193Request = async (request) => (request.method === 'eth_maxPriorityFeePerGas' ? TIP : forkRequest(request));
    const slow = createPublicClient({ transport: http(FORK, { retryCount: 0, timeout: 180_000 }) });
    const reads = { ...rpcCreateReads(FORK, 250), feeReader: createChainReader(appRpc),
      estimateGas: (r: { account: Address; to: Address; data: Hex; value: bigint }) => slow.estimateGas({ account: r.account, to: r.to, data: r.data, value: r.value }) };
    const chain: CreateChainV2 = { chainId: SEPOLIA, factory, listingRegistry: registry, coordinatorImplementation: release.implementations.coordinator.address, maxTxGas: 16_777_216n };
    const sent: Record<string, string>[] = [];
    const wallet: Eip1193Request = async ({ method, params }) => {
      if (method === 'eth_chainId') return toHex(SEPOLIA);
      if (method === 'eth_accounts') return [creator];
      if (method !== 'eth_sendTransaction') throw new Error(`the test wallet does not answer ${method}`);
      const tx = (params as Record<string, string>[])[0] ?? {};
      sent.push(tx);
      return rpc('eth_sendTransaction', [tx]);
    };
    const run = await prepareCreateV2(reads, chain, spec, creator);

    // Control: createBox as the executor sent it before SH-SEND-FEES (no fee fields): the node picks its own cap and
    // refuses the 0.001 SepETH wallet. Its estimate is the step's gas limit the site would use.
    const before = { ...run };
    const progress0: CreateProgressV2[] = [];
    let control: string | null = null;
    const spends: bigint[] = [];
    let gasUsed = 0n;
    const ended = await runCreateV2(run, {
      reads, chain, ctx: labelCtxOf(spec, [{ symbol: 'tUSDC', decimals: listing.decimals, token: listing.token }]),
      submit: async (options) => {
        if (options.call.to.toLowerCase() === factory.toLowerCase() && control === null) {
          try {
            await rpc('eth_sendTransaction', [{ from: creator, to: options.call.to, data: options.call.data, value: toHex(options.call.value), gas: toHex(options.gasLimit), chainId: toHex(SEPOLIA) }]);
            control = 'sent';
          } catch (error) {
            control = error instanceof Error ? error.message : String(error);
          }
        }
        const balance = await client.getBalance({ address: creator });
        const hash = await submitCreateWriteV2({ ...options, wallet, createOptionsCheck: async () => undefined });
        const receipt = await client.waitForTransactionReceipt({ hash: hash as Hex });
        gasUsed += receipt.gasUsed;
        spends.push(balance - await client.getBalance({ address: creator }));
        return hash;
      },
      onRun: () => undefined,
      onProgress: (progress) => { progress0.push(progress); },
      stopped: () => false,
    });
    expect(before.coordinator).toBe(run.coordinator);
    expect(ended).toBe('done');
    expect(await client.getCode({ address: run.coordinator })).not.toBe('0x');
    expect(control).toMatch(/insufficient funds|lack of funds|funds/i);
    for (const tx of sent) {
      expect(tx).toHaveProperty('maxFeePerGas');
      expect(tx).toHaveProperty('maxPriorityFeePerGas');
      expect(tx).not.toHaveProperty('gasPrice');
    }
    const left = await client.getBalance({ address: creator });
    const block = await client.getBlock();
    const report = JSON.stringify({
      forkBlock: block.number.toString(), baseFeePerGas: block.baseFeePerGas?.toString(), tipSuggested: BigInt(TIP).toString(), listing: listing.id,
      coordinator: run.coordinator, steps: progress0.at(-1)?.steps.map((step) => step.call.kind),
      sends: sent.map((tx) => ({ to: tx.to, gas: BigInt(tx.gas ?? '0').toString(), maxFeePerGas: BigInt(tx.maxFeePerGas ?? '0').toString(), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas ?? '0').toString(), reserve: (BigInt(tx.gas ?? '0') * BigInt(tx.maxFeePerGas ?? '0')).toString() })),
      gasUsed: gasUsed.toString(), spentWei: spends.map(String), startWei: STARTER.toString(), leftWei: left.toString(), control,
    }, null, 1);
    // The run's numbers, for the evidence file (SH_SEND_FEES_OUT names a file outside the repository).
    if (process.env.SH_SEND_FEES_OUT) writeFileSync(process.env.SH_SEND_FEES_OUT, `${report}\n`);
  });
});
