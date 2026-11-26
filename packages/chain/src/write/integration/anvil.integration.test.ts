/**
 * Anvil integration (Stage C write side): the real executor (`runChainWrite`: prepare → simulate → wallet → track →
 * verify) against the real contracts, deployed by the contracts' own deploy script on a throwaway anvil, with a
 * test-only EIP-1193 wallet backed by anvil's unlocked default accounts. Every emitted event goes through the domain
 * `txReducer`; only `finalized` counts as success.
 *
 *   SH_CHAIN_WRITE_INTEGRATION=1 pnpm --filter @squarehole/chain test:integration:write
 *   (port: SH_WRITE_ANVIL_PORT, default 8552; needs Foundry and `forge build` in packages/contracts)
 *
 * Covered: createLaunch (collection, R = T) with PairCreated + registry verification; claim (R = Q, FIT) and claimAsT
 * (R = T, The Misfits) after external trades through the contracts' external swap harness; revert decoding from the
 * real contracts (CollectionTooLarge, Expired, InsufficientOutput); a nothing-to-claim refusal; wrong chain at
 * signing; a wallet rejection (4001); and a replacement (speed-up) detected by nonce.
 */
import { TX_IDLE, txReducer, type Address, type TxContext, type TxHash, type TxState } from '@squarehole/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../vitest.timeouts.mjs';
import { localChain, type WriteChain } from '../chains';
import { claimAsTCall, createLaunchCall } from '../calls';
import { prepareClaim, prepareClaimAsT, type ClaimOutcome } from '../claims';
import { parseWriteDeployment, type WriteDeployment } from '../deployment';
import type { Eip1193Request } from '../eip1193';
import { simulateWrite, type ReplacementInfo, type TrackerEnd } from '../executor';
import { createLaunchInputFromDraft, prepareCreateLaunch, type VerifiedLaunch } from '../launch';
import type { PreparedWrite } from '../prepared';
import { appPairId, readRegistryPair, registryPairId } from '../registry-reads';
import { createChainReader, type ChainReader } from '../rpc';
import { runChainWrite } from '../run';
import { anvilAccounts, anvilWallet, balanceOf, deployExternalHarness, deployWithContractsScript, externalBuy, startAnvil, type AnvilChain } from './anvil-harness';

const ENABLED = process.env.SH_CHAIN_WRITE_INTEGRATION === '1';
const PORT = Number(process.env.SH_WRITE_ANVIL_PORT ?? 8552);

interface Run<R> {
  statuses: string[];
  state: TxState;
  result: R | null;
  end: TrackerEnd | null;
  hash: TxHash | null;
  replacement: ReplacementInfo | null;
}

