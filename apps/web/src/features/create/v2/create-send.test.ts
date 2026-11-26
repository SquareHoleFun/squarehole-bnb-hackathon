/**
 * TA-22: the real Create's step machine against an in-memory chain. Every send goes through the executor's creation
 * entry point (`submitCreateWriteV2`) and a recording wallet, so these tests also pin the allowlist wiring: what the
 * wallet sees is only ever a step of the plan, in order, and a mined step is never sent again.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, erc721Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { NotSendableError, WalletRejectedError, submitCreateWriteV2 } from '@squarehole/chain/write';
import { factoryV2Abi, pileVaultV2Abi, shopConfigV2, starterCommitmentV2, starterSetLoaderV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { required } from '../../core/v2/test-support/required';
import {
  CreateRefusal, STARTERS_NOT_THIS_BOX, labelCtxOf, labelledSteps, planOfRun, prepareCreateV2, readProgressV2, runCreateV2, sameRun, type CreateReadsV2, type CreateRunV2,
} from './create-send';
import { OWNER } from '../test-support/fixtures';
import { CHAIN, COORDINATOR, LOADER, Q, VAULT, addr, config, fakeChain, kinds, nftApproval, pileAmount, pileAsset, setup } from './test-support/create-send-fake';
import { encodeBoxSpecV2 } from './spec-types';
import { DEMO_LISTINGS, NATIVE_TOKEN, listingFor } from './listings';
import { starterItemsOf, type ShopChoice, type ShopCurator } from './shop';

describe('TA-22 prepare', () => {
  it('pins the listing, the bootstrap and the salts for this creator and spec', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    expect(run).toMatchObject({ chainId: 31337, creator: OWNER, factory: CHAIN.factory, coordinator: COORDINATOR, bootstrapQ: Q.toString(), sent: {} });
    expect(run.encoded).toBe(encodeBoxSpecV2(spec));
    expect(sameRun(run, 31337, OWNER, spec)).toBe(true);
    expect(sameRun(run, 31337, OWNER, { ...spec, tokenName: 'Other' })).toBe(false);
    // The hook salt meets the release's flag mask (TA-21), found for the predicted coordinator.
    expect(fake.wallet).not.toHaveBeenCalled();
  });
  it('refuses a changed listing, another chain, or another chunk size before any wallet request', async () => {
    const { spec, fake } = setup('depth-reward');
    fake.state.listingRaise = spec.raise + 1n;
    await expect(prepareCreateV2(fake.reads, CHAIN, spec, OWNER)).rejects.toMatchObject({ code: 'listing-changed' });
    await expect(prepareCreateV2(fake.reads, { ...CHAIN, chainId: 11155111 }, spec, OWNER)).rejects.toMatchObject({ code: 'wrong-chain' });
    const read = fake.reads.read;
    const small: CreateReadsV2 = { ...fake.reads, read: async (a, abi, fn, args, block) => (fn === 'CHUNK_MAX' ? 4096n : read(a, abi, fn, args, block)) };
    fake.state.listingRaise = spec.raise;
    await expect(prepareCreateV2(small, CHAIN, spec, OWNER)).rejects.toMatchObject({ code: 'chunk-size' });
    expect(fake.wallet).not.toHaveBeenCalled();
  });
});

describe('TA-22 the step machine', () => {
  it('an ERC-20 price coin: the exact approval, createBox, then its chunk; done', async () => {
    const { spec, fake, hooks, stored } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
    expect(decodeFunctionData({ abi: erc20Abi, data: fake.sent[0]?.data ?? '0x' }).args).toEqual([CHAIN.factory, Q + spec.creatorBuy]);
    expect(decodeFunctionData({ abi: factoryV2Abi, data: fake.sent[1]?.data ?? '0x' }).functionName).toBe('createBox');
    expect(Object.keys(stored()?.sent ?? {})).toEqual(['approve', 'createBox', 'chunk-1-0']);
  });
  it('Stop after a step ends the run; Continue sends only what the chain does not hold', async () => {
    const { spec, fake, hooks, stored } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    let stop = false;
    const first = hooks(() => stop);
    await expect(runCreateV2(run, { ...first, onRun: (r) => { first.onRun(r); stop = true; } })).resolves.toBe('stopped');
    expect(kinds(fake)).toEqual(['approve']);
    // A fresh page: no hash kept, the allowance on chain is what says the approval is done.
    await expect(runCreateV2({ ...run, sent: {} }, hooks())).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
    expect(stored()?.sent.createBox).toBeDefined();
  });
  it('Fix round 1: Stop pressed while the step’s gas is estimated sends nothing; Continue then sends it', async () => {
    const { spec, fake, hooks } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    let stop = false;
    let estimating!: () => void;
    const estimated = new Promise<void>((resolve) => { estimating = resolve; });
    let release!: (gas: bigint) => void;
    const reads: CreateReadsV2 = { ...fake.reads, estimateGas: () => { estimating(); return new Promise<bigint>((resolve) => { release = resolve; }); } };
    const ended = runCreateV2(run, { ...hooks(() => stop), reads });
    await estimated;
    stop = true;
    release(1_000_000n);
    await expect(ended).resolves.toBe('stopped');
    expect(fake.wallet.mock.calls.filter(([request]) => request.method === 'eth_sendTransaction')).toEqual([]);
    expect(fake.sent).toEqual([]);
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
  });
  it('a declined step stops the run; Continue resends that step only, never the mined approval', async () => {
    const { spec, fake, hooks } = setup('depth-reward', {}, { firstIn: '100' });
    let run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    const keep = { ...hooks(), onRun: (r: CreateRunV2) => { run = r; } };
    // Approve goes through; createBox is declined in the wallet.
    const reject = { ...keep, submit: async (o: Parameters<typeof keep.submit>[0]) => { if (o.call.to === CHAIN.factory) fake.rejectNext = true; return keep.submit(o); } };
    await expect(runCreateV2(run, reject)).rejects.toBeInstanceOf(WalletRejectedError);
    expect(kinds(fake)).toEqual(['approve']);
    await expect(runCreateV2(run, keep)).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
  });
  it('a step that reverted stops with a refusal; the next press may send it again', async () => {
    const { spec, fake, hooks } = setup('rug-rugs');
    let run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    const keep = { ...hooks(), onRun: (r: CreateRunV2) => { run = r; } };
    fake.revertNext = true;
    await expect(runCreateV2(run, keep)).rejects.toMatchObject({ code: 'reverted' });
    expect(fake.state.created).toBe(false);
    await expect(runCreateV2(run, keep)).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['createBox', 'createBox']);
  });
  it('a hash the node still holds is waited for, never sent again', async () => {
    const { spec, fake, hooks } = setup('rug-rugs');
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    fake.holdNext = true;
    let kept = run;
    const interrupted = { ...hooks(), onRun: (r: CreateRunV2) => { kept = r; throw new Error('tab closed'); } };
    await expect(runCreateV2(run, interrupted)).rejects.toThrow('tab closed');
    expect(kinds(fake)).toEqual(['createBox']);
    // The receipt is still missing; the hash is kept, so Continue waits for it and sends nothing.
    await expect(runCreateV2(kept, hooks())).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['createBox']);
  });
  it('a collection loads its chunks; after a failure the chain’s chunk count says where to go on', async () => {
    const { spec, hooks } = setup('gas-guzzlers');
    const big = { ...spec, metadataTable: `0x${'ab'.repeat(20_000)}` as Hex };
    const chain = fakeChain(big);
    const run = await prepareCreateV2(chain.reads, CHAIN, big, OWNER);
    const base = hooks();
    const h = { ...base, reads: chain.reads, submit: (o: Parameters<typeof base.submit>[0]) => submitCreateWriteV2({ ...o, wallet: chain.wallet, createOptionsCheck: async () => undefined }) };
    let calls = 0;
    const failing = { ...h, submit: async (o: Parameters<typeof h.submit>[0]) => { calls += 1; if (calls === 3) chain.rejectNext = true; return h.submit(o); } };
    await expect(runCreateV2(run, failing)).rejects.toBeInstanceOf(WalletRejectedError);
    expect(kinds(chain)).toEqual(['createBox', 'loadChunk']);
    const progress = await readProgressV2(chain.reads, run, h.ctx);
    expect(progress.steps.map((s) => s.label)).toEqual(['Create the box', 'Load items 1/3', 'Load items 2/3', 'Load items 3/3']);
    expect(progress.done).toEqual([true, true, false, false]);
    await expect(runCreateV2(run, h)).resolves.toBe('done');
    expect(kinds(chain)).toEqual(['createBox', 'loadChunk', 'loadChunk', 'loadChunk']);
  });
  it('a pile seeded in another coin: its later steps are listed before creation, then approved and pulled', async () => {
    const { spec, fake, hooks, ctx } = setup('dragons-hoard');
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    const before = await readProgressV2(fake.reads, run, ctx);
    expect(before.steps.map((s) => s.label)).toEqual(['Create the box']);
    expect(before.later).toEqual(['Approve the seed · 1000 USDC', 'Load the pile']);
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['createBox', 'approve', 'loadSeed']);
    expect(decodeFunctionData({ abi: erc20Abi, data: fake.sent[1]?.data ?? '0x' }).args).toEqual([VAULT, pileAmount(spec)]);
    expect(fake.sent[1]?.to.toLowerCase()).toBe(listingFor(pileAsset(spec), DEMO_LISTINGS).token.toLowerCase());
    expect(decodeFunctionData({ abi: pileVaultV2Abi, data: fake.sent[2]?.data ?? '0x' }).functionName).toBe('loadSeed');
  });
  it('another box at the predicted address is refused before any send', async () => {
    const { spec, fake, hooks } = setup('rug-rugs');
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    fake.state.created = true;
    fake.state.otherSpec = true;
    await expect(runCreateV2(run, hooks())).rejects.toBeInstanceOf(CreateRefusal);
    expect(fake.sent).toEqual([]);
  });
  it('the wallet never sees a call the guard does not admit', async () => {
    const { spec, fake, hooks } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    const h = hooks();
    const tampered = { ...h, submit: (o: Parameters<typeof h.submit>[0]) => h.submit({ ...o, call: { ...o.call, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [addr(0xbadn), 1n << 255n] }) } }) };
    await expect(runCreateV2(run, tampered)).rejects.toBeInstanceOf(NotSendableError);
    expect(fake.wallet).not.toHaveBeenCalled();
    expect(labelledSteps(planOfRun(run), h.ctx).map((s) => s.label)).toEqual(['Approve 101 USDC', 'Create the box', 'Load items 1/1']);
  });
  it('labels a stored run by its own spec’s coins, not the page’s current price coin (a reload resets the choices)', async () => {
    const { spec, fake } = setup('dragons-hoard', { pricing: DEMO_LISTINGS.find((l) => l.symbol === 'LINK')?.token ?? '' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    const ctx = labelCtxOf(spec, DEMO_LISTINGS);
    expect([ctx.pricing.symbol, ctx.seed?.symbol, ctx.ticker]).toEqual(['LINK', 'USDC', 'HOARD']);
    const progress = await readProgressV2(fake.reads, run, ctx);
    expect(progress.steps.map((s) => s.label)).toEqual([expect.stringMatching(/^Approve [0-9.]+ LINK$/), 'Create the box']);
    expect(progress.later).toEqual(['Approve the seed · 1000 USDC', 'Load the pile']);
    expect(labelCtxOf(spec, []).pricing.decimals).toBe(0);
  });
});

/**
 * SH-ARWEAVE-PICTURES-WEB fix round 1 (F1, integrator decision): the box's pictures go to Arweave before the createBox
 * transaction makes their hashes public. The run calls `beforeWallet` once, after it has read the chain and before its
 * first wallet request while the chain does not show the box created; false stops the run there with nothing sent.
 */
