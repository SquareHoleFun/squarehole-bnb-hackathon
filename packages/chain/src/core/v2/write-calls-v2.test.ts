import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, getAddress, erc20Abi, maxUint256, parseAbi, zeroAddress, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { boxCollectionAbi } from '../../abi/boxCollection';
import { boxTicketsAbi } from '../../abi/boxTickets';
import { NotSendableError } from '../../write/calls';
import { submitWrite } from '../../write/executor';
import type { Eip1193Request } from '../../write/eip1193';
import { vaultV2Abi } from './abi-v2';
import { assertSendableCallV2, MAX_OPEN_REVEAL_CALLDATA_BYTES, type WriteCallV2, type WriteTargetV2 } from './write-calls-v2';
import { TEST_FEE_READER } from '../../write/test-support/index';
import { MULTICALL3, multicall3Abi } from './reveal-batch-calls-v2';

describe('SH202 exact aggregate3 authority', () => {
  const inner = (id: bigint) => ({ target: target.collection, allowFailure: true,
    callData: call(target.collection, boxCollectionAbi, 'reveal', [id, reveal.traitsPacked, reveal.imageHash, reveal.avatarHash, reveal.modelHash, reveal.salt, reveal.proof]).data });
  const batch = (entries = [inner(1n)]): WriteCallV2 => call(MULTICALL3, multicall3Abi, 'aggregate3', [entries]);
  it('accepts canonical one and forty reveal calls only', () => {
    check(batch()); check(batch(Array.from({ length: 40 }, (_, i) => inner(BigInt(i + 1)))));
  });
  it.each(['foreign-outer', 'foreign-inner', 'nested', 'approve', 'transfer', 'other-selector', 'value', 'empty', '41', 'repeated', 'descending', 'failure-false', 'outer-trailing', 'inner-trailing', 'no-role', 'caller'])(
    'refuses %s with a canonical counterpart', kind => {
      const canonical = batch(); check(canonical);
      let c = canonical; let t: WriteTargetV2 = target;
      switch (kind) {
        case 'foreign-outer': c = { ...c, to: address(99n) }; break;
        case 'foreign-inner': c = batch([{ ...inner(1n), target: address(99n) }]); break;
        case 'nested': c = batch([{ ...inner(1n), callData: canonical.data }]); break;
        case 'approve': c = batch([{ ...inner(1n), callData: call(target.collection, erc20Abi, 'approve', [from, 1n]).data }]); break;
        case 'transfer': c = batch([{ ...inner(1n), callData: call(target.collection, erc20Abi, 'transfer', [from, 1n]).data }]); break;
        case 'other-selector': c = batch([{ ...inner(1n), callData: '0x12345678' }]); break;
        case 'value': c = { ...c, value: 1n }; break;
        case 'empty': c = batch([]); break;
        case '41': c = batch(Array.from({ length: 41 }, (_, i) => inner(BigInt(i + 1)))); break;
        case 'repeated': c = batch([inner(1n), inner(1n)]); break;
        case 'descending': c = batch([inner(2n), inner(1n)]); break;
        case 'failure-false': c = batch([{ ...inner(1n), allowFailure: false }]); break;
        case 'outer-trailing': c = { ...c, data: `${c.data}00` }; break;
        case 'inner-trailing': c = batch([{ ...inner(1n), callData: `${inner(1n).callData}00` }]); break;
        case 'no-role': t = { ...target, collection: undefined }; break;
        case 'caller': t = { ...target, collectionCaller: address(99n) }; break;
      }
      refused(c, t);
    });
});

const address = (n: bigint) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const from = address(10n);
const target = {
  chainId: 11155111, token: address(1n), coordinator: address(2n), receiver: address(3n), p: zeroAddress,
  vault: address(4n), collection: address(5n), tickets: address(6n), collectionCaller: from, drawValue: 7n,
};
const reveal = { traitsPacked: 23n, imageHash: zeroHash, avatarHash: zeroHash, modelHash: zeroHash, salt: zeroHash, proof: [zeroHash] };
const call = (to: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n): WriteCallV2 =>
  ({ to, data: encodeFunctionData({ abi, functionName, args }), value });