describe.skipIf(!ENABLED)('anvil: the real executor against the deployed contracts', () => {
  let anvil: AnvilChain;
  let deployment: WriteDeployment;
  let reader: ChainReader;
  let chain: WriteChain;
  let accounts: Address[];
  let manifest: Record<string, unknown>;
  const log: string[] = [];

  beforeAll(async () => {
    anvil = await startAnvil(PORT);
    const deployed = deployWithContractsScript(anvil.rpcUrl);
    log.push(deployed.log);
    manifest = deployed.manifest as Record<string, unknown>;
    deployment = parseWriteDeployment(manifest, 31337);
    reader = createChainReader(anvil.request);
    // 1-second blocks from here on, so "N confirmations" happen by themselves (anvil has no finality; ADR-0012).
    await anvil.request({ method: 'evm_setIntervalMining', params: [1] });
    chain = Object.freeze({ ...localChain({ rpcUrl: anvil.rpcUrl, confirmations: 2 }), pollIntervalMs: 200, receiptTimeoutMs: 30_000 });
    accounts = await anvilAccounts(anvil);
  }, shLimit(300_000));

  afterAll(async () => {
    await anvil?.stop();
    if (log.length > 0) console.warn(log.join('\n'));
  });

  /** One write through `runChainWrite`, as the app's flow runs it, with the person confirming at once. */
  function write<R>(kind: TxContext['kind'], account: Address, wallet: Eip1193Request, prepare: () => Promise<PreparedWrite<R>>, confirm: () => Promise<'send' | 'cancel'> = async () => 'send'): Promise<Run<R>> {
    const ctx: TxContext = { kind, chainId: 31337, account, deadline: null };
    let state = txReducer(TX_IDLE, { type: 'prepare', ctx, walletChainId: 31337 });
    const out: Run<R> = { statuses: [state.status], state, result: null, end: null, hash: null, replacement: null };
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const settle = () => {
        out.state = state;
        resolve(out);
      };
      runChainWrite<R>({
        reader,
        chain,
        deployment,
        wallet,
        account,
        prepare,
        signal: controller.signal,
        hooks: {
          emit: (event) => {
            const next = txReducer(state, event);
            if (next !== state) out.statuses.push(next.status);
            if (event.type === 'sign') out.hash = event.hash;
            state = next;
          },
          awaitConfirmation: confirm,
          onResult: (result) => {
            out.result = result;
          },
          onReplacement: (info) => {
            out.replacement = info;
          },
          onTrackerEnd: (end) => {
            out.end = end;
            settle();
          },
        },
      }).then((tracker) => {
        if (tracker === null) settle();
      }, reject);
    });
  }

  const account = (index: number): Address => {
    const found = accounts[index];
    if (found === undefined) throw new Error(`anvil account ${index} missing`);
    return found;
  };

  const launches = () => manifest.launches as Record<string, { pairId: string; contracts: { token: { address: Address } } }>;

  it('createLaunch: a new collection (R = T) is finalized only after PairCreated and the registry record verify', async () => {
    const creator = account(5);
    const wallet = anvilWallet(anvil, creator);
    const input = createLaunchInputFromDraft({
      schemaVersion: '1.0',
      mode: 'live',
      chainId: 31337,
      assetType: 'nft_collection',
      name: 'Anvil Orchard (local test)',
      symbol: 'ORCHT',
      quoteAddress: deployment.templates.find((t) => t.label === 'WETH')?.quote as Address,
      rewardSide: 'T',
      feePolicyId: 'BURN_NATIVE_T_ROUTE_Q_V1',
      feePolicyStatus: 'draft',
      headlineFeeTargetBps: 300,
      qProtocolShareNumerator: 1,
      qProtocolShareDenominator: 3,
      nftUnitRaw: '1000000000000000000000',
      collectionSize: '500',
      metadataManifestHash: `0x${'5a'.repeat(32)}`,
      rootTokenAddress: null,
      rootNFTAddress: null,
      externalRouteState: 'unverified',
      productionAuthorized: false,
    });
    const run = await write<VerifiedLaunch>('create_launch', creator, wallet.request, () => prepareCreateLaunch({ reader, deployment, account: creator }, input));
    expect(run.statuses).toEqual(['preparing', 'awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
    expect(run.end).toBe('finalized');
    const launch = run.result;
    expect(launch).toMatchObject({ name: 'Anvil Orchard (local test)', symbol: 'ORCHT', rewardSide: 'T', templateVersion: 1 });
    expect(launch?.appPairId).toBe(appPairId(31337, launch?.token as Address));
    // Independent check: the registry at the latest block.
    const stored = await readRegistryPair(reader, deployment, registryPairId(31337, launch?.token as Address));
    expect(stored).toMatchObject({ units: 500n, fractionsPerNft: 1_000n, converter: deployment.converter });
    expect(stored?.creator.toLowerCase()).toBe(creator.toLowerCase());
    expect(wallet.methods.filter((m) => m === 'eth_sendTransaction')).toHaveLength(1);
    expect(wallet.methods).not.toContain('eth_requestAccounts');
  }, shLimit(120_000));

  it('claim (R = Q, FIT) and claimAsT (R = T, The Misfits) after external trades through the harness', async () => {
    const [operator, holder, buyer] = [account(7), account(1), account(2)];
    const harness = await deployExternalHarness(anvil, deployment.poolManager, operator);
    const fitToken = launches().FIT?.contracts.token.address as Address;
    const misfitsToken = launches().THE_MISFITS?.contracts.token.address as Address;
    const fit = await readRegistryPair(reader, deployment, registryPairId(31337, fitToken));
    const misfits = await readRegistryPair(reader, deployment, registryPairId(31337, misfitsToken));
    if (!fit || !misfits) throw new Error('FIT / The Misfits missing from the registry');
    // holder buys first (bootstrap), buyer's later buy pays holder its share of the fee (ECO-09).
    for (const pair of [fit, misfits]) {
      await externalBuy(anvil, harness, holder, pair, 10n ** 16n);
      await externalBuy(anvil, harness, buyer, pair, 5n * 10n ** 16n);
    }

    // R = Q: claim through the ledger.
    const wallet = anvilWallet(anvil, holder);
    const wethBefore = await balanceOf(anvil, fit.quote, holder);
    const claim = await write<ClaimOutcome>('claim', holder, wallet.request, () => prepareClaim({ reader, deployment, account: holder }, fitToken));
    expect(claim.statuses.at(-1)).toBe('finalized');
    expect(claim.result?.kind).toBe('claimed_q');
    const claimed = claim.result?.kind === 'claimed_q' ? claim.result.amountQRaw : 0n;
    expect(claimed).toBeGreaterThan(0n);
    expect((await balanceOf(anvil, fit.quote, holder)) - wethBefore).toBe(claimed);

    // Claiming again: nothing to claim, refused before the wallet (simulation_failed, nothing sent).
    const again = await write<ClaimOutcome>('claim', holder, wallet.request, () => prepareClaim({ reader, deployment, account: holder }, fitToken));
    expect(again.statuses).toEqual(['preparing', 'simulation_failed']);
    expect(again.state.status === 'simulation_failed' && again.state.reason).toMatch(/nothing claimable/);

    // R = T: the whole entitlement converted with an eth_call-quoted minimum.
    const tBefore = await balanceOf(anvil, misfitsToken, holder);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    let minTOut = 0n;
    const convert = await write<ClaimOutcome>('claim', holder, wallet.request, async () => {
      const prepared = await prepareClaimAsT({ reader, deployment, account: holder }, misfitsToken, deadline);
      minTOut = prepared.quote.minTOutRaw;
      return prepared;
    });
    expect(convert.statuses).toEqual(['preparing', 'awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
    expect(convert.result?.kind).toBe('converted_to_t');
    const tOut = convert.result?.kind === 'converted_to_t' ? convert.result.tOutRaw : 0n;
    expect(tOut).toBeGreaterThanOrEqual(minTOut);
    expect(minTOut).toBeGreaterThan(0n);
    expect((await balanceOf(anvil, misfitsToken, holder)) - tBefore).toBe(tOut);
    log.push(`claim R=Q (FIT): ${claimed} raw WETH; claimAsT (The Misfits): ${tOut} raw T >= minTOut ${minTOut}`);

    // Revert decoding from the REAL converter: an expired deadline and a minimum above the quote.
    const misfitsPairId = registryPairId(31337, misfitsToken);
    const buyerQuote = await simulateWrite(reader, chain, claimAsTCall(deployment, misfitsPairId, 0n, 1n), buyer);
    expect(!buyerQuote.ok && buyerQuote.reason).toMatch(/quote deadline has passed.*\[Expired\(1\)\]/);
    const tooHigh = await simulateWrite(reader, chain, claimAsTCall(deployment, misfitsPairId, 10n ** 40n, deadline), holder);
    // holder converted everything above: its entitlement is (nearly) empty now, so either NothingToClaim or the minimum.
    expect(!tooHigh.ok && tooHigh.reason).toMatch(/NothingToClaim|InsufficientOutput/);
  }, shLimit(240_000));

  it('revert decoding from the real launcher: a collection above the template bound (CollectionTooLarge)', async () => {
    const creator = account(5);
    const call = createLaunchCall(deployment, {
      kind: 1,
      name: 'Too Large',
      symbol: 'BIG',
      units: 10_001n,
      fractionsPerNft: 1n,
      templateVersion: 1,
      payoutAsset: 0,
      baseURI: '',
      metadataManifestHash: `0x${'00'.repeat(32)}`,
    });
    const result = await simulateWrite(reader, chain, call, creator);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/10001 NFTs; this template allows at most 10000.*\[CollectionTooLarge\(10001, 10000\)\]/);
  }, shLimit(60_000));

  it('the wallet declines (4001) → rejected; the wallet on another chain at signing → invalidated; nothing is sent', async () => {
    const creator = account(6);
    const input = createLaunchInputFromDraft(
      {
        schemaVersion: '1.0',
        mode: 'live',
        chainId: 31337,
        assetType: 'token',
        name: 'Declined (local test)',
        symbol: 'NOPE',
        quoteAddress: deployment.templates.find((t) => t.label === 'WETH')?.quote as Address,
        rewardSide: 'Q',
        feePolicyId: 'BURN_NATIVE_T_ROUTE_Q_V1',
        feePolicyStatus: 'draft',
        headlineFeeTargetBps: 300,
        qProtocolShareNumerator: 1,
        qProtocolShareDenominator: 3,
        metadataManifestHash: `0x${'6b'.repeat(32)}`,
        rootTokenAddress: null,
        rootNFTAddress: null,
        externalRouteState: 'unverified',
        productionAuthorized: false,
      },
      { tokenWholeSupply: 1_000_000n },
    );
    const inner = anvilWallet(anvil, creator);
    const declining: Eip1193Request = async (args) => {
      if (args.method === 'eth_sendTransaction') throw Object.assign(new Error('User denied transaction signature.'), { code: 4001 });
      return inner.request(args);
    };
    const rejected = await write<VerifiedLaunch>('create_launch', creator, declining, () => prepareCreateLaunch({ reader, deployment, account: creator }, input));
    expect(rejected.statuses).toEqual(['preparing', 'awaiting_signature', 'rejected']);

    const otherChain: Eip1193Request = async (args) => (args.method === 'eth_chainId' ? '0xaa36a7' : inner.request(args));
    const moved = await write<VerifiedLaunch>('create_launch', creator, otherChain, () => prepareCreateLaunch({ reader, deployment, account: creator }, input));
    expect(moved.statuses).toEqual(['preparing', 'awaiting_signature', 'invalidated']);
    expect(moved.state).toMatchObject({ status: 'invalidated', cause: 'chain_changed' });
    expect(inner.methods).not.toContain('eth_sendTransaction');
  }, shLimit(120_000));

  it('replacement: a speed-up of the same call at the same nonce is detected by nonce (replaced, repriced)', async () => {
    const creator = account(4);
    const wallet = anvilWallet(anvil, creator);
    const input = createLaunchInputFromDraft(
      {
        schemaVersion: '1.0',
        mode: 'live',
        chainId: 31337,
        assetType: 'token',
        name: 'Sped Up (local test)',
        symbol: 'FAST',
        quoteAddress: deployment.templates.find((t) => t.label === 'WETH')?.quote as Address,
        rewardSide: 'Q',
        feePolicyId: 'BURN_NATIVE_T_ROUTE_Q_V1',
        feePolicyStatus: 'draft',
        headlineFeeTargetBps: 300,
        qProtocolShareNumerator: 1,
        qProtocolShareDenominator: 3,
        metadataManifestHash: `0x${'7c'.repeat(32)}`,
        rootTokenAddress: null,
        rootNFTAddress: null,
        externalRouteState: 'unverified',
        productionAuthorized: false,
      },
      { tokenWholeSupply: 1_000_000n },
    );
    // Stop mining while the "wallet" speeds the transaction up (same nonce, same call, doubled fees).
    const speedUp: Eip1193Request = async (args) => {
      if (args.method !== 'eth_sendTransaction') return wallet.request(args);
      await anvil.request({ method: 'evm_setIntervalMining', params: [0] });
      await anvil.request({ method: 'evm_setAutomine', params: [false] });
      const hash = (await wallet.request(args)) as TxHash;
      const original = (await anvil.request({ method: 'eth_getTransactionByHash', params: [hash] })) as { nonce: string; maxFeePerGas: string; maxPriorityFeePerGas: string; input: string; to: string; gas: string };
      await anvil.request({
        method: 'eth_sendTransaction',
        params: [{ from: creator, to: original.to, data: original.input, gas: original.gas, nonce: original.nonce, maxFeePerGas: `0x${(BigInt(original.maxFeePerGas) * 2n).toString(16)}`, maxPriorityFeePerGas: `0x${(BigInt(original.maxPriorityFeePerGas) * 2n + 1n).toString(16)}` }],
      });
      setTimeout(() => {
        void anvil.request({ method: 'evm_mine' }).then(() => anvil.request({ method: 'evm_setIntervalMining', params: [1] }));
      }, 1_000);
      return hash;
    };
    const run = await write<VerifiedLaunch>('create_launch', creator, speedUp, () => prepareCreateLaunch({ reader, deployment, account: creator }, input));
    expect(run.end).toBe('replaced');
    expect(run.state).toMatchObject({ status: 'replaced', hash: run.hash });
    expect(run.replacement?.kind).toBe('repriced');
    expect(run.replacement?.hash).not.toBe(run.hash);
  }, shLimit(120_000));
});
