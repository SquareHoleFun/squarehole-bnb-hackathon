/**
 * SH-EXISTING-NFTS-E08C after E-08B: the pages send only through E-08B's executor (`setSubmit()`: `submitWrite`'s
 * 'set-v2' branch for a box's calls, `submitSetCreateWrite` for a creation), here with a browser wallet over the
 * in-memory chain. What the executor asks the wallet, the one transaction it sends per call, and its guard refusing,
 * before the wallet is asked anything, every call outside the box's own identity and the amounts the page prepared.
 */
import { decodeFunctionData, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { setFactoryV2Abi } from '@squarehole/chain/core/set-v2';
import { NotSendableError, WalletContextChangedError, assertSendableSetCallV2 } from '@squarehole/chain/write';
import { sendPick, sendReturn, type SetActionIO } from './set-actions';
import { SET_TX_GAS_CAP, approveAllCall, approveTokenCall, claimCall, closeCall, setSubmit, setTargetV2Of, type SetSendRequest, type SetTarget } from './set-calls';
import { setErrorText } from './set-errors';
import { readSetIdentity } from './set-identity';
import { prepareConversion } from './set-conversion';
import { COLLECTION, CREATOR, FakeSetChain, HOLDER, OTHER, sparseIds, specFor } from './test-support/set-chain';
import { prepareSetCreate, runSetCreate, type SetRun } from '../create/set/set-send';
import { createChainOf } from '../create/set/useSetCreate';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

const ids = sparseIds(40);
type WalletCall = { method: string; params?: unknown };
type Tx = { readonly from: Address; readonly to: Address; readonly data: Hex; readonly value: Hex; readonly gas: Hex; readonly chainId: Hex };
const txs = (requests: readonly WalletCall[]): Tx[] => requests.filter((r) => r.method === 'eth_sendTransaction').map((r) => (r.params as readonly Tx[])[0] as Tx);

describe('the executor sends the pages’ calls', () => {
  it('a pick and a return: chain and account read again right before each send, then one eth_sendTransaction with the checked chain, no value and a capped gas limit', async () => {
    const chain = new FakeSetChain({ ids });
    const box = chain.seed(specFor(chain, ids), ids, { graduated: true });
    const submit = setSubmit();
    expect(submit).not.toBeNull();
    const requests: WalletCall[] = [];
    const io: SetActionIO = { reads: chain, submit, wallet: chain.walletFor(HOLDER, requests) };
    const ctx = { source: chain.source, coordinator: box.coordinator, encodedSpec: box.encoded, account: HOLDER };
    const identity = await readSetIdentity(chain, chain.source, box.coordinator, box.encoded);
    const picked = [ids[3] as bigint, ids[7] as bigint];
    await sendPick(io, ctx, picked, (await prepareConversion(chain, identity, HOLDER, 'pick', picked)).limit);
    expect(picked.every((id) => chain.owners.get(id.toString()) === HOLDER)).toBe(true);
    await sendReturn(io, ctx, [picked[0] as bigint], (await prepareConversion(chain, identity, HOLDER, 'return', [picked[0] as bigint])).limit);
    expect(chain.owners.get((picked[0] as bigint).toString())?.toLowerCase()).toBe(box.vault.toLowerCase());
    expect(chain.sent.map((s) => s.fn)).toEqual(['approve', 'withdrawBatch', 'approve', 'returnItems']);
    expect(chain.sent.map((s) => s.to.toLowerCase())).toEqual([box.token, box.vault, COLLECTION, box.vault].map((a) => a.toLowerCase()));
    // Each send: the executor's own chain and account reads, then exactly one transaction.
    const methods = requests.map((r) => r.method);
    const sends = methods.flatMap((m, i) => (m === 'eth_sendTransaction' ? [i] : []));
    expect(sends).toHaveLength(4);
    for (const i of sends) expect(methods.slice(i - 2, i)).toEqual(['eth_chainId', 'eth_accounts']);
    for (const tx of txs(requests)) {
      expect(tx.from).toBe(HOLDER);
      expect(tx.value).toBe('0x0');
      expect(BigInt(tx.chainId)).toBe(BigInt(chain.chainIdValue));
      expect(BigInt(tx.gas) > 0n && BigInt(tx.gas) <= SET_TX_GAS_CAP).toBe(true);
    }
    expect(methods.filter((m) => !['eth_chainId', 'eth_accounts', 'eth_sendTransaction'].includes(m))).toEqual([]);
  });

  it('a creation: createBox carries exactly the bootstrap and the first buy (a native coin), every other step nothing; the one approval names the box’s own vault', async () => {
    const chain = new FakeSetChain({ ids, native: true });
    const spec = specFor(chain, ids);
    const run = await prepareSetCreate(chain, createChainOf(chain.source), spec, ids, CREATOR);
    const requests: WalletCall[] = [];
    const runs: SetRun[] = [];
    const end = await runSetCreate(run, {
      reads: chain, source: chain.source, chain: createChainOf(chain.source), coin: { symbol: 'ETH', decimals: 18 },
      submit: setSubmit() as NonNullable<ReturnType<typeof setSubmit>>, wallet: chain.walletFor(CREATOR, requests), onRun: (next: SetRun) => runs.push(next), onProgress: () => undefined, stopped: () => false,
    });
    expect(end).toBe('done');
    expect(chain.sent.map((s) => s.fn)).toEqual(['createBox', 'setApprovalForAll', 'load', 'load', 'load', 'complete']);
    const sent = txs(requests);
    const create = decodeFunctionData({ abi: setFactoryV2Abi, data: sent[0]?.data as Hex });
    expect(create.functionName).toBe('createBox');
    expect(BigInt(sent[0]?.value ?? '0x0')).toBe(chain.listing(spec.pricing.listingId).q.bootstrapQ + spec.creatorBuy);
    expect(sent.slice(1).every((tx) => tx.value === '0x0')).toBe(true);
    expect(sent.every((tx) => tx.from === CREATOR && BigInt(tx.chainId) === BigInt(chain.chainIdValue) && BigInt(tx.gas) <= SET_TX_GAS_CAP)).toBe(true);
    expect((chain.sent[1]?.args[0] as string).toLowerCase()).toBe(chain.box.vault.toLowerCase());
  });
});

describe('the executor’s guard refuses before the wallet is asked anything', () => {
  async function rig(state: Parameters<FakeSetChain['seed']>[2]) {
    const chain = new FakeSetChain({ ids });
    const box = chain.seed(specFor(chain, ids), ids, state);
    const identity = await readSetIdentity(chain, chain.source, box.coordinator, box.encoded);
    const requests: WalletCall[] = [];
    const submit = setSubmit() as NonNullable<ReturnType<typeof setSubmit>>;
    const send = (target: SetTarget, call: SetSendRequest['call'], from: Address = HOLDER) =>
      submit({ feeReader: TEST_FEE_READER, wallet: chain.walletFor(from, requests), target, call, from, gasLimit: 200_000n });
    return { chain, box, identity, requests, send };
  }

  it('observations that are not the box’s, a T approval other than the prepared amount, a claim to someone else, another creator', async () => {
    const r = await rig({ graduated: true });
    const { identity } = r;
    const box: SetTarget = { kind: 'box', identity };
    const plan = await prepareConversion(r.chain, identity, HOLDER, 'pick', [ids[3] as bigint]);
    // The vault the page read swapped for another address: the routing rule refuses on the executor's side too.
    const roles = [...identity.observed.roles]; roles[3] = OTHER;
    const forged: SetTarget = { kind: 'box', identity: { ...identity, observed: { ...identity.observed, roles } } };
    const refused = await r.send(forged, approveAllCall(identity, true), CREATOR).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(setErrorText(refused)).toBe('This box could not be checked. Nothing was sent.');
    const cases: [SetTarget, SetSendRequest['call'], Address][] = [
      [{ kind: 'box', identity, tokenApproval: plan.limit }, approveTokenCall(identity, 'vault', plan.limit + 1n), HOLDER],
      [box, approveTokenCall(identity, 'vault', plan.limit), HOLDER],
      [box, approveTokenCall(identity, 'coordinator', 5n), HOLDER],
      [{ kind: 'box', identity, claimApproval: { from: HOLDER, amount: 5n } }, approveTokenCall(identity, 'coordinator', 6n), HOLDER],
      [{ kind: 'box', identity, claimApproval: { from: HOLDER, amount: 5n } }, claimCall(identity, 5n, OTHER), HOLDER],
      [box, approveAllCall(identity, true), HOLDER],
      [box, closeCall(identity, 'fail'), '0x0000000000000000000000000000000000000000'],
    ];
    for (const [target, call, from] of cases) {
      const error = await r.send(target, call, from).catch((caught: unknown) => caught);
      expect(error, call.kind).toBeInstanceOf(NotSendableError);
      expect(setErrorText(error)).toBe('This box could not be checked. Nothing was sent.');
    }
    expect(r.requests, 'no refused call reached the wallet').toEqual([]);
    expect(r.chain.sent).toEqual([]);
  });

  it('admits the creator’s remainder (claim(0) to itself, no approval) and a holder’s exact claim pair; a wallet on another chain stops at the executor', async () => {
    const r = await rig({ failed: true });
    const { identity } = r;
    const remainder = claimCall(identity, 0n, CREATOR);
    expect(() => assertSendableSetCallV2({ to: remainder.to, data: remainder.data, value: 0n }, setTargetV2Of({ kind: 'box', identity }), CREATOR)).not.toThrow();
    const scoped: SetTarget = { kind: 'box', identity, claimApproval: { from: HOLDER, amount: 7n } };
    for (const call of [approveTokenCall(identity, 'coordinator', 7n), claimCall(identity, 7n, HOLDER)]) {
      expect(() => assertSendableSetCallV2({ to: call.to, data: call.data, value: 0n }, setTargetV2Of(scoped as Extract<SetTarget, { kind: 'box' }>), HOLDER)).not.toThrow();
    }
    const elsewhere = async ({ method }: { method: string }) => (method === 'eth_chainId' ? toHex(1) : [HOLDER]);
    const submit = setSubmit() as NonNullable<ReturnType<typeof setSubmit>>;
    const error = await submit({ feeReader: TEST_FEE_READER, wallet: elsewhere, target: scoped, call: approveTokenCall(identity, 'coordinator', 7n), from: HOLDER, gasLimit: 100_000n }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WalletContextChangedError);
    expect(setErrorText(error)).toBe('Switch the wallet to this box’s network.');
    expect(r.chain.sent).toEqual([]);
  });
});