const actions = (id: bigint, amount: bigint, deadline: bigint) => [
  call(target.vault, vaultV2Abi, 'withdraw', [id, amount, deadline]),
  call(target.vault, vaultV2Abi, 'withdrawBatch', [[id, id + 1n], amount, deadline]),
  call(target.vault, vaultV2Abi, 'returnItem', [id, amount, deadline]),
  call(target.vault, vaultV2Abi, 'returnItems', [[id, id + 1n], amount, deadline]),
  call(target.tickets, boxTicketsAbi, 'take', [id + 1n, amount, deadline]),
  call(target.tickets, boxTicketsAbi, 'handBack', [[id + 1n, id + 2n], amount, deadline]),
  call(target.tickets, boxTicketsAbi, 'draw', [amount, deadline], target.drawValue),
  call(target.tickets, boxTicketsAbi, 'open', [id + 1n, reveal]),
  call(target.tickets, boxTicketsAbi, 'openDraw', [id + 1n, from, reveal]),
  call(target.collection, boxCollectionAbi, 'reveal', [id, reveal.traitsPacked, reveal.imageHash, reveal.avatarHash, reveal.modelHash, reveal.salt, reveal.proof]),
  call(target.token, erc20Abi, 'approve', [target.vault, amount]),
  call(target.token, erc20Abi, 'approve', [target.tickets, amount]),
  call(target.collection, boxCollectionAbi, 'approve', [target.vault, id]),
];
// Preparation is independent of the submission guard; keep it fixed while mutating a call.
function prepared(c: WriteCallV2): WriteTargetV2 {
  if (c.data.slice(0, 10) !== '0x095ea7b3') return target;
  const { args } = decodeFunctionData({ abi: erc20Abi, data: c.data });
  const [spender, amount] = args as readonly [Address, bigint];
  return { ...target, collectionApproval: c.to === target.collection
    ? { kind: 'item', id: amount }
    : { kind: 'token', spender: spender === target.vault ? 'vault' : 'tickets', amount } };
}
const check = (c: WriteCallV2, t: WriteTargetV2 = prepared(c), caller = from) => assertSendableCallV2(c, t, caller);
const refused = (c: WriteCallV2, t: WriteTargetV2 = prepared(c), caller = from) => expect(() => check(c, t, caller)).toThrow(NotSendableError);

