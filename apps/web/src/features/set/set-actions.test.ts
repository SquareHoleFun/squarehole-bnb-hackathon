/**
 * SH-EXISTING-NFTS-E08C: a set box's actions against the in-memory chain (test-support/set-chain.ts): named picks with
 * an exact T approval of their limit, returns with approve(vault, id) per item, the creator's items going back after a
 * failure, and the coordinator's close and claim. Every refusal happens before the wallet is asked for anything.
 */
import { decodeFunctionData, encodeFunctionResult, keccak256, stringToHex, toFunctionSelector, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { SET_TX_GAS_CAP, setTargetV2Of } from './set-calls';
import { closeOf, graduatable, readCoordinatorFacts, sendClaim, sendClose, sendGraduate, sendPick, sendRelease, sendReturn, sendRevoke, type SetActionIO, type SetActionStep } from './set-actions';
import { readSetIdentity } from './set-identity';
import { amountOf, prepareConversion } from './set-conversion';
import { COLLECTION, CREATOR, FakeSetChain, HOLDER, OTHER, membersOf, sparseIds, specFor } from './test-support/set-chain';
import { setCoordinatorV2Abi, setGraduateCalls, setVaultV2Abi } from '@squarehole/chain/core/set-v2';
import { ERC721_ABI } from './set-calls';
import { setErrorText } from './set-errors';
import { RpcRequestError } from '@squarehole/chain/write';

const ids = sparseIds(40);
const E18 = 10n ** 18n;

function rig(state: Parameters<FakeSetChain['seed']>[2], account: Address = HOLDER, chainHex = '0x7a69') {
  const chain = new FakeSetChain({ ids });
  const box = chain.seed(specFor(chain, ids), ids, state);
  const asked: string[] = [];
  const io: SetActionIO = { reads: chain, submit: chain.submit, wallet: async ({ method }) => { asked.push(method); return method === 'eth_chainId' ? chainHex : [account]; } };
  const steps: SetActionStep[] = [];
  const ctx = { source: chain.source, coordinator: box.coordinator, encodedSpec: box.encoded, account, onStep: (step: SetActionStep) => steps.push(step) };
  // The members' record as the indexer would publish it now (Send back reads it at the press).
  const record = async () => membersOf(chain).members;
  return { chain, box, io, ctx, asked, steps, record };
}

describe('set actions', () => {
  it('a pick: the box checked, priced at one block, an exact approval of its limit, then withdrawBatch to the caller', async () => {
    const r = rig({ graduated: true });
    const named = [ids[5] as bigint, ids[0] as bigint];
    // The page's shown limit is E-08B's preparation: the quote plus 1% (rounded up), the deadline 20 minutes from the block.
    const plan = await prepareConversion(r.chain, await readSetIdentity(r.chain, r.chain.source, r.box.coordinator, r.box.encoded), HOLDER, 'pick', named);
    expect(plan.deadline).toBe(r.chain.time + 1200n);
    expect(plan.limit).toBe(amountOf(plan) + (amountOf(plan) + 99n) / 100n);
    await sendPick(r.io, r.ctx, named, plan.limit);
    expect(r.chain.sent.map((s) => s.kind)).toEqual(['approveToken', 'pick']);
    expect(r.chain.sent[0]?.args).toEqual([expect.stringMatching(new RegExp(r.box.vault.slice(2), 'i')), plan.limit]);
    const call = decodeFunctionData({ abi: setVaultV2Abi, data: r.chain.sent[1]?.data as Hex });
    expect(call.args).toEqual([named, plan.limit, plan.deadline]);
    expect(r.chain.owners.get((ids[5] as bigint).toString())).toBe(HOLDER);
    expect(r.steps).toEqual(['checking', 'approve', 'send']);
    expect(r.chain.sent.every((s) => s.gasLimit <= SET_TX_GAS_CAP)).toBe(true);
    // The approval left covers nothing more: a second pick approves its own limit again.
    await sendPick(r.io, r.ctx, [ids[9] as bigint], (await prepareConversion(r.chain, await readSetIdentity(r.chain, r.chain.source, r.box.coordinator, r.box.encoded), HOLDER, 'pick', [ids[9] as bigint])).limit);
    expect(r.chain.sent.map((s) => s.kind)).toEqual(['approveToken', 'pick', 'approveToken', 'pick']);
  });

  it('a pick stops before the wallet when the price moved past the shown limit, an item left, or it is the last item', async () => {
    const r = rig({ graduated: true, picked: 2 });
    const identity = await readSetIdentity(r.chain, r.chain.source, r.box.coordinator, r.box.encoded);
    const plan = await prepareConversion(r.chain, identity, HOLDER, 'pick', [ids[10] as bigint]);
    // A fresh limit above the one shown (here the shown one is below the quote itself) refuses before the wallet.
    await expect(sendPick(r.io, r.ctx, [ids[10] as bigint], amountOf(plan) - 1n)).rejects.toThrow('The price changed. Refresh and try again.');
    await expect(sendPick(r.io, r.ctx, [ids[0] as bigint], plan.limit)).rejects.toThrow(`#${(ids[0] as bigint).toString()} is not in the box.`);
    await expect(sendPick(r.io, r.ctx, [ids[10] as bigint, ids[10] as bigint], plan.limit)).rejects.toThrow('An item is listed twice.');
    await expect(sendPick(r.io, r.ctx, [], plan.limit)).rejects.toThrow('Pick 1 to 32 items.');
    expect(r.chain.sent).toEqual([]);
    expect(r.asked.filter((m) => m === 'eth_sendTransaction')).toEqual([]);
  });

  it('E-08B’s preparation refuses before the wallet: the block replaced under its reads, the vault’s own figure differing, the last item', async () => {
    const r = rig({ graduated: true });
    const identity = await readSetIdentity(r.chain, r.chain.source, r.box.coordinator, r.box.encoded);
    const shown = (await prepareConversion(r.chain, identity, HOLDER, 'pick', [ids[10] as bigint])).limit;
    // The block's hash read again after the reads is another one (a reorg between them).
    let blocks = 0;
    const replaced = { ...r.chain, chain: { ...r.chain.chain, getBlock: async (block: Parameters<FakeSetChain['chain']['getBlock']>[0]) => {
      const read = await r.chain.chain.getBlock(block);
      return read && ++blocks === 2 ? { ...read, hash: keccak256(stringToHex('another block')) } : read;
    } } };
    await expect(sendPick({ ...r.io, reads: replaced }, r.ctx, [ids[10] as bigint], shown)).rejects.toThrow('The price changed. Refresh and try again.');
    // The vault's own quoteWithdraw at that block says something else than E-08A's quote.
    const lying = { ...r.chain, chain: { ...r.chain.chain, call: async (request: Parameters<FakeSetChain['chain']['call']>[0], block?: Parameters<FakeSetChain['chain']['call']>[1]) =>
      (request.data.startsWith(toFunctionSelector('quoteWithdraw(uint256)')) ? encodeFunctionResult({ abi: setVaultV2Abi, functionName: 'quoteWithdraw', result: 1n }) : r.chain.chain.call(request, block)) } };
    await expect(sendPick({ ...r.io, reads: lying }, r.ctx, [ids[10] as bigint], shown)).rejects.toThrow('The price changed. Refresh and try again.');
    const last = rig({ graduated: true, picked: 39 });
    await expect(sendPick(last.io, last.ctx, [ids[39] as bigint], 10n ** 30n)).rejects.toThrow('The last item stays in the box.');
    expect([...r.chain.sent, ...last.chain.sent]).toEqual([]);
    expect([...r.asked, ...last.asked].filter((m) => m === 'eth_sendTransaction')).toEqual([]);
  });

  it('a return: each item out and this wallet’s, approve(vault, id) for each the vault may not take yet, then returnItems', async () => {
    const r = rig({ graduated: true, picked: 3 });
    const identity = await readSetIdentity(r.chain, r.chain.source, r.box.coordinator, r.box.encoded);
    const plan = await prepareConversion(r.chain, identity, HOLDER, 'return', [ids[0] as bigint, ids[1] as bigint]);
    expect(plan.limit).toBe((amountOf(plan) * 9_900n) / 10_000n);
    await sendReturn(r.io, r.ctx, [ids[0] as bigint, ids[1] as bigint], plan.limit);
    expect(r.chain.sent.map((s) => s.kind)).toEqual(['approveItem', 'approveItem', 'return']);
    expect(r.chain.sent.slice(0, 2).map((s) => s.args[1])).toEqual([ids[0], ids[1]]);
    const call = decodeFunctionData({ abi: setVaultV2Abi, data: r.chain.sent[2]?.data as Hex });
    expect(call.args).toEqual([[ids[0], ids[1]], plan.limit, plan.deadline]);
    expect(r.box.members.get((ids[0] as bigint).toString())).toBe('Inside');
    // An item that is not this wallet's: refused before anything is sent.
    r.chain.move(ids[2] as bigint, OTHER);
    const sent = r.chain.sent.length;
    await expect(sendReturn(r.io, r.ctx, [ids[2] as bigint], 1n)).rejects.toThrow(`#${(ids[2] as bigint).toString()} is not in your wallet.`);
    expect(r.chain.sent).toHaveLength(sent);
    await expect(sendReturn(r.io, r.ctx, ids.slice(0, 17), 1n)).rejects.toThrow('Pick 1 to 16 items.');
  });

  it('after a failure anyone sends up to 32 loaded items back to the creator; claims hand coins in for the pot', async () => {
    const r = rig({ failed: true, released: 4 }, HOLDER);
    r.box.tBalance.set(HOLDER.toLowerCase(), 100n * E18);
    const next = ids.slice(4, 36);
    await sendRelease(r.io, r.ctx, next, r.record);
    expect(r.chain.sent.map((s) => s.kind)).toEqual(['release']);
    expect(next.every((id) => r.chain.owners.get(id.toString()) === CREATOR)).toBe(true);
    await expect(sendRelease(r.io, r.ctx, ids.slice(0, 33), r.record)).rejects.toThrow('Pick 1 to 32 items.');
    // A holder's claim: exactly its coins approved to the coordinator, then claim(t, itself).
    await sendClaim(r.io, r.ctx, 40n * E18);
    expect(r.chain.sent.map((s) => s.kind)).toEqual(['release', 'approveToken', 'claim']);
    expect(r.chain.sent[1]?.args[1]).toBe(40n * E18);
    expect(r.chain.sent[2]?.args).toEqual([40n * E18, expect.stringMatching(new RegExp(HOLDER.slice(2), 'i'))]);
    await expect(sendClaim(r.io, r.ctx, 1_000n * E18)).rejects.toThrow('More coins than this wallet can claim with.');
  });

  it('send back: only the named items still inside are sent; once they are all back, nothing is sent (someone else sent them first)', async () => {
    const r = rig({ failed: true, released: 4 }, HOLDER);
    const named = ids.slice(4, 14);
    // Someone else's releaseToCreator for 6 of them is mined after the page read its list.
    for (const id of named.slice(0, 6)) {
      r.box.members.set(id.toString(), 'Released');
      r.chain.owners.set(id.toString(), CREATOR);
      r.box.inside -= 1n;
    }
    const result = await sendRelease(r.io, r.ctx, named, r.record);
    expect(r.chain.sent.map((s) => s.kind)).toEqual(['release']);
    expect(decodeFunctionData({ abi: setVaultV2Abi, data: r.chain.sent[0]?.data as Hex }).args?.[0]).toEqual(named.slice(6));
    expect([result.sent, result.back]).toEqual([4, 4]);
    // Every one of them is back now: nothing to send, and nothing is sent.
    await expect(sendRelease(r.io, r.ctx, named, r.record)).rejects.toThrow('Nothing to send back.');
    expect(r.chain.sent).toHaveLength(1);
  });

  it('send back (XR2 F3): an item released and since sent back to the vault is not sent again, the record names it Released; one refused before still goes', async () => {
    const r = rig({ failed: true, released: 4 }, HOLDER);
    // Released before, then its holder sends it back to the vault: on chain it looks inside (listed, not out, the vault's).
    const gift = ids[0] as bigint;
    r.chain.move(gift, r.box.vault);
    // Inside, refused before: the indexer names it Deferred.
    const refused = ids[4] as bigint;
    const record = async () => membersOf(r.chain).members.map((member) => (member.id === refused.toString() ? { ...member, state: 'Deferred' as const } : member));
    const result = await sendRelease(r.io, r.ctx, [gift, refused], record);
    expect(decodeFunctionData({ abi: setVaultV2Abi, data: r.chain.sent[0]?.data as Hex }).args?.[0]).toEqual([refused]);
    expect([result.sent, result.back]).toEqual([1, 1]);
    // The gift alone: nothing to send, nothing sent, the vault's record unchanged.
    await expect(sendRelease(r.io, r.ctx, [gift], record)).rejects.toThrow('Nothing to send back.');
    // The record unread: nothing is sent either.
    await expect(sendRelease(r.io, r.ctx, [ids[5] as bigint], async () => { throw new Error('indexer down'); })).rejects.toThrow('A read did not answer. Try again.');
    expect(r.chain.sent).toHaveLength(1);
    expect(r.box.members.get(gift.toString())).toBe('Released');
    expect(r.chain.owners.get(gift.toString())).toBe(r.box.vault);
  });

  it('items go back only after a failure; picks and returns only after graduation', async () => {
    const r = rig({});
    await expect(sendRelease(r.io, r.ctx, [ids[0] as bigint], r.record)).rejects.toThrow('Items go back only after a failed raise.');
    await expect(sendPick(r.io, r.ctx, [ids[0] as bigint], 1n)).rejects.toThrow('Picks open at graduation.');
    await expect(sendReturn(r.io, r.ctx, [ids[0] as bigint], 1n)).rejects.toThrow('Returns open at graduation.');
    await expect(sendClaim(r.io, r.ctx, 1n)).rejects.toThrow('Claims open after a failed raise.');
    expect(r.chain.sent).toEqual([]);
  });

  it('graduate: any wallet sends exactly the graduate() E-09C plans for a full raise; before the curve fills, after graduation or failure, nothing is sent', async () => {
    const r = rig({ filled: true }, OTHER);
    const identity = await readSetIdentity(r.chain, r.chain.source, r.box.coordinator, r.box.encoded);
    const planned = await setGraduateCalls(r.chain.chain, setTargetV2Of({ kind: 'box', identity }), OTHER);
    expect(r.asked).toEqual([]);
    await sendGraduate(r.io, r.ctx);
    expect(r.chain.sent.map((s) => ({ kind: s.kind, to: s.to, data: s.data, value: s.value, from: s.from }))).toEqual([
      { kind: 'graduate', to: planned.call.to, data: planned.call.data, value: 0n, from: OTHER },
    ]);
    expect(decodeFunctionData({ abi: setCoordinatorV2Abi, data: planned.call.data }).functionName).toBe('graduate');
    expect(r.chain.graduations).toEqual([OTHER]);
    expect(r.steps).toEqual(['checking', 'send']);
    // Once graduated, again: refused before the wallet.
    await expect(sendGraduate(r.io, r.ctx)).rejects.toThrow('This box cannot graduate now.');
    // Before the curve fills, after a failure, and a full curve whose box failed (its graduation hatch): refused.
    for (const state of [{}, { failed: true }, { filled: true, failed: true }] as const) {
      const other = rig(state, OTHER);
      await expect(sendGraduate(other.io, other.ctx)).rejects.toThrow('This box cannot graduate now.');
      expect(other.chain.sent).toEqual([]);
    }
    expect(r.chain.sent).toHaveLength(1);
    expect(r.asked.filter((m) => m === 'eth_sendTransaction')).toEqual([]);
  });

  it('graduatable: only a closed hook on a box neither graduated nor failed (the page’s facts, whatever the indexer says)', () => {
    const shown: string[] = [];
    for (const hookClosed of [false, true]) for (const graduated of [false, true]) for (const failed of [false, true]) {
      if (graduatable({ hookClosed, graduated, failed })) shown.push(`${hookClosed} ${graduated} ${failed}`);
    }
    expect(shown).toEqual(['true false false']);
  });

  it('graduate: a block that moved between its reads asks to try again; the site’s reader on another chain is not this box; nothing is sent', async () => {
    const r = rig({ filled: true }, OTHER);
    // The same fake behind another chain reader (E-09C reads through `reads.chain` only).
    const through = (chain: typeof r.chain.chain): SetActionIO => ({ ...r.io, reads: Object.assign(Object.create(r.chain) as typeof r.chain, { chain }) });
    let turn = 0;
    const moved = through({ ...r.chain.chain, getBlock: async (block) => {
      const got = await r.chain.chain.getBlock(block);
      return got && { ...got, hash: keccak256(stringToHex(`moved ${turn++}`)) };
    } });
    await expect(sendGraduate(moved, r.ctx)).rejects.toThrow('A read did not answer. Try again.');
    await expect(sendGraduate(through({ ...r.chain.chain, chainId: async () => 1 }), r.ctx)).rejects.toThrow('This box could not be checked. Nothing was sent.');
    expect(r.chain.sent).toEqual([]);
    expect(r.chain.graduations).toEqual([]);
    expect(r.asked.filter((m) => m === 'eth_sendTransaction')).toEqual([]);
  });

  it('graduate (XR1 F1): any read that fails while E-09C prepares asks to try again; refusals of the box itself stay apart; nothing is sent', async () => {
    const r = rig({ filled: true }, OTHER);
    const through = (chain: typeof r.chain.chain): SetActionIO => ({ ...r.io, reads: Object.assign(Object.create(r.chain) as typeof r.chain, { chain }) });
    // One of E-09C's pinned reads answered by `answer` instead of the chain.
    const reading = (fn: string, answer: () => Promise<Hex>) => through({
      ...r.chain.chain,
      call: async (request, block) => (request.data === toFunctionSelector(`${fn}()`) ? answer() : r.chain.chain.call(request, block)),
    });
    const words = (io: SetActionIO) => sendGraduate(io, r.ctx).then(() => 'sent', (error: unknown) => setErrorText(error));
    const reads: Record<string, SetActionIO> = {
      'empty closed() data': reading('closed', async () => '0x'),
      'malformed closed() data': reading('closed', async () => '0x01'),
      'a rejected read': reading('graduated', async () => { throw new RpcRequestError('internal error', -32603, null); }),
      'a timed-out read': reading('failed', async () => { throw new Error('RPC request timed out'); }),
      'a reverted read': reading('registry', async () => { throw new RpcRequestError('execution reverted', 3, '0x'); }),
      'a missing block': through({ ...r.chain.chain, getBlock: async () => null }),
      'a failed block number': through({ ...r.chain.chain, blockNumber: async () => { throw new Error('fetch failed'); } }),
    };
    for (const [failure, io] of Object.entries(reads)) expect(await words(io), failure).toBe('A read did not answer. Try again.');
    // The box itself refused: its coordinator names another registry; its identity no longer checks out.
    expect(await words(reading('registry', async () => encodeFunctionResult({ abi: setCoordinatorV2Abi, functionName: 'registry', result: OTHER })))).toBe('This box could not be checked. Nothing was sent.');
    r.chain.badVault = true;
    expect(await words(r.io)).toBe('This box could not be checked. Nothing was sent.');
    expect(r.chain.sent).toEqual([]);
    expect(r.asked.filter((m) => m === 'eth_sendTransaction')).toEqual([]);
  });

  it('close: failClosed once a loading gate held 14 days past its open, fail past the deadline; nothing earlier', async () => {
    const loading = rig({ loaded: 16 });
    expect(closeOf(await readCoordinatorFacts(loading.chain, loading.box.coordinator))).toBeNull();
    await expect(sendClose(loading.io, loading.ctx)).rejects.toThrow('This raise cannot be closed now.');
    loading.chain.time += 1_209_600n;
    expect(closeOf(await readCoordinatorFacts(loading.chain, loading.box.coordinator))).toBe('failClosed');
    await sendClose(loading.io, loading.ctx);
    expect(loading.chain.sent.map((s) => s.fn)).toEqual(['failClosed']);
    expect(loading.box.failed).toBe(true);
    const open = rig({});
    expect(closeOf(await readCoordinatorFacts(open.chain, open.box.coordinator))).toBeNull();
    open.chain.time = open.box.deadline;
    await sendClose(open.io, open.ctx);
    expect(open.chain.sent.map((s) => s.fn)).toEqual(['fail']);
  });

  it('the wallet must be on the box’s chain and account, and a build without a sender sends nothing', async () => {
    const wrong = rig({ graduated: true }, HOLDER, '0x1');
    await expect(sendPick(wrong.io, wrong.ctx, [ids[0] as bigint], 10n ** 30n)).rejects.toThrow('Switch the wallet to this box’s network.');
    const moved = rig({ graduated: true });
    await expect(sendPick({ ...moved.io, wallet: async ({ method }) => (method === 'eth_chainId' ? '0x7a69' : [OTHER]) }, moved.ctx, [ids[0] as bigint], 10n ** 30n)).rejects.toThrow('The wallet account changed. Connect it again.');
    const none = rig({ graduated: true });
    await expect(sendPick({ ...none.io, submit: null }, none.ctx, [ids[0] as bigint], 10n ** 30n)).rejects.toThrow('Sending is not available in this build.');
    expect([...wrong.chain.sent, ...moved.chain.sent, ...none.chain.sent]).toEqual([]);
  });

  it('Revoke: only the creator, only while the approval is on', async () => {
    const r = rig({}, CREATOR);
    await sendRevoke(r.io, r.ctx);
    expect(r.chain.sent.map((s) => [s.kind, s.to.toLowerCase()])).toEqual([['revokeAll', COLLECTION.toLowerCase()]]);
    expect(await r.chain.read(COLLECTION, ERC721_ABI, 'isApprovedForAll', [CREATOR, r.box.vault])).toBe(false);
    await expect(sendRevoke(r.io, r.ctx)).rejects.toThrow('Already revoked.');
    const holder = rig({}, HOLDER);
    await expect(sendRevoke(holder.io, holder.ctx)).rejects.toThrow('Only the creator’s wallet holds this approval.');
  });
});
