/**
 * Chain/address evidence for core v2 live manifests (SH-V2-T03): evidence is read from the chain, not typed by hand,
 * and any reader can re-check it later. Mocked transport only (FakeChain); no network.
 */
import {
  EMPTY_CODE_HASH,
  GENESIS_FIT_RAW,
  MISFITS_FEE_POLICY_F23,
  MISFITS_QUOTE_POLICY_DRAFT,
  MISFITS_VAULT_POLICY_F23,
  parseLiveManifest,
  safeParseLiveManifest,
  type LiveDeploymentManifest,
} from '@squarehole/domain/core';
import { keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { createChainClient, type ChainPublicClient } from '../client';
import { FakeChain } from '../test-support/fake-chain';
import { createChainConfig } from './config';
import { readAddressEvidence, verifyManifestEvidence, type AddressEvidence } from './core-evidence';

const SEPOLIA = 11_155_111;
const FIT: Address = '0x00000000000000000000000000000000000000f1';
const MISFITS: Address = '0x00000000000000000000000000000000000000f2';
const VAULT: Address = '0x00000000000000000000000000000000000000f3';
const CODE: Record<Address, Hex> = { [FIT]: '0x6001', [MISFITS]: '0x6002', [VAULT]: '0x6003' };

function setup(): { chain: FakeChain; client: ChainPublicClient } {
  const chain = new FakeChain(200n);
  chain.chainId = SEPOLIA;
  for (const [address, code] of Object.entries(CODE)) chain.setCode(address as Address, code);
  const client = createChainClient(createChainConfig({ chainId: SEPOLIA }), { transport: chain.transport() });
  return { chain, client };
}

/** A testnet manifest (open gates, not live-ready) whose evidence comes from the chain. */
function manifestJson(evidence: readonly AddressEvidence[]): Record<string, unknown> {
  const gates = ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09', 'G10', 'G11', 'G12', 'G13', 'G14'].map((id) => ({ id, status: 'OPEN' }));
  return {
    schema: 'squarehole.core-deployment/v2',
    environment: 'testnet',
    liveReady: false,
    chainId: SEPOLIA,
    intentHash: `0x${'1a'.repeat(32)}`,
    assets: {
      fit: { assetId: `eip155:${SEPOLIA}/erc20:${FIT}`, decimals: 18, symbol: 'FIT', initialSupplyRaw: GENESIS_FIT_RAW },
      q: { assetId: `eip155:${SEPOLIA}/slip44:60`, decimals: 18, symbol: 'ETH' },
    },
    collection: { collectionId: `eip155:${SEPOLIA}/erc721:${MISFITS}`, count: 4_200 },
    contracts: { fit: FIT, misfits: MISFITS, vault: VAULT, escrow: VAULT },
    evidence,
    policies: { fee: MISFITS_FEE_POLICY_F23, quote: MISFITS_QUOTE_POLICY_DRAFT, vault: MISFITS_VAULT_POLICY_F23 },
    gates,
    release: {
      sourceCommit: null,
      licenseReport: null,
      externalRoutes: null,
      feeIncidenceTable: null,
      mintGasReport: null,
      permissionGraph: null,
      securityReview: null,
      recoveryRunbook: null,
    },
    authorization: null,
  };
}

async function readAll(client: ChainPublicClient): Promise<AddressEvidence[]> {
  return Promise.all([FIT, MISFITS, VAULT].map((address) => readAddressEvidence(client, address, { finality: 'finalized' })));
}

describe('readAddressEvidence', () => {
  it('hashes eth_getCode at one finalized block and records the chain and block', async () => {
    const { chain, client } = setup();
    const evidence = await readAddressEvidence(client, FIT, { finality: 'finalized', expectedCodeHash: keccak256('0x6001') });
    expect(evidence).toEqual({
      chainId: SEPOLIA,
      address: FIT,
      method: 'eth_getCode',
      codeHash: keccak256('0x6001'),
      expectedCodeHash: keccak256('0x6001'),
      block: { number: '136', hash: chain.hashOf(136n) },
      finality: 'finalized',
    });
  });

  it('reads the latest block as confirmed', async () => {
    const { chain, client } = setup();
    const evidence = await readAddressEvidence(client, FIT, { finality: 'confirmed' });
    expect(evidence.block).toEqual({ number: '200', hash: chain.hashOf(200n) });
    expect(evidence.finality).toBe('confirmed');
  });

  it('an address with no code yields the empty code hash, which a live manifest rejects', async () => {
    const { chain, client } = setup();
    chain.setCode(VAULT, '0x');
    const evidence = await readAll(client);
    expect(evidence[2]?.codeHash).toBe(EMPTY_CODE_HASH);
    const result = safeParseLiveManifest(manifestJson(evidence));
    expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toContain('evidence.2.codeHash');
  });
});

describe('verifyManifestEvidence', () => {
  async function parsed(client: ChainPublicClient): Promise<LiveDeploymentManifest> {
    return parseLiveManifest(manifestJson(await readAll(client)));
  }

  it('evidence read from the chain makes a valid testnet manifest, and re-checks clean', async () => {
    const { client } = setup();
    const manifest = await parsed(client);
    expect(await verifyManifestEvidence(client, manifest)).toEqual([
      { address: FIT, ok: true },
      { address: MISFITS, ok: true },
      { address: VAULT, ok: true },
    ]);
  });

  it('finds changed code, removed code and a reorged evidence block', async () => {
    const { chain, client } = setup();
    const manifest = await parsed(client);
    chain.setCode(FIT, '0x60ff');
    chain.setCode(MISFITS, '0x');
    expect(await verifyManifestEvidence(client, manifest)).toEqual([
      { address: FIT, ok: false, reason: 'code_changed' },
      { address: MISFITS, ok: false, reason: 'no_code' },
      { address: VAULT, ok: true },
    ]);
    chain.reorg(100n, 'fork');
    expect((await verifyManifestEvidence(client, manifest)).map((check) => (check.ok ? 'ok' : check.reason))).toEqual([
      'block_hash_changed',
      'block_hash_changed',
      'block_hash_changed',
    ]);
  });

  it('refuses an RPC that serves another chain', async () => {
    const { chain, client } = setup();
    const manifest = await parsed(client);
    chain.chainId = 1;
    expect((await verifyManifestEvidence(client, manifest)).every((check) => !check.ok && check.reason === 'wrong_chain')).toBe(true);
  });
});