describe('fix round 1: the pictures before the wallet', () => {
  const sends = (fake: ReturnType<typeof setup>['fake']) => fake.wallet.mock.calls.filter(([request]) => request.method === 'eth_sendTransaction').length;
  it('once, before the first wallet request (the approval here), never again in that run; then every step', async () => {
    const { spec, fake, hooks } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    const seen: number[] = [];
    const beforeWallet = async () => { seen.push(sends(fake)); return true; };
    await expect(runCreateV2(run, { ...hooks(), beforeWallet })).resolves.toBe('done');
    expect(seen).toEqual([0]);
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
  });
  it('false: the run stops there, nothing sent; the next press goes on', async () => {
    const { spec, fake, hooks } = setup('rug-rugs');
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    const h = hooks();
    await expect(runCreateV2(run, { ...h, beforeWallet: async () => false })).resolves.toBe('stopped');
    expect(fake.sent).toEqual([]);
    expect(fake.wallet).not.toHaveBeenCalled();
    expect(h.onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ done: [false] }), null);
    await expect(runCreateV2(run, { ...hooks(), beforeWallet: async () => true })).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['createBox']);
  });
  it('Stop pressed while the pictures publish: nothing is sent', async () => {
    const { spec, fake, hooks } = setup('rug-rugs');
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    let stop = false;
    await expect(runCreateV2(run, { ...hooks(() => stop), beforeWallet: async () => { stop = true; return true; } })).resolves.toBe('stopped');
    expect(fake.sent).toEqual([]);
  });
  it('not asked once the chain shows the box created (its hashes are public already): the chunks go on', async () => {
    const { spec, fake, hooks } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    let stop = false;
    const first = hooks(() => stop);
    await expect(runCreateV2(run, { ...first, onRun: (r) => { first.onRun(r); if (r.sent.createBox) stop = true; } })).resolves.toBe('stopped');
    expect(kinds(fake)).toEqual(['approve', 'createBox']);
    let asked = 0;
    await expect(runCreateV2(run, { ...hooks(), beforeWallet: async () => { asked += 1; return false; } })).resolves.toBe('done');
    expect(asked).toBe(0);
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
  });
  // Merged with SH-SHOP-CREATE: the pictures go after every check the first wallet request goes through.
  it('a shop: the press reads who holds every starter item first; one no longer the creator\u2019s stops the run before any publish', async () => {
    const shop: ShopChoice = { ...required(config('curio-corner').shop), curator: 'none', collections: [
      { address: '0x00000000000000000000000000000000000000a1', tier: 0, ids: '1-10' }, { address: '0x00000000000000000000000000000000000000b2', tier: 2, ids: '' }] };
    const made = setup('curio-corner', { pricing: NATIVE_TOKEN, shop });
    const run = await prepareCreateV2(made.fake.reads, CHAIN, made.spec, OWNER, required(starterItemsOf(shop)));
    made.fake.state.owners.set('0x00000000000000000000000000000000000000a1:3', addr(0xbeefn));
    let asked = 0;
    await expect(runCreateV2(run, { ...made.hooks(), beforeWallet: async () => { asked += 1; return true; } })).rejects.toMatchObject({ message: 'Not in your wallet: 1 starter item' });
    expect(asked).toBe(0);
    expect(made.fake.sent).toEqual([]);
    // Every item the creator's again: the pictures go, then the wallet.
    made.fake.state.owners.set('0x00000000000000000000000000000000000000a1:3', OWNER);
    const seen: number[] = [];
    await expect(runCreateV2(run, { ...made.hooks(), beforeWallet: async () => { seen.push(made.fake.sent.length); return true; } })).resolves.toBe('done');
    expect(seen).toEqual([0]);
  });
  it('a box too heavy to create (its estimate refuses it) publishes nothing', async () => {
    const { spec, fake, hooks } = setup('rug-rugs');
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    const reads: CreateReadsV2 = { ...fake.reads, estimateGas: async () => 1n << 40n };
    let asked = 0;
    await expect(runCreateV2(run, { ...hooks(), reads, beforeWallet: async () => { asked += 1; return true; } })).rejects.toMatchObject({ code: 'too-heavy' });
    expect(asked).toBe(0);
    expect(fake.sent).toEqual([]);
  });
});

