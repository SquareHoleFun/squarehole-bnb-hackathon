import { describe, expect, expectTypeOf, it } from 'vitest';
import { IdentityError } from '../errors';
import {
  CORE_CHAIN_IDS,
  chainOfAssetId,
  collectionId,
  erc20AssetId,
  isAssetId,
  isMockAssetId,
  launchId,
  launchIdFromPairId,
  launchIdToPairId,
  marketId,
  mockAssetId,
  nativeAssetId,
  nftId,
  nftTokenId,
  parseAssetId,
  parseCollectionId,
  parseLaunchId,
  parseMarketId,
  parseNftId,
  policyId,
  toChainId,
  type AssetId,
  type ChainId,
  type CollectionId,
  type LaunchId,
  type NftTokenId,
} from './index';

const ADDR = '0x00000000000000000000000000000000000000Aa';
const LOWER = '0x00000000000000000000000000000000000000aa';
const POOL = `0x${'ab'.repeat(32)}`;
const MAX_UINT256 = 2n ** 256n - 1n;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof IdentityError ? error.code : `unexpected ${String(error)}`;
  }
  return undefined;
}

describe('chain ids', () => {
  it('names the three chains the core model knows', () => {
    expect(CORE_CHAIN_IDS).toEqual({ ethereum: 1, sepolia: 11_155_111, localDemo: 31_337 });
  });

  it('accepts positive safe integers only', () => {
    expect(toChainId(1)).toBe(1);
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined, Number.NaN]) {
      expect(code(() => toChainId(bad))).toBe('malformed_chain_id');
    }
  });
});

describe('asset ids (CAIP-19 for chain assets, mock:<name> for demo assets)', () => {
  it('formats native ETH and ERC-20 ids with a lowercase address', () => {
    expect(nativeAssetId(toChainId(1))).toBe('eip155:1/slip44:60');
    expect(erc20AssetId(toChainId(11_155_111), ADDR)).toBe(`eip155:11155111/erc20:${LOWER}`);
  });

  it('parses each kind and keeps chain and address', () => {
    expect(parseAssetId('eip155:1/slip44:60')).toEqual({ kind: 'native', id: 'eip155:1/slip44:60', chainId: 1, address: null });
    expect(parseAssetId(`eip155:1/erc20:${ADDR}`)).toEqual({ kind: 'erc20', id: `eip155:1/erc20:${LOWER}`, chainId: 1, address: LOWER });
    expect(parseAssetId('mock:Q')).toEqual({ kind: 'mock', id: 'mock:Q', chainId: null, address: null });
  });

  it('keeps mock ids apart from chain ids', () => {
    expect(isMockAssetId(mockAssetId('Q'))).toBe(true);
    expect(isMockAssetId(nativeAssetId(toChainId(1)))).toBe(false);
    expect(isMockAssetId('mock:')).toBe(false);
    expect(chainOfAssetId(mockAssetId('FIT'))).toBeNull();
    expect(chainOfAssetId(nativeAssetId(toChainId(11_155_111)))).toBe(11_155_111);
  });

  it('rejects malformed ids', () => {
    const bad = [
      '',
      'eip155:0/slip44:60',
      'eip155:01/slip44:60',
      'eip155:1/slip44:61',
      'eip155:1/erc20:0x123',
      `eip155:1/erc20:${LOWER} `,
      `eip155:1/erc721:${LOWER}`,
      'eip155:1/erc20:0x0000000000000000000000000000000000000000',
      'mock:',
      'mock:q q',
      'MOCK:Q',
      `1:${LOWER}`,
    ];
    for (const value of bad) {
      expect(isAssetId(value), value).toBe(false);
      expect(code(() => parseAssetId(value)), value).toBe('malformed_id');
    }
  });
});

describe('collection, NFT, launch, market and policy ids', () => {
  it('collection ids are CAIP-19 erc721 ids on a chain', () => {
    const id = collectionId(toChainId(1), ADDR);
    expect(id).toBe(`eip155:1/erc721:${LOWER}`);
    expect(parseCollectionId(id)).toEqual({ id, chainId: 1, address: LOWER });
    expect(code(() => parseCollectionId(`eip155:1/erc20:${LOWER}`))).toBe('malformed_id');
  });

  it('NFT token ids are uint256 decimal strings', () => {
    expect(nftTokenId('0')).toBe('0');
    expect(nftTokenId(42n)).toBe('42');
    expect(nftTokenId(MAX_UINT256)).toBe(MAX_UINT256.toString());
    for (const bad of ['01', '-1', '1.0', '1e3', ' 1', (MAX_UINT256 + 1n).toString()]) {
      expect(code(() => nftTokenId(bad)), bad).toBe('malformed_id');
    }
    expect(code(() => nftTokenId(-1n))).toBe('malformed_id');
  });

  it('an NFT id binds the token id to its collection', () => {
    const collection = collectionId(toChainId(1), ADDR);
    const id = nftId(collection, nftTokenId('7'));
    expect(id).toBe(`eip155:1/erc721:${LOWER}/7`);
    expect(parseNftId(id)).toEqual({ id, collection, chainId: 1, tokenId: '7' });
    expect(code(() => parseNftId(`${collection}/07`))).toBe('malformed_id');
  });

  it('launch ids reuse the existing pair id format', () => {
    const id = launchId(toChainId(11_155_111), ADDR);
    expect(id).toBe(`11155111:${LOWER}`);
    expect(parseLaunchId(id)).toEqual({ id, chainId: 11_155_111, address: LOWER });
    expect(launchIdFromPairId(`11155111:${ADDR}`)).toBe(id);
    expect(launchIdToPairId(id)).toBe(`11155111:${LOWER}`);
    expect(code(() => parseLaunchId('0:0x00'))).toBe('malformed_id');
  });

  it('market ids name a Uniswap v4 pool on one chain', () => {
    const id = marketId(toChainId(1), POOL);
    expect(id).toBe(`eip155:1/uniswap-v4-pool:${POOL}`);
    expect(parseMarketId(id)).toEqual({ id, chainId: 1, venue: 'uniswap-v4', poolId: POOL });
    expect(code(() => marketId(toChainId(1), '0x1234'))).toBe('malformed_id');
  });

  it('policy ids are upper-case names', () => {
    expect(policyId('MISFITS_FEES_F23')).toBe('MISFITS_FEES_F23');
    for (const bad of ['', 'ab', 'lower_case', 'HAS SPACE', `A${'B'.repeat(64)}`]) {
      expect(code(() => policyId(bad)), bad).toBe('malformed_id');
    }
  });
});

describe('ids are distinct types', () => {
  it('brands keep identities from mixing at compile time', () => {
    expectTypeOf<CollectionId>().not.toEqualTypeOf<AssetId>();
    expectTypeOf<LaunchId>().not.toEqualTypeOf<AssetId>();
    expectTypeOf<NftTokenId>().not.toEqualTypeOf<string>();
    expectTypeOf<ChainId>().not.toEqualTypeOf<number>();
    // @ts-expect-error a plain string is not an asset id
    const asset: AssetId = 'eip155:1/slip44:60';
    // @ts-expect-error a collection id is not an asset id
    const fromCollection: AssetId = collectionId(toChainId(1), ADDR);
    // @ts-expect-error a plain number is not a chain id
    const chain: ChainId = 1;
    expect([asset, fromCollection, chain]).toHaveLength(3);
  });
});