describe('TA32 canonical collection authority properties', () => {
  it('admits each canonical action and its approvals across raw amounts and ids, including item zero', () => {
    for (let seed = 0n; seed < 32n; seed++) {
      // Values beyond the safe integer range must survive exactly; item ids may start at zero.
      for (const c of actions(seed, (1n << (53n + seed)) + seed, 2_000_000_000n + seed)) check(c);
    }
  });

  it('rejects wrong targets, changed callers, trailing arguments, truncation and changed value for every new call', () => {
    for (let seed = 0n; seed < 16n; seed++) {
      for (const c of actions(seed, 100n + seed, 2_000_000_000n)) {
        const t = prepared(c);
        for (const to of [target.token, target.coordinator, target.receiver, target.vault, target.collection, target.tickets, address(100n + seed)]) {
          if (to !== c.to) refused({ ...c, to }, t);
        }
        refused(c, t, address(100n + seed));
        refused({ ...c, data: `${c.data}${'00'.repeat(32)}` }, t);
        refused({ ...c, data: c.data.slice(0, -2) as Hex }, t);
        refused({ ...c, value: c.value + 1n }, t);
        refused({ ...c, value: -1n }, t);
      }
    }
  });

  it('needs the prepared collection roles and caller, with distinct nonzero addresses', () => {
    for (const key of ['vault', 'collection', 'collectionCaller'] as const) {
      for (const value of [undefined, zeroAddress, address(1n), 'invalid']) {
        for (const c of actions(0n, 100n, 1000n)) refused(c, { ...prepared(c), [key]: value } as WriteTargetV2);
      }
    }
    for (const c of actions(0n, 100n, 1000n).filter(c => c.to === target.tickets
      || (c.to === target.token && prepared(c).collectionApproval?.kind === 'token'
        && (decodeFunctionData({ abi: erc20Abi, data: c.data }).args?.[0] as string).toLowerCase() === target.tickets))) {
      refused(c, { ...prepared(c), tickets: undefined });
    }
  });

  it('openDraw pays only the caller, never a different recipient or the implicit zero recipient', () => {
    for (let seed = 0n; seed < 32n; seed++) {
      const other = address(100n + seed);
      refused(call(target.tickets, boxTicketsAbi, 'openDraw', [1n, other, reveal]));
    }
    refused(call(target.tickets, boxTicketsAbi, 'openDraw', [1n, zeroAddress, reveal]));
  });

  it('only draw carries the exact prepared ETH bounty, including an explicitly prepared zero', () => {
    const draw = call(target.tickets, boxTicketsAbi, 'draw', [100n, 1000n], 7n);
    check(draw);
    refused(draw, { ...target, drawValue: undefined });
    refused({ ...draw, value: 0n });
    check({ ...draw, value: 0n }, { ...target, drawValue: 0n });
    refused({ ...draw, value: maxUint256 + 1n }, { ...target, drawValue: maxUint256 + 1n });
  });

  it('allows only finite positive T amounts to the vault or tickets and one item approval to the vault', () => {
    for (const spender of [target.vault, target.tickets]) {
      for (const amount of [0n, maxUint256]) refused(call(target.token, erc20Abi, 'approve', [spender, amount]));
      check(call(target.token, erc20Abi, 'approve', [spender, maxUint256 - 1n]));
    }
    for (const spender of [from, target.tickets, target.receiver, zeroAddress]) {
      refused(call(target.collection, boxCollectionAbi, 'approve', [spender, 0n]));
    }
    refused(call(target.collection, boxCollectionAbi, 'setApprovalForAll', [target.vault, true]));
    refused(call(target.tickets, boxTicketsAbi, 'approve', [target.vault, 1n]));
    for (const c of actions(0n, 100n, 1000n).slice(-3)) {
      refused(c, target); // A role alone never authorizes an approval.
      const t = prepared(c);
      const approval = t.collectionApproval;
      if (!approval) throw new Error('missing test approval');
      refused(c, { ...t, collectionApproval: approval.kind === 'token' ? { ...approval, amount: approval.amount + 1n } : { ...approval, id: approval.id + 1n } });
    }
  });

  it('refuses empty/repeated lists, zero counts, missing limits and missing deadlines', () => {
    for (const [abi, to, fn] of [[vaultV2Abi, target.vault, 'withdrawBatch'], [vaultV2Abi, target.vault, 'returnItems'], [boxTicketsAbi, target.tickets, 'handBack']] as const) {
      for (const ids of [[], [1n, 1n]]) refused(call(to, abi, fn, [ids, 1n, 1000n]));
      refused(call(to, abi, fn, [[1n], 1n, 0n]));
    }
    refused(call(target.tickets, boxTicketsAbi, 'take', [0n, 1n, 1000n]));
    refused(call(target.tickets, boxTicketsAbi, 'open', [0n, reveal]));
    refused(call(target.tickets, boxTicketsAbi, 'openDraw', [0n, from, reveal]));
    for (const fn of ['withdraw', 'returnItem'] as const) refused(call(target.vault, vaultV2Abi, fn, [0n, 1n, 0n]));
    for (const fn of ['withdraw', 'withdrawBatch'] as const) refused(call(target.vault, vaultV2Abi, fn, [fn === 'withdraw' ? 0n : [0n], 0n, 1000n]));
    // A zero minimum is a caller choice allowed by the contracts; do not invent a positive payout requirement.
    check(call(target.vault, vaultV2Abi, 'returnItem', [0n, 0n, 1000n]));
    check(call(target.tickets, boxTicketsAbi, 'handBack', [[1n], 0n, 1000n]));
  });

  it('rejects noncanonical dynamic offsets and dirty address padding', () => {
    const batch = call(target.vault, vaultV2Abi, 'withdrawBatch', [[0n, 1n], 100n, 1000n]);
    // Move the array tail by one word and insert a gap: decodable, but not the canonical ABI encoding.
    const body = batch.data.slice(10);
    refused({ ...batch, data: `${batch.data.slice(0, 10)}${(128n).toString(16).padStart(64, '0')}${body.slice(64, 192)}${'00'.repeat(32)}${body.slice(192)}` as Hex });
    const open = call(target.tickets, boxTicketsAbi, 'openDraw', [1n, from, reveal]);
    refused({ ...open, data: `${open.data.slice(0, 74)}01${open.data.slice(76)}` as Hex });
  });

  it('does not admit other collection/ticket methods, overloads or transfers', () => {
    for (const fn of ['requestGraduationWord', 'acceptGraduationWord', 'enterTerminal']) refused(call(target.tickets, boxTicketsAbi, fn, []));
    refused(call(target.tickets, boxTicketsAbi, 'settle', [1n]));
    refused(call(target.collection, boxCollectionAbi, 'transferFrom', [from, target.vault, 0n]));
    refused(call(target.vault, parseAbi(['function withdraw(uint256,uint256,uint256,address)']), 'withdraw', [0n, 100n, 1000n, from]));
    refused(call(target.collection, boxCollectionAbi, 'unlockReveal', [0n]));
  });

  it('refuses malformed actions at submitWrite before requesting anything from the wallet', async () => {
    let requests = 0;
    const wallet: Eip1193Request = async () => { requests++; throw new Error('must not reach wallet'); };
    for (const c of actions(0n, 100n, 1000n)) {
      const t = prepared(c);
      for (const bad of [{ ...c, to: address(200n) }, { ...c, value: c.value + 1n }, { ...c, data: `${c.data}00` as Hex }]) {
        await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', call: bad, target: t, from, wallet, gasLimit: 1_000_000n })).rejects.toThrow(NotSendableError);
      }
    }
    expect(requests).toBe(0);
  });
});


