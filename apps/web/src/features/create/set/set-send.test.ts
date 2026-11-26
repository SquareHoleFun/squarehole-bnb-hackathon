/**
 * SH-EXISTING-NFTS-E08C: Create for a set box against an in-memory chain (features/set/test-support/set-chain.ts) that
 * plays the add-on's contracts and E-08B's executor. The run's own reads decide every step; the tests check the exact
 * calls (approval amounts, one setApprovalForAll to the box's own vault after its identity check, pages of 16 cut at the
 * committed suffix, complete), the resume rules (a mined step is never sent again; a pending hash is waited for), the
 * fresh ownership read before every press and every page, the gas backoff, and the end states.
 */
import { decodeFunctionData, keccak256, stringToHex, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { setStarterSetLoaderV2Abi } from '@squarehole/chain/core/set-v2';
import { sendRevoke } from '../../set/set-actions';
import { ERC721_ABI, SET_TX_GAS_CAP, setSubmit, type SetSubmit } from '../../set/set-calls';
import { BOOTSTRAP, COLLECTION, CREATOR, FakeSetChain, OTHER, P_COIN, sparseIds, specFor } from '../../set/test-support/set-chain';
import { OWNER_READS, SetCreateRefusal, idsOfRun, prepareSetCreate, readSetProgress, runSetCreate, type SetProgress, type SetRun, type SetStepKind } from './set-send';
import { createChainOf } from './useSetCreate';

const wallet = async () => { throw new Error('the fake executor never asks the wallet'); };
const coin = { symbol: 'USDC', decimals: 6 };

function rig(options: ConstructorParameters<typeof FakeSetChain>[0] = {}) {
  const ids = sparseIds(40);
  const chain = new FakeSetChain({ ids, native: false, ...options });
  const spec = specFor(chain, ids);
  const runs: SetRun[] = [];
  const seen: (readonly [SetProgress, SetStepKind | null])[] = [];
  let stopAfter: ((progress: SetProgress, sending: SetStepKind | null) => boolean) | null = null;
  let stopped = false;
  const hooks = () => ({
    reads: chain, source: chain.source, chain: createChainOf(chain.source), coin, submit: chain.submit, wallet,
    onRun: (run: SetRun) => runs.push(run),
    onProgress: (progress: SetProgress, sending: SetStepKind | null) => { seen.push([progress, sending]); if (stopAfter?.(progress, sending)) stopped = true; },
    stopped: () => stopped,
  });
  return {
    chain, ids, spec, runs, seen, hooks,
    stopWhen: (test: (progress: SetProgress, sending: SetStepKind | null) => boolean) => { stopAfter = test; stopped = false; },
    clearStop: () => { stopAfter = null; stopped = false; },
    prepare: () => prepareSetCreate(chain, createChainOf(chain.source), spec, ids, CREATOR),
  };
}
const loads = (chain: FakeSetChain) => chain.sent.filter((s) => s.kind === 'load').map((s) => decodeFunctionData({ abi: setStarterSetLoaderV2Abi, data: s.data }).args[1] as readonly bigint[]);

describe('set Create: the run', () => {
  it('creates a set box: the exact price-coin approval, createBox, one approval of its own vault, pages of 16, complete', async () => {
    const r = rig();
    const run = await r.prepare();
    expect(run.ids).toEqual(r.ids.map(String));
    expect(await runSetCreate(run, r.hooks())).toBe('done');
    expect(r.chain.sent.map((s) => s.kind)).toEqual(['approve', 'createBox', 'approveAll', 'load', 'load', 'load', 'complete']);
    const [approve, create, approveAll] = r.chain.sent;
    expect(approve?.to).toBe(P_COIN);
    expect((approve?.args[0] as string).toLowerCase()).toBe(r.chain.release.factory.address.toLowerCase());
    expect(approve?.args[1]).toBe(15_000_000n);
    expect(create?.value).toBe(0n);
    // The one setApprovalForAll names the box's own vault (the identity check read it from the vault's clone args).
    expect(approveAll?.to.toLowerCase()).toBe(COLLECTION.toLowerCase());
    expect((approveAll?.args[0] as string).toLowerCase()).toBe(r.chain.box.vault.toLowerCase());
    expect(approveAll?.args[1]).toBe(true);
    expect(loads(r.chain).map((page) => page.length)).toEqual([16, 16, 8]);
    expect(loads(r.chain).flat()).toEqual(r.ids);
    expect(r.chain.box.notified).toBe(true);
    expect(r.chain.sent.every((s) => s.gasLimit > 0n && s.gasLimit <= SET_TX_GAS_CAP)).toBe(true);
    const last = r.seen.at(-1)?.[0];
    expect(last?.rows.every((row) => row.done)).toBe(true);
    expect(last?.rows.map((row) => row.label)).toEqual(['Approve 15 USDC', 'Create the box', 'Allow loading', 'Load items · 40/40', 'Open trading']);
    expect(last?.approvedAll).toBe(true);
    // After complete the creator takes the approval back (its own transaction).
    await sendRevoke({ reads: r.chain, submit: r.chain.submit, wallet: async ({ method }) => (method === 'eth_chainId' ? '0x7a69' : [CREATOR]) },
      { source: r.chain.source, coordinator: run.coordinator, encodedSpec: run.encoded, account: CREATOR });
    expect(r.chain.sent.at(-1)?.kind).toBe('revokeAll');
    expect(await r.chain.read(COLLECTION, ERC721_ABI, 'isApprovedForAll', [CREATOR, r.chain.box.vault])).toBe(false);
  });

  it('a native price coin needs no approval: createBox carries the bootstrap plus the first buy as value', async () => {
    const r = rig({ native: true });
    const spec = specFor(r.chain, r.ids, { creatorBuy: 5n });
    const run = await prepareSetCreate(r.chain, createChainOf(r.chain.source), spec, r.ids, CREATOR);
    expect(await runSetCreate(run, r.hooks())).toBe('done');
    expect(r.chain.sent[0]?.kind).toBe('createBox');
    expect(r.chain.sent[0]?.value).toBe(BOOTSTRAP + 5n);
  });

  it('Stop between pages; the next press resumes from the chain and sends no mined step again', async () => {
    const r = rig();
    const run = await r.prepare();
    r.stopWhen((progress) => progress.loaded === 16);
    expect(await runSetCreate(run, r.hooks())).toBe('stopped');
    expect(r.chain.box.loaded).toBe(16);
    const before = r.chain.sent.length;
    r.clearStop();
    const latest = r.runs.at(-1) ?? run;
    expect(await runSetCreate(latest, r.hooks())).toBe('done');
    expect(r.chain.sent.slice(before).map((s) => s.kind)).toEqual(['load', 'load', 'complete']);
    expect(r.chain.sent.filter((s) => s.kind === 'createBox' || s.kind === 'approve' || s.kind === 'approveAll')).toHaveLength(3);
    expect(loads(r.chain).flat()).toEqual(r.ids);
  });

  it('a hash sent before a reload is waited for while the node still has it, never sent again', async () => {
    const r = rig();
    const run = await r.prepare();
    r.chain.hold = true;
    r.chain.failNextWait = true;
    // createBox's approval is the first wait: it gives up (the page closed), the transaction still pending.
    await expect(runSetCreate(run, r.hooks())).rejects.toThrow('took too long');
    const kept = r.runs.at(-1);
    expect(kept?.sent.approve).toBeDefined();
    expect(r.chain.sent).toHaveLength(1);
    // The next press finds the hash pending, waits for it, and goes on with createBox: the approval is not sent twice.
    expect(await runSetCreate(kept as SetRun, r.hooks())).toBe('done');
    expect(r.chain.sent.filter((s) => s.kind === 'approve')).toHaveLength(1);
  });

  it('reads who holds every item not loaded yet before a press asks the wallet anything, and refuses with the count', async () => {
    const r = rig();
    const run = await r.prepare();
    r.chain.move(r.ids[39] as bigint, OTHER);
    r.chain.move(r.ids[3] as bigint, OTHER);
    const refusal = await runSetCreate(run, r.hooks()).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SetCreateRefusal);
    expect((refusal as Error).message).toBe('Not in your wallet: 2 items');
    expect(r.chain.sent).toEqual([]);
    // An owner read the chain does not answer stops the press too (nothing is sent unread).
    r.chain.move(r.ids[39] as bigint, CREATOR);
    r.chain.move(r.ids[3] as bigint, CREATOR);
    r.chain.downIds.add((r.ids[20] as bigint).toString());
    await expect(runSetCreate(run, r.hooks())).rejects.toThrow('took too long');
    expect(r.chain.sent).toEqual([]);
  });

  it('every press reads again: an item sold after the first press stops the next one before its page', async () => {
    const r = rig();
    const run = await r.prepare();
    r.stopWhen((progress) => progress.loaded === 16);
    await runSetCreate(run, r.hooks());
    r.clearStop();
    const reads = r.chain.calls.length;
    r.chain.move(r.ids[30] as bigint, OTHER);
    const sent = r.chain.sent.length;
    await expect(runSetCreate(r.runs.at(-1) ?? run, r.hooks())).rejects.toThrow('Not in your wallet: 1 item');
    expect(r.chain.sent).toHaveLength(sent);
    // It read the 24 items not loaded yet, OWNER_READS at a time.
    expect(r.chain.calls.slice(reads).filter((fn) => fn === 'ownerOf').length).toBeGreaterThanOrEqual(24);
    expect(OWNER_READS).toBe(16);
  });

  it('each page reads its own items again right before it is sent (a long run’s first read is minutes old)', async () => {
    const r = rig();
    const run = await r.prepare();
    let moved = false;
    const hooks = r.hooks();
    const sent = await runSetCreate(run, { ...hooks, onProgress: (progress, sending) => {
      hooks.onProgress(progress, sending);
      if (!moved && progress.loaded === 16 && sending === null) { moved = true; r.chain.move(r.ids[20] as bigint, OTHER); }
    } }).catch((error: unknown) => error);
    expect((sent as Error).message).toBe('Not in your wallet: 1 item');
    expect(loads(r.chain).map((page) => page.length)).toEqual([16]);
  });

  it('halves a page whose estimate reverts TransferGas() or does not fit the cap; never sends above 16,777,216', async () => {
    const r = rig({ transferGasAbove: 8 });
    expect(await runSetCreate(await r.prepare(), r.hooks())).toBe('done');
    expect(loads(r.chain).map((page) => page.length)).toEqual([8, 8, 8, 8, 8]);
    const heavy = rig({ loadGasPerItem: 900_000n });
    expect(await runSetCreate(await heavy.prepare(), heavy.hooks())).toBe('done');
    // 16 × 0.9M + 0.1M = 14.5M, 17.4M with its fifth: over the cap, so 8 per page (as E-07's Amsterdam figure).
    expect(loads(heavy.chain).map((page) => page.length)).toEqual([8, 8, 8, 8, 8]);
    expect(heavy.chain.sent.every((s) => s.gasLimit <= SET_TX_GAS_CAP)).toBe(true);
    const stuck = rig({ transferGasAbove: 0 });
    await expect(runSetCreate(await stuck.prepare(), stuck.hooks())).rejects.toThrow('An item is too heavy to load.');
    expect(stuck.chain.sent.map((s) => s.kind)).toEqual(['approve', 'createBox', 'approveAll']);
  });

  it('refuses a box that is not this run’s: another list, a loader whose progress names another suffix, or a vault that is not the release’s clone (nothing more is sent)', async () => {
    const r = rig();
    const run = await r.prepare();
    r.stopWhen((progress) => progress.created);
    await runSetCreate(run, r.hooks());
    const created = r.runs.at(-1) ?? run;
    const reordered: SetRun = { ...created, ids: [...created.ids].reverse() };
    await expect(readSetProgress(r.chain, r.chain.source, reordered, coin)).rejects.toThrow('The list is not this box’s.');
    // E-08B's loading plan checks the loader's remaining hash against this list's suffix at its loaded count.
    const remaining = r.chain.box.remaining;
    r.chain.box.remaining = keccak256(stringToHex('another suffix'));
    await expect(readSetProgress(r.chain, r.chain.source, created, coin)).rejects.toThrow('The list is not this box’s.');
    r.chain.box.remaining = remaining;
    r.chain.badVault = true;
    r.clearStop();
    const sent = r.chain.sent.length;
    await expect(runSetCreate(created, r.hooks())).rejects.toBeInstanceOf(SetCreateRefusal);
    expect(r.chain.sent).toHaveLength(sent);
    expect(r.chain.sent.some((s) => s.kind === 'approveAll')).toBe(false);
  });

  it('a stored run another release prepared (the manifest changed on this chain) is refused before any wallet request (XR F3)', async () => {
    const r = rig();
    const run = await r.prepare();
    // The same chain, a selected (checked) release with another factory: the stored run names the old one.
    const source = { ...r.chain.source, release: { ...r.chain.source.release, factory: { ...r.chain.source.release.factory, address: OTHER } } };
    const requests: string[] = [];
    const executor = setSubmit() as SetSubmit;
    const sent = await runSetCreate(run, {
      ...r.hooks(), source, chain: createChainOf(source), submit: executor,
      wallet: async ({ method }) => { requests.push(method); return method === 'eth_chainId' ? '0x7a69' : [CREATOR]; },
    }).catch((error: unknown) => error);
    expect(sent).toBeInstanceOf(SetCreateRefusal);
    expect((sent as Error).message).toBe('The factory is not this release’s.');
    expect(requests).toEqual([]);
    expect(r.chain.sent).toEqual([]);
    await expect(readSetProgress(r.chain, source, run, coin)).rejects.toThrow('The factory is not this release’s.');
  });

  it('right before the approval or the payment, the factory’s terms are read again: a moved bootstrap refuses, nothing sent (XR F3)', async () => {
    const r = rig();
    const run = await r.prepare();
    r.chain.bootstrapExtra = 1n;
    const sent = await runSetCreate(run, r.hooks()).catch((error: unknown) => error);
    expect((sent as Error).message).toBe('Price coin changed: refresh this plan');
    expect(r.chain.sent).toEqual([]);
    // Back to the terms it was prepared on: the same run goes through.
    r.chain.bootstrapExtra = 0n;
    expect(await runSetCreate(run, r.hooks())).toBe('done');
    expect(r.chain.sent.map((s) => s.kind)).toEqual(['approve', 'createBox', 'approveAll', 'load', 'load', 'load', 'complete']);
  });

  it('a raise that failed while loading ends the run (nothing more loads) and leaves the approval for Revoke', async () => {
    const r = rig();
    const run = await r.prepare();
    r.stopWhen((progress) => progress.loaded === 16);
    await runSetCreate(run, r.hooks());
    r.chain.failBox();
    r.clearStop();
    expect(await runSetCreate(r.runs.at(-1) ?? run, r.hooks())).toBe('failed');
    const last = r.seen.at(-1)?.[0];
    expect(last).toMatchObject({ failed: true, next: null, approvedAll: true, loaded: 16 });
    expect(loads(r.chain)).toHaveLength(1);
  });

  it('keeps the committed order of full-width ids (0 and the largest uint256 included) from the run’s own data', async () => {
    const r = rig();
    const run = await r.prepare();
    expect(idsOfRun(run)).toEqual(r.ids);
    expect(run.ids[0]).toBe('0');
    expect(run.ids[1]).toBe(((1n << 256n) - 1n).toString());
    const address: Address = run.coordinator;
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
