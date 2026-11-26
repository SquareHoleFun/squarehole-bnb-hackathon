import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { parseRoute } from '../src/App';
import { cardNameOf, inlineMetadata, pictureAddressOf, RAW_CID, shortNames } from '../src/lib/card-picture';
import { checkConfig } from '../src/lib/config';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { CONTRACT_ERRORS, decodeError, ERROR_SENTENCES, SHOP_ERRORS, STAKE_ERRORS, sentenceOf } from '../src/lib/errors';
import { CARDS_SHOWN, cardsLine, giveBlock, giveRefusal, linkedShops, makerOf, ownCardsOf, ownGroup, pickPriceOf, readShopInfo } from '../src/lib/shop';
import { forgetScans } from '../src/lib/logs';
import { shopAbi, shopFactoryAbi } from '../src/abi/shop';

// SH-288: a card shop for a token launched on Flap or Four.meme (bounties/core RailShop), the page's model.

const CID = 'bafkreifscwrzjanxh2ohdns2tfc6xtbd6uurkj4wq75nnsmnj52xmz5fjy';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const uri = (meta: unknown) => `data:application/json;base64,${b64(JSON.stringify(meta))}`;

describe('a card picture from the card’s own tokenURI', () => {
  it('our test cards: inline base64 JSON with ipfs://<raw CID> -> the site’s own /ipfs/<cid>, and the card’s name', () => {
    expect(RAW_CID.test(CID)).toBe(true);
    const u = uri({ name: 'Paper Boat', image: `ipfs://${CID}`, attributes: [] });
    expect(pictureAddressOf(u)).toBe(`/ipfs/${CID}`);
    expect(cardNameOf(u)).toBe('Paper Boat');
    expect(pictureAddressOf(`data:application/json,${encodeURIComponent(JSON.stringify({ image: `ipfs://${CID}` }))}`)).toBe(`/ipfs/${CID}`);
  });
  it('anything else is no picture: another host, another CID form, a path, metadata behind a link, broken JSON, too long', () => {
    expect(pictureAddressOf(uri({ image: 'https://example.com/a.png' }))).toBeNull();
    expect(pictureAddressOf(uri({ image: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' }))).toBeNull();
    expect(pictureAddressOf(uri({ image: `ipfs://${CID}/1.png` }))).toBeNull();
    expect(pictureAddressOf(uri({ image: `ipfs://${CID.toUpperCase()}` }))).toBeNull();
    expect(pictureAddressOf(uri({ image: `/ipfs/${CID}` }))).toBeNull();
    expect(pictureAddressOf(`ipfs://${CID}`)).toBeNull();
    expect(pictureAddressOf('https://example.com/meta.json')).toBeNull();
    expect(pictureAddressOf('data:application/json;base64,!!!')).toBeNull();
    expect(pictureAddressOf(`data:application/json;base64,${b64('{"image":')}`)).toBeNull();
    expect(pictureAddressOf(uri({ image: 7 }))).toBeNull();
    expect(inlineMetadata(uri({ image: `ipfs://${CID}`, pad: 'x'.repeat(70_000) }))).toBeNull();
  });
});

describe('the cards’ short names', () => {
  const a = '0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174';
  const b = '0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577';
  it('the words all names share leave; one name stays whole; no name: the short address', () => {
    expect([...shortNames([{ address: a, name: 'Test Trading Cards Common' }, { address: b, name: 'Test Trading Cards Uncommon' }]).values()]).toEqual(['Common', 'Uncommon']);
    expect([...shortNames([{ address: a, name: 'Test Trading Cards Common' }]).values()]).toEqual(['Test Trading Cards Common']);
    expect([...shortNames([{ address: a, name: null }]).values()]).toEqual(['0x675A…A174']);
  });
});

describe('prices and the give check', () => {
  it('the pick price is the give price plus its part, rounded up, as the contract has it', () => {
    expect(pickPriceOf(1_000_000n, 10_000)).toBe(2_000_000n);
    expect(pickPriceOf(1_000_000n, 2_500)).toBe(1_250_000n);
    expect(pickPriceOf(3n, 3_333)).toBe(4n);
  });
  it('a give waits for the budget first, then the week’s cap; at the edges it is paid', () => {
    expect(giveBlock({ budget: 99n, capLeft: 1_000n }, 100n)).toBe('budget');
    expect(giveBlock({ budget: 1_000n, capLeft: 99n }, 100n)).toBe('cap');
    expect(giveBlock({ budget: 100n, capLeft: 100n }, 100n)).toBeNull();
  });
  it('every refusal of the shop and its factory reads as one sentence, in their own maps', () => {
    for (const e of shopAbi.filter((x) => x.type === 'error')) expect(SHOP_ERRORS[e.name], e.name).toMatch(/\.$/);
    for (const e of shopFactoryAbi.filter((x) => x.type === 'error')) expect(SHOP_ERRORS[e.name], e.name).toMatch(/\.$/);
  });
});

describe('only shops our factory made', () => {
  const FACTORY = '0x00000000000000000000000000000000000000f1' as Address;
  const SHOP = '0x00000000000000000000000000000000000000a1' as Address;
  const base = { chainId: 97, rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'], explorer: 'https://testnet.bscscan.com', fromBlock: '1' };
  const config = (extra: object = {}) => {
    const r = checkConfig({ ...base, ...extra });
    if (!r.ok) throw new Error(r.problem);
    return r.value;
  };
  it('the deployment file takes an optional shops.factory; a bad one refuses the file', () => {
    expect(config().shops).toBeUndefined();
    expect(config({ shops: { factory: FACTORY } }).shops).toEqual({ factory: FACTORY });
    expect(checkConfig({ ...base, shops: { factory: 'nope' } }).ok).toBe(false);
    expect(checkConfig({ ...base, shops: { factory: FACTORY, extra: 1 } }).ok).toBe(false);
  });
  it('without a factory nothing is read; a shop the factory did not make is not shown; one not created yet says so', async () => {
    const calls: string[] = [];
    let code = '0x6080';
    const client = {
      readContract: async (q: { functionName: string }) => { calls.push(q.functionName); return false; },
      getCode: async () => { calls.push('getCode'); return code; },
    } as unknown as PublicClient;
    expect(await readShopInfo(client, config(), SHOP)).toEqual({ kind: 'no-factory' });
    expect(await linkedShops(client, config(), SHOP, { creator: SHOP })).toEqual([]);
    expect(calls).toEqual([]);
    expect(await readShopInfo(client, config({ shops: { factory: FACTORY } }), SHOP)).toEqual({ kind: 'not-ours' });
    expect(calls).toEqual(['isShop', 'getCode']);
    code = '0x';
    expect(await readShopInfo(client, config({ shops: { factory: FACTORY } }), SHOP)).toEqual({ kind: 'not-created' });
  });
  it('the route #/shop/<address>', () => {
    expect(parseRoute(`#/shop/${SHOP}`)).toEqual({ name: 'shop', address: SHOP });
    expect(parseRoute('#/shop/nope')).toEqual({ name: 'unknown' });
  });
});

describe('which of a token’s shops a launch’s page links to', () => {
  const FACTORY = '0x00000000000000000000000000000000000000f1' as Address;
  const TOKEN = '0x00000000000000000000000000000000000000b1' as Address;
  const NAMED = '0x00000000000000000000000000000000000000a1' as Address;
  const OTHER_TOKEN_SHOP = '0x00000000000000000000000000000000000000a3' as Address;
  const NOT_OURS = '0x00000000000000000000000000000000000000a9' as Address;
  const BY_CREATOR = '0x00000000000000000000000000000000000000a2' as Address;
  const CREATOR = '0x00000000000000000000000000000000000000c1' as Address;
  const r = checkConfig({ chainId: 97, rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'], explorer: 'https://testnet.bscscan.com', fromBlock: '1', shops: { factory: FACTORY } });
  if (!r.ok) throw new Error(r.problem);
  const config = r.value;
  const calls: string[] = [];
  const client = {
    readContract: async (q: { address: string; functionName: string; args?: unknown[] }) => {
      calls.push(q.functionName);
      if (q.functionName === 'isShop') return q.args?.[0] !== NOT_OURS;
      if (q.functionName === 'token') return q.address === OTHER_TOKEN_SHOP ? NOT_OURS : TOKEN;
      if (q.functionName === 'shopCountBy') return (q.args?.[1] as string) === CREATOR ? 1n : 0n;
      if (q.functionName === 'shopOfBy') return BY_CREATOR;
      throw new Error(`unexpected ${q.functionName}`);
    },
  } as unknown as PublicClient;
  it('the shops the rules name (ours, for this token) first; else only the launch creator’s own; never the open list', async () => {
    expect(await linkedShops(client, config, TOKEN, { payees: [NOT_OURS, OTHER_TOKEN_SHOP, NAMED], creator: CREATOR })).toEqual([NAMED]);
    expect(await linkedShops(client, config, TOKEN, { payees: [NOT_OURS], creator: CREATOR })).toEqual([BY_CREATOR]);
    expect(await linkedShops(client, config, TOKEN, { creator: '0x00000000000000000000000000000000000000ee' as Address })).toEqual([]);
    expect(await linkedShops(client, config, TOKEN, {})).toEqual([]);
    expect(calls).not.toContain('shopCount');
    expect(calls).not.toContain('shopOf');
  });
});

describe('error sentences keyed by contract (names collide across contracts)', () => {
  const reverted = (errorName: string) => new BaseError('x', {
    cause: new ContractFunctionRevertedError({ abi: shopAbi, data: encodeErrorResult({ abi: shopAbi, errorName } as never), functionName: 'give' }),
  });
  it('a press on the shop reads the shop’s sentence; the shared map holds none of the shop’s names', () => {
    expect(decodeError(reverted('TransferFailed'), 18, 'shop')).toEqual({ name: 'TransferFailed', sentence: 'A transfer did not go through.' });
    expect(decodeError(reverted('BadReceiver'), 18, 'shop').sentence).toBe('The card cannot go to that address.');
    expect(decodeError(reverted('BalanceUnreadable'), 18, 'shop').sentence).toBe('A balance could not be read, so nothing moved.');
    expect(decodeError(reverted('CapReached'), 18, 'shop').sentence).toBe('This week’s room for gives is too small for this card.');
    for (const name of ['TransferFailed', 'BadReceiver', 'BalanceUnreadable', 'CapReached']) expect(ERROR_SENTENCES[name], name).toBeUndefined();
    // Without the contract named, a shop name gets no shop sentence.
    expect(decodeError(reverted('TransferFailed')).sentence).toBe('The contract refused this call.');
  });
  it('the stake’s map and the shop’s side by side: a name reads its own contract’s sentence', () => {
    expect(Object.keys(CONTRACT_ERRORS).sort()).toEqual(['shop', 'stake']);
    expect(sentenceOf('NotAccepted', 'shop')).toBe('The shop factory does not take this.');
    expect(sentenceOf('NotAccepted', 'stake')).toBeUndefined();
    // The same names, each contract its own sentence.
    expect(sentenceOf('BadReceiver', 'stake')).toBe(STAKE_ERRORS.BadReceiver);
    expect(sentenceOf('BadReceiver', 'shop')).toBe('The card cannot go to that address.');
    expect(STAKE_ERRORS.BadReceiver).not.toBe(SHOP_ERRORS.BadReceiver);
    expect(sentenceOf('ZeroAmount', 'shop')).toBe(ERROR_SENTENCES.ZeroAmount);
  });
});

describe('a shop opened by its address: who made it', () => {
  const A = '0x00000000000000000000000000000000000000c1' as Address;
  const B = '0x00000000000000000000000000000000000000C2' as Address;
  it('the launch creator’s own, another’s, or unknown where the token’s launch is not on this page', () => {
    expect(makerOf(A, A.toUpperCase().replace('0X', '0x') as Address)).toBe('launch');
    expect(makerOf(A, B)).toBe('other');
    expect(makerOf(A, null)).toBe('unknown');
    expect(makerOf(A, undefined)).toBe('unknown');
  });
});

describe('the cards stat counts what the grid shows', () => {
  const card = { nft: '0x00000000000000000000000000000000000000d1' as Address, id: 1n };
  it('cards the shop lists but no longer owns are not counted; a list longer than read says so', () => {
    expect(cardsLine({ cards: [card, card], cardCount: 3n })).toEqual({ shown: 2n, listed: 3n, more: false });
    expect(cardsLine({ cards: [card], cardCount: CARDS_SHOWN + 1n })).toEqual({ shown: 1n, listed: CARDS_SHOWN + 1n, more: true });
  });
});

describe('the wallet’s own cards of the shop’s collections', () => {
  const W = '0x00000000000000000000000000000000000000e1' as Address;
  const N1 = '0x00000000000000000000000000000000000000d1' as Address;
  const N2 = '0x00000000000000000000000000000000000000d2' as Address;
  const r = checkConfig({ chainId: 97, rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'], explorer: 'https://testnet.bscscan.com', fromBlock: '1' });
  if (!r.ok) throw new Error(r.problem);
  const config = r.value;
  const info = { collections: [{ nft: N1, name: 'A', givePrice: 1n, pickPrice: 2n }, { nft: N2, name: 'B', givePrice: 1n, pickPrice: 2n }] };
  const burned = new BaseError('x', { cause: new ContractFunctionRevertedError({ abi: shopAbi, data: encodeErrorResult({ abi: shopAbi, errorName: 'NotHeld' } as never), functionName: 'ownerOf' }) });
  const client = (opts: { logs?: unknown; ownerFails?: boolean }) => {
    const queries: unknown[] = [];
    const c = {
      getBlockNumber: async () => 100n,
      getContractEvents: async (q: unknown) => { queries.push(q); if (opts.logs instanceof Error) throw opts.logs; return opts.logs; },
      readContract: async (q: { address: string; args: [bigint] }) => {
        const id = q.args[0];
        if (id === 3n) throw opts.ownerFails ? new Error('endpoint down') : burned;
        return id === 2n ? '0x00000000000000000000000000000000000000ff' : W;
      },
    } as unknown as PublicClient;
    return { c, queries };
  };
  it('one query for all the shop’s collections, each card then checked: sold or burned cards are not yours', async () => {
    forgetScans();
    const { c, queries } = client({ logs: [
      { address: N1, args: { tokenId: 1n } }, { address: N1.toLowerCase(), args: { tokenId: 1n } }, { address: '0x00000000000000000000000000000000000000d9', args: { tokenId: 9n } }, { address: N1, args: { tokenId: 2n } }, { address: N2, args: { tokenId: 3n } }, { address: N2, args: { tokenId: 4n } },
    ] });
    expect(await ownCardsOf(c, config, info, W)).toEqual([{ nft: N1, id: 1n }, { nft: N2, id: 4n }]);
    expect(queries).toHaveLength(1);
    expect((queries[0] as { address: unknown }).address).toEqual([N1, N2]);
    expect((queries[0] as { args: unknown }).args).toEqual({ to: W });
  });
  it('a failed read is never "no cards": it throws, for the page’s failure line and retry', async () => {
    forgetScans();
    await expect(ownCardsOf(client({ logs: new Error('refused') }).c, config, info, W)).rejects.toThrow();
    forgetScans();
    await expect(ownCardsOf(client({ logs: [{ address: N2, args: { tokenId: 3n } }], ownerFails: true }).c, config, info, W)).rejects.toThrow('endpoint down');
  });
});

describe('the give side’s lines (notes 1 and 2)', () => {
  it('a wallet with none of these cards reads one line, never a dead press; a failed read is not "none"', () => {
    expect(ownGroup(undefined, { state: 'ok', count: 0 })).toBe('connect');
    expect(ownGroup('0xabc', { state: 'loading' })).toBe('reading');
    expect(ownGroup('0xabc', { state: 'ok', count: 0 })).toBe('none');
    expect(ownGroup('0xabc', { state: 'ok', count: 2 })).toBe('cards');
    expect(ownGroup('0xabc', { state: 'error' })).toBe('failed');
  });
  it('the room’s refusal says when the room renews; the budget’s does not', () => {
    // 3 Dec 2026, 03:51 UTC.
    const ends = BigInt(Date.UTC(2026, 11, 3, 3, 51) / 1000);
    expect(giveRefusal('cap', ends)).toBe('This week’s room for gives is too small for this card; the room renews 3 Dec, 03:51 UTC.');
    expect(giveRefusal('cap', 0n)).toBe('This week’s room for gives is too small for this card.');
    expect(giveRefusal('budget', ends)).toBe('The shop’s budget is too small for this card.');
    expect(giveRefusal(null, ends)).toBeNull();
  });
});