describe('af1 hostile aggregate encoding', () => {
  const batch = (proof: readonly Hex[] = [zeroHash], collection = target.collection) => call(MULTICALL3, multicall3Abi, 'aggregate3', [[{
    target: collection, allowFailure: true, callData: call(collection, boxCollectionAbi, 'reveal', [1n, 23n, zeroHash, zeroHash, zeroHash, zeroHash, proof]).data,
  }]]);
  it('bounds raw calldata and rejects proofs beyond the 14 siblings needed for 10000 items', () => {
    check(batch(Array<Hex>(14).fill(zeroHash)));
    refused(batch(Array<Hex>(15).fill(zeroHash)));
    refused(batch(Array<Hex>(20_000).fill(zeroHash)));
  });
  it.each([0, 1, 2, 5, 6, 14])('rejects hostile offsets lengths and padding at word %s', word => {
    const c = batch(); check(c);
    const at = 10 + 64 * word;
    refused({ ...c, data: `${c.data.slice(0, at)}${'ff'.repeat(32)}${c.data.slice(at + 64)}` as Hex });
  });
  it('accepts checksum variants but rejects an invalid checksum and collection role aliases', () => {
    const collection = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    for (const value of [collection, collection.toLowerCase() as Address]) check(batch([zeroHash], value), { ...target, collection: value });
    refused(batch(), { ...target, p: target.collection });
    refused(call(target.collection, boxCollectionAbi, 'reveal', [1n, 23n, zeroHash, zeroHash, zeroHash, zeroHash, [zeroHash]]), { ...target, p: target.collection });
    for (const role of ['token', 'coordinator', 'receiver', 'vault', 'tickets'] as const) refused(batch(), { ...target, [role]: target.collection });
    refused(batch([zeroHash], collection), { ...target, collection: collection.replace('AB', 'Ab') as Address });
  });
});

it('af1 raw bound is exactly forty calls with fourteen-sibling proofs', () => {
  const calls = Array.from({ length: 40 }, (_, index) => ({ target: target.collection, allowFailure: true,
    callData: call(target.collection, boxCollectionAbi, 'reveal', [BigInt(index + 1), 23n, zeroHash, zeroHash, zeroHash, zeroHash, Array<Hex>(14).fill(zeroHash)]).data }));
  const c = call(MULTICALL3, multicall3Abi, 'aggregate3', [calls]);
  expect((c.data.length - 2) / 2).toBe(35_908); expect(MAX_OPEN_REVEAL_CALLDATA_BYTES).toBe(35_908);
  check(c); refused({ ...c, data: `${c.data}00` });
});

it('af1 rejects nonzero ABI padding and a decodable noncanonical outer offset', () => {
  const inner = call(target.collection, boxCollectionAbi, 'reveal', [1n, 23n, zeroHash, zeroHash, zeroHash, zeroHash, [zeroHash]]);
  const c = call(MULTICALL3, multicall3Abi, 'aggregate3', [[{ target: target.collection, allowFailure: true, callData: inner.data }]]);
  check(c);
  refused({ ...c, data: `${c.data.slice(0, -2)}01` as Hex });
  refused({ ...c, data: `${c.data.slice(0, 10)}${'40'.padStart(64, '0')}${'00'.repeat(32)}${c.data.slice(74)}` as Hex });
});