describe('SH-SHOP-CREATE a shop with starter items and no curator', () => {
  /** A step call on its way to the creation sender is a starter item's approval (the plan's step keeps its kind). */
  const isStarterApproval = (call: object): boolean => 'kind' in call && call.kind === 'approveStarter';
  const A1 = '0x00000000000000000000000000000000000000a1';
  const B2 = '0x00000000000000000000000000000000000000b2';
  /** Curio Corner's shop priced in ETH, with starter ids typed for both its collections (ten in all by default). */
  const starterShop = (ids: readonly [string, string] = ['1-6', '7, 8, 9, 10'], curator: ShopCurator = 'none'): ShopChoice =>
    ({ ...required(config('curio-corner').shop), curator, collections: [{ address: A1, tier: 0, ids: ids[0] }, { address: B2, tier: 2, ids: ids[1] }] });
  const shopRun = async (shop: ShopChoice = starterShop()) => {
    const made = setup('curio-corner', { pricing: NATIVE_TOKEN, shop });
    const items = required(starterItemsOf(shop));
    return { ...made, items, run: await prepareCreateV2(made.fake.reads, CHAIN, made.spec, OWNER, items) };
  };
  const TEN_APPROVALS = Array.from({ length: 10 }, (_, i) => `Approve starter ${i + 1}/10`);

  it('lists its starter steps before Create, then approves each item to the created shop and loads the page before the seed', async () => {
    const { spec, fake, hooks, ctx, items, run, stored } = await shopRun();
    expect(shopConfigV2(spec.contentsParams).curator).toBe('0x0000000000000000000000000000000000000000');
    expect(starterCommitmentV2(spec)?.count).toBe(10);
    expect(run.starters).toEqual(items.map((item) => ({ collection: item.collection, id: String(item.id), tier: item.tier })));
    const before = await readProgressV2(fake.reads, run, ctx);
    expect(before.steps.map((s) => s.label)).toEqual(['Create the box']);
    expect(before.later).toEqual([...TEN_APPROVALS, 'Load starter items 1/1', 'Approve the seed · 1000 CURIO', 'Fund the shop', 'Open the shop']);
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['createBox', ...Array(10).fill('approve'), 'loadStarter', 'approve', 'fundSeed', 'complete']);
    // Each approval is exactly approve(shop, id) on the item's own collection, in add-on 8's order.
    expect(fake.sent.slice(1, 11).map((call) => [call.to.toLowerCase(), ...nftApproval(call)])).toEqual(items.map((item) => [item.collection.toLowerCase(), VAULT, item.id]));
    // The page: StarterSetLoaderV2.load of all ten at role 19, the terminal hash last; the items are the shop's now.
    const page = decodeFunctionData({ abi: starterSetLoaderV2Abi, data: required(fake.sent[11]).data });
    expect([fake.sent[11]?.to, page.functionName, page.args?.[1], page.args?.[3]]).toEqual([LOADER, 'load', items.map((item) => item.id), `0x${'00'.repeat(32)}`]);
    expect(fake.state.starterLoaded).toBe(10);
    expect(items.every((item) => fake.state.owners.get(`${item.collection.toLowerCase()}:${item.id}`) === VAULT)).toBe(true);
    // The seed's approval is on the box token, after the items, for the exact seed.
    expect(decodeFunctionData({ abi: erc20Abi, data: required(fake.sent[12]).data }).args).toEqual([VAULT, 1000n * 10n ** 18n]);
    expect(Object.keys(stored()?.sent ?? {})).toEqual(['createBox', ...items.map((_, i) => `approve-starter-${i}`), 'starter-0', 'approveSeed', 'fundSeed', 'complete']);
    const after = await readProgressV2(fake.reads, run, ctx);
    expect(after.steps.map((s) => s.label)).toEqual(['Create the box', ...TEN_APPROVALS, 'Load starter items 1/1', 'Approve the seed · 1000 CURIO', 'Fund the shop', 'Open the shop']);
    expect(after.done.every(Boolean)).toBe(true);
  });

  it('after a stop the chain says which items are approved: Continue never approves one twice', async () => {
    const { fake, hooks, run } = await shopRun();
    let sends = 0;
    let stop = false;
    const first = hooks(() => stop);
    await expect(runCreateV2(run, { ...first, onRun: (r) => { first.onRun(r); sends += 1; stop = sends >= 5; } })).resolves.toBe('stopped');
    expect(kinds(fake)).toEqual(['createBox', 'approve', 'approve', 'approve', 'approve']);
    // A fresh page: no hash kept, each item's approval on chain says what is done.
    await expect(runCreateV2({ ...run, sent: {} }, hooks())).resolves.toBe('done');
    const approvals = fake.sent.filter((call) => call.to.toLowerCase() === A1 || call.to.toLowerCase() === B2).map((call) => `${call.to.toLowerCase()}:${nftApproval(call)[1]}`);
    expect(approvals).toHaveLength(10);
    expect(new Set(approvals).size).toBe(10);
    expect(kinds(fake).slice(-4)).toEqual(['loadStarter', 'approve', 'fundSeed', 'complete']);
  });

  // XR-SH-SHOP-CREATE F2 (fix round 1): each press reads every starter item not yet pulled, fresh, before any new
  // wallet request; the page's own check may be old.
  it('an item that left the wallet after the page’s check stops Create before any wallet request, with the count', async () => {
    const { fake, hooks, run } = await shopRun();
    fake.state.owners.set(`${A1}:3`, addr(0xbeefn));
    fake.state.owners.set(`${B2}:9`, addr(0xbeefn));
    await expect(runCreateV2(run, hooks())).rejects.toMatchObject({ code: 'refused', message: 'Not in your wallet: 2 starter items' });
    expect(kinds(fake)).toEqual([]);
    expect(fake.wallet).not.toHaveBeenCalled();
  });

  it('Continue reads again: an item that left after a stop holds the run before any new request; pulled items are not asked', async () => {
    const { fake, hooks, run } = await shopRun(starterShop(['1-20', '21-33']));
    let sends = 0;
    let stop = false;
    const first = hooks(() => stop);
    // Stop once the first page is in: createBox, 32 approvals and the page.
    await expect(runCreateV2(run, { ...first, onRun: (r) => { first.onRun(r); sends += 1; stop = sends >= 34; } })).resolves.toBe('stopped');
    expect(fake.state.starterLoaded).toBe(32);
    const sent = fake.sent.length;
    // Item 33 (id 33 of b2) leaves the wallet; the 32 the shop holds now are never asked again.
    fake.state.owners.set(`${B2}:33`, addr(0xbeefn));
    const read = fake.reads.read;
    const asked: string[] = [];
    const counting = { ...fake.reads, read: async (...args: Parameters<typeof read>) => { if (args[2] === 'ownerOf') asked.push(String(args[3]?.[0])); return read(...args); } };
    await expect(runCreateV2({ ...run, sent: {} }, { ...hooks(), reads: counting })).rejects.toMatchObject({ code: 'refused', message: 'Not in your wallet: 1 starter item' });
    expect(fake.sent.length).toBe(sent);
    expect(asked).toEqual(['33']);
    // Back in the wallet: Continue goes on from the chain's state.
    fake.state.owners.set(`${B2}:33`, OWNER);
    await expect(runCreateV2({ ...run, sent: {} }, hooks())).resolves.toBe('done');
    expect(kinds(fake).slice(sent)).toEqual(['approve', 'loadStarter', 'approve', 'fundSeed', 'complete']);
  });

  // XR-SH-SHOP-CREATE-R2 F2 (fix round 2): a burned item's getApproved reverts as its ownerOf does; Continue after a
  // loaded page still reads that item's owner and says how many are missing, never "could not be read".
  it('Continue after a loaded page: a burned remaining item is counted, though its getApproved reverts too', async () => {
    const { fake, hooks, run, stored } = await shopRun(starterShop(['1-33', '']));
    await expect(runCreateV2(run, hooks(() => fake.state.starterLoaded === 32))).resolves.toBe('stopped');
    expect(fake.state.starterLoaded).toBe(32);
    const before = kinds(fake);
    fake.state.burned.add(`${A1}:33`);
    const read = fake.reads.read;
    const asked: string[] = [];
    const reverted: string[] = [];
    const watching = { ...fake.reads, read: async (...args: Parameters<typeof read>) => {
      if (args[2] === 'ownerOf') asked.push(String(args[3]?.[0]));
      try { return await read(...args); } catch (error) { reverted.push(`${String(args[2])}:${String(args[3]?.[0])}`); throw error; }
    } };
    const failure = await runCreateV2(required(stored()), { ...hooks(), reads: watching }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'refused', message: 'Not in your wallet: 1 starter item' });
    expect(reverted).toEqual(['getApproved:33', 'ownerOf:33']);
    expect(asked).toEqual(['33']);
    expect(kinds(fake)).toEqual(before);
  });

  it('every item is read in batches of at most 16; a read the chain does not answer sends nothing; a burned item is missing', async () => {
    const { fake, hooks, run } = await shopRun(starterShop(['1-20', '21-40']));
    const read = fake.reads.read;
    let open = 0; let most = 0;
    const batched = { ...fake.reads, read: async (...args: Parameters<typeof read>) => {
      if (args[2] !== 'ownerOf') return read(...args);
      open += 1; most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 1));
      open -= 1;
      return read(...args);
    } };
    fake.state.owners.set(`${A1}:20`, addr(0xbeefn));
    await expect(runCreateV2(run, { ...hooks(), reads: batched })).rejects.toMatchObject({ message: 'Not in your wallet: 1 starter item' });
    expect(most).toBe(16);
    fake.state.owners.set(`${A1}:20`, OWNER);
    // An RPC that does not answer one item: the run stops, nothing is sent (fail closed).
    const down = { ...fake.reads, read: async (...args: Parameters<typeof read>) => { if (args[2] === 'ownerOf' && args[3]?.[0] === 7n) throw new Error('RPC down'); return read(...args); } };
    await expect(runCreateV2(run, { ...hooks(), reads: down })).rejects.toThrow('RPC down');
    // An item the collection no longer has (ownerOf reverts) is missing, not unknown.
    fake.state.burned.add(`${A1}:5`);
    await expect(runCreateV2(run, hooks())).rejects.toMatchObject({ message: 'Not in your wallet: 1 starter item' });
    expect(fake.wallet).not.toHaveBeenCalled();
  });

  it('during the run each approval and page still checks its own items: one that leaves mid-run stops before its approval', async () => {
    const { fake, hooks, run } = await shopRun();
    const h = hooks();
    let approvals = 0;
    // SH-STARTER-GUARD: the approvals go through the creation sender like every step; count only theirs.
    const moving = { ...h, submit: async (o: Parameters<typeof h.submit>[0]) => {
      const hash = await h.submit(o);
      if (isStarterApproval(o.call)) {
        approvals += 1;
        if (approvals === 2) fake.state.owners.set(`${A1}:5`, addr(0xbeefn));
      }
      return hash;
    } };
    await expect(runCreateV2(run, moving)).rejects.toMatchObject({ code: 'refused', message: 'Not in your wallet: 1 starter item' });
    expect(kinds(fake)).toEqual(['createBox', 'approve', 'approve', 'approve', 'approve']);
    expect(fake.sent.slice(1).map((call) => nftApproval(call)[1])).toEqual([1n, 2n, 3n, 4n]);
  });

  it('the run’s items are the spec’s: other items, none, or items for a box that is no shop are refused before any send', async () => {
    const { spec, fake, items } = await shopRun();
    const other = required(starterItemsOf(starterShop(['1-5', '6-10'])));
    for (const given of [other, [], items.slice(1), [...items].reverse()]) {
      await expect(prepareCreateV2(fake.reads, CHAIN, spec, OWNER, given)).rejects.toMatchObject({ code: 'refused', message: STARTERS_NOT_THIS_BOX });
    }
    const token = setup('rug-rugs');
    await expect(prepareCreateV2(token.fake.reads, CHAIN, token.spec, OWNER, items)).rejects.toMatchObject({ code: 'refused', message: STARTERS_NOT_THIS_BOX });
    expect(fake.wallet).not.toHaveBeenCalled();
  });

  // SH-STARTER-GUARD: a starter item's approval is a step of the creation plan, so the creation guard admits only the
  // committed item, to this box's shop; anything else is refused before the wallet sees it.
  it('a starter item’s approval goes only through the creation guard, exactly as the plan commits it', async () => {
    const { fake, hooks, run } = await shopRun();
    const h = hooks();
    /** The run with its first starter approval changed by `change` on its way to the creation sender. */
    const tampered = (change: (call: Parameters<typeof h.submit>[0]['call']) => Parameters<typeof h.submit>[0]['call']) => ({ ...h,
      submit: (o: Parameters<typeof h.submit>[0]) => h.submit(isStarterApproval(o.call) ? { ...o, call: change(o.call) } : o) });
    const approve = (spender: Address, id: bigint) => encodeFunctionData({ abi: erc721Abi, functionName: 'approve', args: [spender, id] });
    // An id the plan does not commit, on a listed collection (A1 commits 1-6), to this very shop.
    await expect(runCreateV2(run, tampered((call) => ({ ...call, data: approve(VAULT, 99n) })))).rejects.toBeInstanceOf(NotSendableError);
    // The committed id to another spender; the committed call on an unlisted collection; a blanket approval.
    await expect(runCreateV2(run, tampered((call) => ({ ...call, data: approve(addr(0xbadn), 1n) })))).rejects.toBeInstanceOf(NotSendableError);
    await expect(runCreateV2(run, tampered((call) => ({ ...call, to: addr(0xc0ffeen) })))).rejects.toBeInstanceOf(NotSendableError);
    await expect(runCreateV2(run, tampered((call) => ({ ...call, data: encodeFunctionData({ abi: erc721Abi, functionName: 'setApprovalForAll', args: [VAULT, true] }) })))).rejects.toBeInstanceOf(NotSendableError);
    // Only createBox ever reached the wallet; the untouched run then approves the committed items and goes on.
    expect(kinds(fake)).toEqual(['createBox']);
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    expect(fake.sent.slice(1, 11).map((call) => nftApproval(call)[1])).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
  });

  it('33 items load in two pages, each page’s approvals right before it', async () => {
    const { fake, hooks, ctx, run } = await shopRun(starterShop(['1-20', '21-33']));
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    const labels = (await readProgressV2(fake.reads, run, ctx)).steps.map((s) => s.label);
    const approvals = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `Approve starter ${from + i}/33`);
    expect(labels).toEqual(['Create the box', ...approvals(1, 32), 'Load starter items 1/2', ...approvals(33, 33), 'Load starter items 2/2', 'Approve the seed · 1000 CURIO', 'Fund the shop', 'Open the shop']);
    expect(kinds(fake)).toEqual(['createBox', ...Array(32).fill('approve'), 'loadStarter', 'approve', 'loadStarter', 'approve', 'fundSeed', 'complete']);
    expect(fake.state.starterLoaded).toBe(33);
  });
});
