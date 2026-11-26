/**
 * The writers end to end against a fake Square Hole deployment (offline): createLaunch from a wizard draft (template by
 * exact quote address, the template's real N bound, PairCreated decoded and checked against the registry record and
 * the token's own name/symbol at finality), claim (R = Q), claimAsT (R = T, minTOut from an eth_call quote with the
 * documented 1% tolerance, the explicit pair-id overload, deadline) and the sold-out Q fallback (offered only when the
 * converter reports conversion impossible, never automatically).
 */
import { TX_IDLE, txReducer, type Address, type LaunchDraft, type TxState } from '@squarehole/domain';
import { decodeFunctionData, toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { squareHoleClaimConverterAbi as converterAbi } from '../abi/squareHoleClaimConverter';
import { localChain } from './chains';
import { CLAIM_AS_T_TOLERANCE_BPS, prepareClaim, prepareClaimAsQWhenSoldOut, prepareClaimAsT, readConversionStatus } from './claims';
import { TxTracker, simulateWrite, submitWrite } from './executor';
import { createLaunchInputFromDraft, prepareCreateLaunch, readLaunchTemplateBounds, type CreateLaunchInput, type VerifiedLaunch } from './launch';
import { PrepareRefusal, type PreparedWrite } from './prepared';
import { createChainReader } from './rpc';
import { ACCOUNT_A, ACCOUNT_B, FakeChain, FakeWallet, revertData } from './test-support/fake-chain';
import { FAKE, FakeSquareHole } from './test-support/fake-square-hole';
import { TEST_FEE_READER } from './test-support/index';

const CHAIN = Object.freeze({ ...localChain({ confirmations: 2 }), pollIntervalMs: 1, receiptTimeoutMs: 1_000 });
const HASH32 = `0x${'44'.repeat(32)}` as Hex;

function setup() {
  const chain = new FakeChain();
  const sh = new FakeSquareHole(chain);
  const reader = createChainReader(chain.request);
  const wallet = new FakeWallet(chain, [ACCOUNT_A]);
  const ctx = { reader, deployment: sh.deployment, account: ACCOUNT_A };
  return { chain, sh, reader, wallet, ctx };
}

/** simulate → submit → track (mining a block per wait) → final reducer state and verified result. */
async function execute<R>(env: ReturnType<typeof setup>, prepared: PreparedWrite<R>): Promise<{ state: TxState; result: R | null; reason?: string }> {
  const sim = await simulateWrite(env.reader, CHAIN, prepared.call, ACCOUNT_A);
  if (!sim.ok) return { state: TX_IDLE, result: null, reason: sim.reason };
  const hash = await submitWrite({ feeReader: TEST_FEE_READER, wallet: env.wallet.request, deployment: env.sh.deployment, call: prepared.call, expectedLedger: prepared.expectedLedger, from: ACCOUNT_A, gasLimit: sim.simulation.gasLimit });
  const ctx = { kind: prepared.call.fn === 'createLaunch' ? ('create_launch' as const) : ('claim' as const), chainId: 31337, account: ACCOUNT_A, deadline: null };
  let state = txReducer(txReducer(txReducer(TX_IDLE, { type: 'prepare', ctx, walletChainId: 31337 }), { type: 'simulate_ok' }), { type: 'sign', hash });
  let result: R | null = null;
  await new Promise<void>((resolve) => {
    const tracker: TxTracker<R> = new TxTracker<R>({
      reader: env.reader,
      chain: CHAIN,
      hash,
      from: ACCOUNT_A,
      startBlock: env.chain.head.number,
      verify: prepared.verify,
      emit: (event) => {
        state = txReducer(state, event);
      },
      onResult: (value) => {
        result = value;
      },
      onEnd: () => resolve(),
      sleep: async () => {
        env.chain.mine();
      },
    });
    tracker.start();
  });
  return { state, result };
}

const collectionDraft = (overrides: Partial<LaunchDraft> = {}): LaunchDraft => ({
  schemaVersion: '1.0',
  mode: 'live',
  chainId: 31337,
  assetType: 'nft_collection',
  name: 'Orchard Test',
  symbol: 'ORCH',
  quoteAddress: FAKE.weth,
  rewardSide: 'T',
  feePolicyId: 'BURN_NATIVE_T_ROUTE_Q_V1',
  feePolicyStatus: 'draft',
  headlineFeeTargetBps: 300,
  qProtocolShareNumerator: 1,
  qProtocolShareDenominator: 3,
  nftUnitRaw: '1000000000000000000000', // r = 1,000
  collectionSize: '500',
  metadataManifestHash: HASH32,
  rootTokenAddress: null,
  rootNFTAddress: null,
  externalRouteState: 'unverified',
  productionAuthorized: false,
  ...overrides,
});

const refusal = async (promise: Promise<unknown>): Promise<PrepareRefusal> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PrepareRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('createLaunch writer', () => {
  it('from a collection draft: template by exact quote address, no value, then PairCreated + registry record verified at finality', async () => {
    const env = setup();
    const input = createLaunchInputFromDraft(collectionDraft());
    expect(input).toMatchObject({ kind: 'nft_collection', units: 500n, fractionsPerNft: 1_000n, quote: FAKE.weth, rewardSide: 'T', baseURI: '' });
    const prepared = await prepareCreateLaunch(env.ctx, input);
    expect(prepared.call).toMatchObject({ fn: 'createLaunch', to: FAKE.launcher, value: 0n });
    expect(prepared.details.map((d) => d.label)).toEqual(['Contract', 'Quote asset (Q)', 'Supply', 'Collection bound', 'Holder fee share paid in (R)', 'Purchase at creation']);
    expect(prepared.details.find((d) => d.label === 'Collection bound')?.value).toBe('500 of at most 10000 NFTs on this template');
    const { state, result } = await execute(env, prepared);
    expect(state.status).toBe('finalized');
    const launch = result as VerifiedLaunch | null;
    expect(launch).toMatchObject({ name: 'Orchard Test', symbol: 'ORCH', quote: FAKE.weth, rewardSide: 'T', templateVersion: 1 });
    expect(launch?.appPairId).toBe(`31337:${launch?.token.toLowerCase()}`);
    expect(launch?.mirror).not.toBeNull();
  });

  it('a launch or claim on a testnet mock quote (USDT-TEST) carries the mock’s disclosure before signing', async () => {
    const env = setup();
    const onMock = await prepareCreateLaunch(env.ctx, createLaunchInputFromDraft(collectionDraft({ quoteAddress: FAKE.usdtTest })));
    expect(onMock.details.find((d) => d.label === 'Testnet mock quote')?.value).toMatch(/USDT-TEST.*pause.*blacklist.*destroy.*faucet/);
    const onWeth = await prepareCreateLaunch(env.ctx, createLaunchInputFromDraft(collectionDraft()));
    expect(onWeth.details.some((d) => d.label === 'Testnet mock quote')).toBe(false);
    const pair = env.sh.addPair('Q', { quote: FAKE.usdtTest });
    env.sh.setClaimable(pair, ACCOUNT_A, 5n);
    expect((await prepareClaim(env.ctx, pair.token)).details.some((d) => d.label === 'Testnet mock quote')).toBe(true);
  });

  it('a token launch needs an explicit supply; R = Q; N bound does not apply', async () => {
    const env = setup();
    const draft = collectionDraft({ assetType: 'token', nftUnitRaw: undefined, collectionSize: undefined, rewardSide: 'Q' });
    expect(() => createLaunchInputFromDraft(draft)).toThrow(/explicit whole-token supply/);
    const input = createLaunchInputFromDraft(draft, { tokenWholeSupply: 1_000_000_000n });
    const { state, result } = await execute(env, await prepareCreateLaunch(env.ctx, input));
    expect(state.status).toBe('finalized');
    expect(result).toMatchObject({ rewardSide: 'Q', mirror: null });
  });

  it('surfaces and enforces the template’s real N bound (10,000 here), read from the registry', async () => {
    const env = setup();
    const bounds = await readLaunchTemplateBounds(env.reader, env.sh.deployment, FAKE.weth);
    expect(bounds).toMatchObject({ maxCollectionUnits: 10_000n, referenceBuyNfts: 1_000n });
    expect(bounds.template.version).toBe(1);
    const input = createLaunchInputFromDraft(collectionDraft({ nftUnitRaw: '1000000000000000000', collectionSize: '10001' }));
    const r = await refusal(prepareCreateLaunch(env.ctx, input));
    expect(r.code).toBe('bounds');
    expect(r.message).toMatch(/at most 10000 NFTs/);
  });

  it('refuses unknown/retired templates, templates outside the manifest and broken wiring before simulating', async () => {
    const input = createLaunchInputFromDraft(collectionDraft());
    let env = setup();
    env.sh.latestTemplate.set(FAKE.weth.toLowerCase(), 0);
    expect((await refusal(prepareCreateLaunch(env.ctx, input))).code).toBe('template_unknown');
    env = setup();
    env.sh.latestTemplate.set(FAKE.weth.toLowerCase(), 9);
    expect((await refusal(prepareCreateLaunch(env.ctx, input))).code).toBe('template_unknown');
    env = setup();
    const unlisted: CreateLaunchInput = { ...input, quote: '0x00000000000000000000000000000000000000ee' };
    env.sh.latestTemplate.set(unlisted.quote.toLowerCase(), 3);
    expect((await refusal(prepareCreateLaunch(env.ctx, unlisted))).code).toBe('template_unknown');
    env = setup();
    env.sh.wiring.registry = ACCOUNT_B;
    await expect(prepareCreateLaunch(env.ctx, input)).rejects.toThrow(/registry differs from the deployment manifest/);
    expect(env.wallet.sent).toEqual([]);
  });

  it('input bounds: names/symbols by the launcher’s byte limits, F08 fractions, whole supply 1 … 1e9', () => {
    expect(() => createLaunchInputFromDraft(collectionDraft({ name: 'é'.repeat(40) }))).toThrow(/at most 64 bytes/);
    expect(() => createLaunchInputFromDraft(collectionDraft({ collectionSize: '2000000', nftUnitRaw: '1000000000000000000000' }))).toThrow(/1,000,000,000/);
    expect(() => createLaunchInputFromDraft(collectionDraft({ metadataManifestHash: null }))).toThrow(/manifest hash/);
    const token = collectionDraft({ assetType: 'token', nftUnitRaw: undefined, collectionSize: undefined });
    expect(() => createLaunchInputFromDraft(token, { tokenWholeSupply: 1_000_000_001n })).toThrow(/1 … 1,000,000,000/);
  });

  it('a PairCreated that does not match the request (another quote) never finalizes', async () => {
    const env = setup();
    const prepared = await prepareCreateLaunch(env.ctx, createLaunchInputFromDraft(collectionDraft()));
    env.sh.tamper = { quote: ACCOUNT_B };
    const { state } = await execute(env, prepared);
    expect(state.status).toBe('unknown');
    expect(state.status === 'unknown' && state.reason).toMatch(/does not match the request: quote/);
  });
});

describe('claim writers', () => {
  it('R = Q: ledger.claim(account) on the registry’s ledger, verified by its Claimed event', async () => {
    const env = setup();
    const pair = env.sh.addPair('Q');
    env.sh.setClaimable(pair, ACCOUNT_A, 12_345n);
    const prepared = await prepareClaim(env.ctx, pair.token);
    expect(prepared.call).toMatchObject({ fn: 'claim', to: pair.ledger, value: 0n });
    expect(prepared.expectedLedger).toBe(pair.ledger);
    const { state, result } = await execute(env, prepared);
    expect(state.status).toBe('finalized');
    expect(result).toEqual({ kind: 'claimed_q', amountQRaw: 12_345n, quote: FAKE.weth });
  });

  it('refuses a zero entitlement, an unknown pair and the wrong payout side before any simulation', async () => {
    const env = setup();
    const q = env.sh.addPair('Q');
    const t = env.sh.addPair('T');
    expect((await refusal(prepareClaim(env.ctx, q.token))).code).toBe('nothing_to_claim');
    expect((await refusal(prepareClaim(env.ctx, ACCOUNT_B))).code).toBe('unknown_pair');
    expect((await refusal(prepareClaim(env.ctx, t.token))).code).toBe('wrong_payout_side');
    expect((await refusal(prepareClaimAsT(env.ctx, q.token, 2_000_000_000n))).code).toBe('wrong_payout_side');
    expect(env.chain.log).not.toContain('eth_estimateGas');
  });

  it('R = T: minTOut = floor(eth_call quote × 99%), the pair-id overload, the deadline passed through', async () => {
    const env = setup();
    const pair = env.sh.addPair('T');
    env.sh.setClaimable(pair, ACCOUNT_A, 1_000_003n);
    const deadline = 1_790_001_200n;
    const prepared = await prepareClaimAsT(env.ctx, pair.token, deadline);
    const quoted = (1_000_003n * 2_000n) / 1_000n;
    expect(prepared.quote).toMatchObject({ qInRaw: 1_000_003n, tOutRaw: quoted, minTOutRaw: (quoted * 9_900n) / 10_000n, toleranceBps: CLAIM_AS_T_TOLERANCE_BPS, deadline });
    expect(prepared.call.to).toBe(FAKE.converter);
    expect(prepared.call.data.slice(0, 10)).toBe(toFunctionSelector('claimAsT(bytes32,uint256,uint256)'));
    const decoded = decodeFunctionData({ abi: converterAbi, data: prepared.call.data });
    expect(decoded.args).toEqual([pair.pairId, (quoted * 9_900n) / 10_000n, deadline]);
    const { state, result } = await execute(env, prepared);
    expect(state.status).toBe('finalized');
    expect(result).toEqual({ kind: 'converted_to_t', qInRaw: 1_000_003n, tOutRaw: quoted, token: pair.token });
  });

  it('R = T: a conversion paid below the signed minimum is never reported as a success', async () => {
    const env = setup();
    const pair = env.sh.addPair('T');
    env.sh.setClaimable(pair, ACCOUNT_A, 1_000_000n);
    const prepared = await prepareClaimAsT(env.ctx, pair.token, 1_790_001_200n);
    env.sh.executionFactorMilli = 950n; // the fake pays 5% less than quoted (the real converter would revert)
    const { state } = await execute(env, prepared);
    expect(state.status).toBe('unknown');
  });

  it('R = T: a quote that reverts is refused with the decoded reason (e.g. PartialFill near sell-out)', async () => {
    const env = setup();
    const pair = env.sh.addPair('T');
    env.sh.setClaimable(pair, ACCOUNT_A, 5n);
    env.chain.reverts.set(FAKE.converter.toLowerCase(), revertData('PartialFill', [5n, 3n]));
    // isSoldOut goes through the same converter address; answer it before the revert applies.
    env.chain.reverts.delete(FAKE.converter.toLowerCase());
    const original = env.chain.request;
    env.chain.request = async (args) => {
      const params = (args.params ?? []) as { to?: string; data?: string }[];
      if (args.method === 'eth_call' && params[0]?.data?.startsWith(toFunctionSelector('claimAsT(bytes32,uint256,uint256)'))) {
        throw Object.assign(new Error('execution reverted'), { code: 3, data: revertData('PartialFill', [5n, 3n]) });
      }
      return original(args);
    };
    const r = await refusal(prepareClaimAsT({ ...env.ctx, reader: createChainReader(env.chain.request) }, pair.token, 1_790_001_200n));
    expect(r.code).toBe('quote_failed');
    expect(r.message).toMatch(/cannot convert the whole entitlement.*\[PartialFill\(5, 3\)\]/);
  });

  it('sold out: conversion is refused and names the Q fallback, which is only prepared on its own explicit request', async () => {
    const env = setup();
    const pair = env.sh.addPair('T');
    env.sh.setClaimable(pair, ACCOUNT_A, 777n);
    // Not sold out: the fallback is unavailable.
    expect((await refusal(prepareClaimAsQWhenSoldOut(env.ctx, pair.token))).code).toBe('not_sold_out');
    expect(await readConversionStatus(env.ctx, pair.token)).toEqual({ soldOut: false, claimableQRaw: 777n });
    env.sh.soldOut.add(pair.token.toLowerCase());
    const soldOut = await refusal(prepareClaimAsT(env.ctx, pair.token, 1_790_001_200n));
    expect(soldOut.code).toBe('sold_out');
    expect(soldOut.fallback).toBe('claim_as_q_when_sold_out');
    expect(soldOut.message).toMatch(/different payout.*emergency payout in Q/);
    // Refusing the conversion sent nothing and prepared no fallback on its own.
    expect(env.wallet.sent).toEqual([]);
    const fallback = await prepareClaimAsQWhenSoldOut(env.ctx, pair.token);
    expect(fallback.call.fn).toBe('claimAsQWhenSoldOut');
    expect(fallback.details.find((d) => d.label === 'Payout')?.value).toMatch(/^EMERGENCY PAYOUT IN Q, not T/);
    const { state, result } = await execute(env, fallback);
    expect(state.status).toBe('finalized');
    expect(result).toEqual({ kind: 'paid_in_q_sold_out', amountQRaw: 777n, quote: FAKE.weth });
  });

  it('every claim prepare re-checks the manifest wiring on chain first (ADR-0012 Part B §4), like createLaunch', async () => {
    for (const broken of ['registry', 'converter'] as const) {
      const env = setup();
      const q = env.sh.addPair('Q');
      const t = env.sh.addPair('T');
      env.sh.setClaimable(q, ACCOUNT_A, 5n);
      env.sh.setClaimable(t, ACCOUNT_A, 5n);
      env.sh.soldOut.add(t.token.toLowerCase());
      env.sh.wiring[broken] = ACCOUNT_B;
      await expect(prepareClaim(env.ctx, q.token)).rejects.toThrow(/differs from the deployment manifest/);
      await expect(prepareClaimAsT(env.ctx, t.token, 1_790_001_200n)).rejects.toThrow(/differs from the deployment manifest/);
      await expect(prepareClaimAsQWhenSoldOut(env.ctx, t.token)).rejects.toThrow(/differs from the deployment manifest/);
      expect(env.chain.log).not.toContain('eth_estimateGas');
    }
  });

  it('claims are sent only by the connected account and pay only it (no recipient parameter exists)', async () => {
    const env = setup();
    const pair = env.sh.addPair('Q');
    env.sh.setClaimable(pair, ACCOUNT_A, 1n);
    const prepared = await prepareClaim(env.ctx, pair.token);
    const hijacked = new FakeWallet(env.chain, [ACCOUNT_B]);
    await expect(submitWrite({ feeReader: TEST_FEE_READER, wallet: hijacked.request, deployment: env.sh.deployment, call: prepared.call, expectedLedger: prepared.expectedLedger, from: ACCOUNT_A as Address, gasLimit: 1n })).rejects.toThrow(/not the account/);
  });
});
