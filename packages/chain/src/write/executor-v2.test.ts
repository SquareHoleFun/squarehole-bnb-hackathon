import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { coordinatorV2Abi, itemLedgerV2Abi, pileVaultV2Abi, receiverV2Abi, shopVaultV2Abi } from '../core/v2';
import { NotSendableError } from './calls';
import { submitWrite, WalletContextChangedError, WalletRejectedError, WalletRequestError } from './executor';
import type { Eip1193RequestArguments } from './eip1193';
import { TEST_FEE_READER, TEST_SEND_FEE_FIELDS } from './test-support/index';

const owner = '0x0000000000000000000000000000000000000001' as const;
const token = '0x0000000000000000000000000000000000000002' as const;
const coordinator = '0x0000000000000000000000000000000000000003' as const;
const receiver = '0x0000000000000000000000000000000000000004' as const;
const other = '0x0000000000000000000000000000000000000005' as const;
const target = { chainId: 31337, token, coordinator, receiver, p: token };
const hash = `0x${'ab'.repeat(32)}` as Hex;
const amount = 2n ** 80n + 7n;
const claim = { to: coordinator, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [amount, owner] }), value: 0n } as const;
const permitted = [
  { name: 'claim', call: claim },
  { name: 'no-buyers', call: { ...claim, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [0n, owner] }) } },
  { name: 'approve', call: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [coordinator, amount] }), value: 0n } },
  { name: 'creator', call: { to: receiver, data: encodeFunctionData({ abi: receiverV2Abi, functionName: 'claimCreator', args: [token, owner] }), value: 0n } },
  ...(['fail', 'failClosed'] as const).map((name) => ({ name, call: { to: coordinator, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: name }), value: 0n } })),
] as const;

function fixture() {
  const wallet = vi.fn(async ({ method }: Eip1193RequestArguments): Promise<unknown> => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_accounts') return [owner];
    return hash;
  });
  const options = { protocol: 'core-v2' as const, target, call: claim, wallet, from: owner, gasLimit: 480000n, feeReader: TEST_FEE_READER };
  return { wallet, options };
}

describe('SH-V2-INT-FIX3 v2 executor authority', () => {
  it.each(permitted)('sends only the prepared $name call with zero value and the checked chain', async ({ call }) => {
    const { wallet, options } = fixture();
    await expect(submitWrite({ ...options, call })).resolves.toBe(hash);
    expect(wallet.mock.calls.map(([request]) => request.method)).toEqual(['eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
    expect(wallet).toHaveBeenLastCalledWith({ method: 'eth_sendTransaction', params: [{ from: owner, to: call.to, data: call.data, value: '0x0', gas: '0x75300', ...TEST_SEND_FEE_FIELDS, chainId: '0x7a69' }] });
    if (call === claim) expect(decodeFunctionData({ abi: coordinatorV2Abi, data: call.data })).toMatchObject({ args: [amount, owner] });
  });

  it('refuses wrong targets, value, arbitrary selectors, recipients, spenders, assets and noncanonical calldata before any wallet request', async () => {
    const { wallet, options } = fixture();
    const bad = [
      { ...claim, to: other },
      { ...claim, value: 1n },
      { ...claim, data: '0xdeadbeef' as Hex },
      { ...claim, data: '0x' as Hex },
      { ...claim, data: `${claim.data}00` as Hex },
      { ...claim, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [amount, other] }) },
      { ...claim, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'graduate' }) },
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner, amount] }), value: 0n },
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [other, amount] }), value: 0n },
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [coordinator, 0n] }), value: 0n },
      { to: receiver, data: encodeFunctionData({ abi: receiverV2Abi, functionName: 'claimCreator', args: [other, owner] }), value: 0n },
      { to: receiver, data: encodeFunctionData({ abi: receiverV2Abi, functionName: 'claimCreator', args: [token, other] }), value: 0n },
    ];
    for (const call of bad) await expect(submitWrite({ ...options, call })).rejects.toBeInstanceOf(NotSendableError);
    expect(wallet).not.toHaveBeenCalled();
  });

  it.each(['chain', 'account'] as const)('refuses a changed wallet %s', async (change) => {
    const { wallet, options } = fixture();
    wallet.mockImplementation(async ({ method }) => method === 'eth_chainId' ? (change === 'chain' ? '0x1' : '0x7a69') : [other]);
    await expect(submitWrite(options)).rejects.toBeInstanceOf(WalletContextChangedError);
    expect(wallet.mock.calls.some(([request]) => request.method === 'eth_sendTransaction')).toBe(false);
  });

  it('preserves the executor rejection and malformed hash handling for v2', async () => {
    const { wallet, options } = fixture();
    wallet.mockImplementation(async ({ method }) => {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_accounts') return [owner];
      throw { code: 4001 };
    });
    await expect(submitWrite(options)).rejects.toBeInstanceOf(WalletRejectedError);
    wallet.mockImplementation(async ({ method }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_accounts' ? [owner] : 'not-a-hash');
    await expect(submitWrite(options)).rejects.toBeInstanceOf(WalletRequestError);
  });

  it('sends a holder-ledger claim only to the prepared role 17, for a batch, paid to the caller (F127)', async () => {
    const { wallet, options } = fixture();
    const ledger = '0x0000000000000000000000000000000000000017' as const;
    const ledgerTarget = { ...target, holderLedger: ledger };
    const holderClaim = { to: ledger, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [3n, owner] }), value: 0n } as const;
    await expect(submitWrite({ ...options, target: ledgerTarget, call: holderClaim })).resolves.toBe(hash);
    const bad = [
      { target: target, call: holderClaim },
      { target: ledgerTarget, call: { ...holderClaim, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [3n, other] }) } },
      { target: ledgerTarget, call: { ...holderClaim, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [0n, owner] }) } },
      { target: ledgerTarget, call: { ...holderClaim, to: other } },
      { target: { ...target, holderLedger: coordinator }, call: holderClaim },
      { target: { ...target, holderLedger: '0x0000000000000000000000000000000000000000' as const }, call: holderClaim },
    ];
    for (const { target: t, call } of bad) await expect(submitWrite({ ...options, target: t, call })).rejects.toBeInstanceOf(NotSendableError);
    expect(wallet.mock.calls.filter(([request]) => request.method === 'eth_sendTransaction')).toHaveLength(1);
  });

  it('sends item claims, item sync, pile approval, redemption and seed return only to their prepared M3 roles (SH-V2-M3-53)', async () => {
    const { wallet, options } = fixture();
    const items = '0x0000000000000000000000000000000000000016' as const;
    const pile = '0x0000000000000000000000000000000000000033' as const;
    const m3 = { ...target, itemLedger: items, pile };
    const [claimOk, syncOk, approveOk, redeemOk, seedOk] = [
      { to: items, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'claim', args: [[7n], owner] }), value: 0n },
      { to: items, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'sync', args: [32n] }), value: 0n },
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pile, amount] }), value: 0n },
      { to: pile, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'redeem', args: [amount, 1n, owner] }), value: 0n },
      { to: pile, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'returnSeed' }), value: 0n },
    ] as const;
    const ok = [claimOk, syncOk, approveOk, redeemOk, seedOk];
    for (const call of ok) await expect(submitWrite({ ...options, target: m3, call })).resolves.toBe(hash);
    const bad = [
      { target: m3, call: { ...claimOk, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'claim', args: [[7n, 8n], owner] }) } },
      { target: m3, call: { ...claimOk, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'claim', args: [[0n], owner] }) } },
      { target: m3, call: { ...claimOk, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'claim', args: [[7n], other] }) } },
      { target: m3, call: { ...claimOk, to: coordinator } },
      { target: target, call: claimOk },
      { target: m3, call: { ...syncOk, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'sync', args: [0n] }) } },
      { target: m3, call: { ...syncOk, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'sync', args: [33n] }) } },
      { target: target, call: approveOk },
      { target: m3, call: { ...redeemOk, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'redeem', args: [amount, 0n, owner] }) } },
      { target: m3, call: { ...redeemOk, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'redeem', args: [0n, 1n, owner] }) } },
      { target: m3, call: { ...redeemOk, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'redeem', args: [amount, 1n, other] }) } },
      { target: target, call: seedOk },
      { target: { ...m3, pile: items }, call: seedOk },
    ];
    for (const { target: t, call } of bad) await expect(submitWrite({ ...options, target: t, call })).rejects.toBeInstanceOf(NotSendableError);
    expect(wallet.mock.calls.filter(([request]) => request.method === 'eth_sendTransaction')).toHaveLength(ok.length);
  });

  it('sends item approvals, gives, T approvals, picks and additions only to the prepared shop and its listed collections (SH-V21-FE13)', async () => {
    const { wallet, options } = fixture();
    const shop = '0x0000000000000000000000000000000000000034' as const;
    const nft = '0x00000000000000000000000000000000000000a1' as const;
    const added = '0x00000000000000000000000000000000000000a2' as const;
    const m2 = { ...target, shop, shopCollections: [nft] };
    const item = 7n; const price = 10n ** 18n;
    const [itemOk, itemZeroOk, giveOk, approveOk, pickOk, addOk] = [
      { to: nft, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [shop, item] }), value: 0n },
      // An outside collection may number an item 0.
      { to: nft, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [shop, 0n] }), value: 0n },
      { to: shop, data: encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'give', args: [nft, item, price] }), value: 0n },
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [shop, 2n * price] }), value: 0n },
      { to: shop, data: encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'pick', args: [nft, item, 2n * price, owner] }), value: 0n },
      { to: shop, data: encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'addCollection', args: [added, 3] }), value: 0n },
    ] as const;
    const ok = [itemOk, itemZeroOk, giveOk, approveOk, pickOk, addOk];
    for (const call of ok) await expect(submitWrite({ ...options, target: m2, call })).resolves.toBe(hash);
    const give = (collection: `0x${string}`, minT: bigint) => ({ ...giveOk, data: encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'give', args: [collection, item, minT] }) });
    const pick = (collection: `0x${string}`, maxT: bigint, to: `0x${string}`) => ({ ...pickOk, data: encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'pick', args: [collection, item, maxT, to] }) });
    const add = (collection: `0x${string}`, tier: number) => ({ ...addOk, data: encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'addCollection', args: [collection, tier] }) });
    const bad = [
      // No shop on the target: none of the shop's calls, and no collections without it.
      { target, call: giveOk }, { target, call: pickOk }, { target, call: addOk }, { target, call: approveOk }, { target, call: itemOk },
      { target: { ...target, shopCollections: [nft] }, call: approveOk },
      // An item approval for anyone but the shop, or on a contract the shop does not list.
      { target: m2, call: { ...itemOk, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [other, item] }) } },
      { target: m2, call: { ...itemOk, to: added } },
      // A give or a pick naming an unlisted collection, sent elsewhere, with no minimum or maximum, or paying another.
      { target: m2, call: give(added, price) }, { target: m2, call: give(nft, 0n) }, { target: m2, call: { ...giveOk, to: coordinator } },
      { target: m2, call: pick(added, price, owner) }, { target: m2, call: pick(nft, 0n, owner) }, { target: m2, call: pick(nft, price, other) },
      // T approvals: still only the coordinator, the pile or the shop, for a positive amount.
      { target: m2, call: { ...approveOk, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [shop, 0n] }) } },
      // An addition of a listed collection, a box role, the zero address, or a tier past 4.
      { target: m2, call: add(nft, 0) }, { target: m2, call: add(token, 0) }, { target: m2, call: add('0x0000000000000000000000000000000000000000', 0) }, { target: m2, call: add(added, 4) },
      // Collections that are box roles, twice listed or zero; a shop that is another role.
      { target: { ...m2, shopCollections: [token] }, call: giveOk }, { target: { ...m2, shopCollections: [nft, nft] }, call: giveOk },
      { target: { ...m2, shopCollections: ['0x0000000000000000000000000000000000000000' as const] }, call: giveOk }, { target: { ...m2, shop: coordinator }, call: giveOk },
    ];
    for (const { target: t, call } of bad) await expect(submitWrite({ ...options, target: t, call })).rejects.toBeInstanceOf(NotSendableError);
    expect(wallet.mock.calls.filter(([request]) => request.method === 'eth_sendTransaction')).toHaveLength(ok.length);
  });
});

