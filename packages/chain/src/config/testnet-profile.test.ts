/**
 * SH-258: the test-network profile. The default build (no `SH_TESTNET`) is Sepolia with today's values; `SH_TESTNET=bnb`
 * makes BNB Chain testnet (97) the test-network slot of the read side, the write side and the wallet. The BNB cases
 * load the modules again with the setting stubbed (the profile is chosen once, when the chain table loads).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sepoliaChains from './chains';
import * as sepoliaConfig from './config';
import * as sepoliaWrite from '../write/chains';
import { TESTNET_PROFILES, readTestnetSetting, testnetNameOf, testnetProfileOfChain } from './testnet-profile';
import { InjectedWalletSession } from '../write/injected-wallet';
import { parseDeploymentManifest } from './manifest';
import { encodeAbiParameters, keccak256, type Address } from 'viem';
import { syntheticSepoliaManifestJson } from '../test-support/fixtures';

type Request = { method: string; params?: unknown };

/** A wallet that knows only `known` chains and answers 4902 to a switch to any other. */
function fakeWallet(known: number[], start: number) {
  const requests: Request[] = [];
  let chainId = start;
  const chains = new Set(known);
  return {
    requests,
    get chainId() {
      return chainId;
    },
    async request(args: Request): Promise<unknown> {
      requests.push(args);
      switch (args.method) {
        case 'eth_requestAccounts':
          return ['0x00000000000000000000000000000000000000a1'];
        case 'eth_chainId':
          return `0x${chainId.toString(16)}`;
        case 'wallet_switchEthereumChain': {
          const id = Number.parseInt((args.params as [{ chainId: string }])[0].chainId, 16);
          if (!chains.has(id)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
          chainId = id;
          return null;
        }
        case 'wallet_addEthereumChain':
          chains.add(Number.parseInt((args.params as [{ chainId: string }])[0].chainId, 16));
          return null;
        default:
          throw new Error(`unexpected ${args.method}`);
      }
    },
  };
}

const META = { id: 'test', name: 'Test Wallet', rdns: 'org.example.wallet', source: 'eip6963' as const };

async function loadBnb() {
  vi.stubEnv('SH_TESTNET', 'bnb');
  vi.resetModules();
  const [chains, config, write, wallet, profile] = await Promise.all([
    import('./chains'),
    import('./config'),
    import('../write/chains'),
    import('../write/injected-wallet'),
    import('./testnet-profile'),
  ]);
  return { chains, config, write, wallet, profile };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the setting', () => {
  it('unset, empty or "sepolia" is Sepolia; "bnb" is BNB Chain testnet; anything else throws', () => {
    expect(testnetNameOf(undefined)).toBe('sepolia');
    expect(testnetNameOf('')).toBe('sepolia');
    expect(testnetNameOf('sepolia')).toBe('sepolia');
    expect(testnetNameOf('bnb')).toBe('bnb');
    for (const bad of ['BNB', 'bsc', '97', 'mainnet', ' bnb']) expect(() => testnetNameOf(bad)).toThrow(/SH_TESTNET must be unset, "sepolia" or "bnb"/);
  });

  it('is read from the process environment in Node', () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    expect(readTestnetSetting()).toBe('bnb');
  });

  it('a misspelt setting fails when the chain table loads', async () => {
    vi.stubEnv('SH_TESTNET', 'bsc');
    vi.resetModules();
    await expect(import('./networks')).rejects.toThrow(/SH_TESTNET must be unset/);
  });

  it('profiles by chain id: 11155111 and 97 only', () => {
    expect(testnetProfileOfChain(11_155_111)).toBe(TESTNET_PROFILES.sepolia);
    expect(testnetProfileOfChain(97)).toBe(TESTNET_PROFILES.bnb);
    for (const other of [1, 56, 31_337, '97', null]) expect(testnetProfileOfChain(other)).toBeNull();
  });
});

describe('the profile table', () => {
  it('BNB Chain testnet: id, names, coin, RPCs, explorer, Multicall3, pacing, finality, add-chain and switches', () => {
    const bnb = TESTNET_PROFILES.bnb;
    expect(bnb).toEqual({
      name: 'bnb',
      chainId: 97,
      manifestNetwork: 'bnb-testnet',
      networkName: 'BNB Chain Testnet',
      badgeName: 'BNB Chain',
      dataLabel: 'BNB Chain testnet',
      coin: { name: 'BNB', walletSymbol: 'tBNB', symbol: 'BNB' },
      publicRpcUrls: ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-prebsc-dataseed.bnbchain.org'],
      rpcProviders: 'PublicNode and BNB Chain',
      explorers: [{ id: 'bscscan-testnet', name: 'BscScan (Testnet)', origin: 'https://testnet.bscscan.com' }],
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
      uniswap: null,
      blockTimeMs: 450,
      snapshotTag: 'finalized',
      staleAfterMs: 300_000,
      logs: { initialRange: 5_000, maxRange: 50_000 },
      requestTimeoutMs: 12_000,
      receiptTimeoutMs: 120_000,
      pollIntervalMs: 1_000,
      addChain: {
        chainId: '0x61',
        chainName: 'BNB Chain Testnet',
        nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
        rpcUrls: ['https://bsc-testnet-dataseed.bnbchain.org', 'https://bsc-testnet.bnbchain.org'],
        blockExplorerUrls: ['https://testnet.bscscan.com'],
      },
      switches: { alphaGate: true, alphaOpen: true, cowSales: false, box0: false, draws: false, arweavePictures: true },
    });
    expect(Object.isFrozen(bnb) && Object.isFrozen(bnb.switches) && Object.isFrozen(bnb.publicRpcUrls)).toBe(true);
  });

  it('the read list never holds an endpoint that refuses eth_getLogs (the two official dataseed endpoints)', () => {
    for (const refuses of ['https://bsc-testnet-dataseed.bnbchain.org', 'https://bsc-testnet.bnbchain.org']) {
      expect(TESTNET_PROFILES.bnb.publicRpcUrls).not.toContain(refuses);
    }
  });

  it('Sepolia keeps every value it had before the profile, every switch it had on, and the open-site alpha off (SH-275)', () => {
    const s = TESTNET_PROFILES.sepolia;
    expect(s.manifestNetwork).toBe('sepolia');
    expect([s.chainId, s.networkName, s.coin.name, s.coin.walletSymbol, s.coin.symbol]).toEqual([11_155_111, 'Sepolia', 'Sepolia Ether', 'SepoliaETH', 'ETH']);
    expect([s.blockTimeMs, s.snapshotTag, s.staleAfterMs, s.logs, s.requestTimeoutMs, s.receiptTimeoutMs, s.pollIntervalMs, s.addChain]).toEqual([
      12_000, 'safe', 900_000, { initialRange: 5_000, maxRange: 10_000 }, 12_000, 600_000, 4_000, null,
    ]);
    expect(s.switches).toEqual({ alphaGate: true, alphaOpen: false, cowSales: true, box0: true, draws: true, arweavePictures: true });
  });
});

describe('the default build (no SH_TESTNET): Sepolia, unchanged', () => {
  it('chain table, read config and write chain', () => {
    expect(sepoliaChains.TESTNET.name).toBe('sepolia');
    expect([sepoliaChains.TESTNET_CHAIN_ID, sepoliaChains.SEPOLIA_CHAIN_ID]).toEqual([11_155_111, 11_155_111]);
    expect([...sepoliaChains.SUPPORTED_CHAIN_IDS]).toEqual([31_337, 11_155_111]);
    expect(sepoliaChains.isSupportedChainId(97)).toBe(false);
    expect(sepoliaChains.TESTNET_UNISWAP_V4).toEqual(sepoliaChains.SEPOLIA_UNISWAP_V4);
    expect(() => sepoliaConfig.createChainConfig({ chainId: 97 })).toThrow(/not supported \(only 31337 and 11155111/);
    expect(() => sepoliaChains.viemChain(97, ['https://bsc-testnet-rpc.publicnode.com'])).toThrow(/not this build's test network/);
    expect(() => sepoliaWrite.writeChain(97)).toThrow(sepoliaWrite.UnsupportedWriteChainError);
    expect(sepoliaWrite.writeChain(11_155_111).addChain).toBeNull();
  });
});

describe('SH_TESTNET=bnb', () => {
  it('the chain table: 97 is the test-network slot, 11155111 is not supported', async () => {
    const { chains } = await loadBnb();
    expect(chains.TESTNET.name).toBe('bnb');
    expect([chains.TESTNET_CHAIN_ID, chains.SEPOLIA_CHAIN_ID]).toEqual([97, 97]);
    expect([...chains.SUPPORTED_CHAIN_IDS]).toEqual([31_337, 97]);
    expect([chains.isSupportedChainId(97), chains.isSupportedChainId(11_155_111), chains.isSupportedChainId(56), chains.isSupportedChainId(1)]).toEqual([true, false, false, false]);
    expect(chains.NETWORKS[97]).toEqual({ name: 'BNB Chain Testnet', nativeName: 'BNB', nativeSymbol: 'tBNB' });
    expect(chains.SEPOLIA_PUBLIC_RPC_URLS).toEqual(['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-prebsc-dataseed.bnbchain.org']);
    expect(chains.SEPOLIA_EXPLORERS.map((e) => e.origin)).toEqual(['https://testnet.bscscan.com']);
    expect(chains.SEPOLIA_MULTICALL3).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
    expect(chains.TESTNET_UNISWAP_V4).toBeNull();
    // Sepolia's own identities keep their values whatever the build.
    expect(chains.SEPOLIA_UNISWAP_V4.poolManager).toBe('0xE03A1074c86CFeDd5C142C4F04F1a1536e203543');
  });

  it('the viem chain of 97: coin, explorer, Multicall3; 11155111 is refused', async () => {
    const { chains } = await loadBnb();
    const chain = chains.viemChain(97, ['https://bsc-testnet-rpc.publicnode.com']);
    expect(chain.id).toBe(97);
    expect(chain.name).toBe('BNB Chain Testnet');
    expect(chain.nativeCurrency).toEqual({ name: 'BNB', symbol: 'tBNB', decimals: 18 });
    expect(chain.blockExplorers?.default).toEqual({ name: 'BscScan (Testnet)', url: 'https://testnet.bscscan.com' });
    expect(chain.contracts?.multicall3?.address).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
    expect(() => chains.viemChain(11_155_111, ['https://ethereum-sepolia-rpc.publicnode.com'])).toThrow(/not this build's test network \(97\)/);
    expect(chains.viemChain(31_337, ['http://127.0.0.1:8545']).id).toBe(31_337);
  });

  it('the read config of 97 takes every policy from the profile; https only; Sepolia refused', async () => {
    const { config } = await loadBnb();
    const c = config.createChainConfig({ chainId: 97 });
    expect(c.deployment).toEqual({ status: 'not_deployed', reason: expect.stringMatching(/not deployed on BNB Chain Testnet/) });
    expect([c.label, c.kind, c.snapshotTag, c.staleAfterMs, c.requestTimeoutMs, c.multicall3]).toEqual([
      'BNB Chain testnet', 'testnet', 'finalized', 300_000, 12_000, '0xcA11bde05977b3631167028862bE2a173976CA11',
    ]);
    expect(c.rpcUrls).toEqual(['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-prebsc-dataseed.bnbchain.org']);
    expect(c.logs).toEqual({ initialRange: 5_000, maxRange: 50_000, minRange: 1 });
    expect(c.explorers.map((e) => e.origin)).toEqual(['https://testnet.bscscan.com']);
    expect(() => config.createChainConfig({ chainId: 97, rpcUrls: ['http://bsc-testnet-rpc.publicnode.com'] })).toThrow(/BNB Chain Testnet RPC URLs must use https/);
    expect(() => config.createChainConfig({ chainId: 11_155_111 })).toThrow(/not supported \(only 31337 and 97/);
  });

  it("the profile's PoolManager: on 97 the manifest's own (no canonical one), with no lens", async () => {
    const { config } = await loadBnb();
    // The synthetic Sepolia pair-registry manifest, re-labelled for chain 97 (TEST ONLY: nothing of it is deployed).
    const manifest = syntheticSepoliaManifestJson();
    manifest.chainId = 97;
    for (const launch of Object.values(manifest.launches as Record<string, Record<string, unknown>>)) {
      const token = ((launch.contracts as Record<string, { address: string }>).token as { address: string }).address;
      launch.appPairId = `97:${token.toLowerCase()}`;
      launch.pairId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [97n, token as Address]));
    }
    const ownPoolManager = '0x9700000000000000000000000000000000000001';
    (manifest.contracts as { poolManager: { address: string } }).poolManager.address = ownPoolManager;
    const c = config.createChainConfig({ chainId: 97, manifest });
    expect(c.deployment.status).toBe('deployed');
    expect(c.uniswap).toEqual({ poolManager: parseDeploymentManifest(manifest).contracts.poolManager.address, stateView: null, v4Quoter: null });
    expect(c.uniswap?.poolManager.toLowerCase()).toBe(ownPoolManager);
  });

  it('the write chain of 97: tBNB, finalized tag, BscScan, add-chain parameters; 11155111 refused', async () => {
    const { write } = await loadBnb();
    const chain = write.writeChain(97);
    expect(chain).toEqual({
      chainId: 97,
      name: 'BNB Chain Testnet',
      nativeSymbol: 'tBNB',
      finality: { kind: 'finalized_tag' },
      receiptTimeoutMs: 120_000,
      pollIntervalMs: 1_000,
      explorerOrigin: 'https://testnet.bscscan.com',
      addChain: {
        chainId: '0x61',
        chainName: 'BNB Chain Testnet',
        nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
        rpcUrls: ['https://bsc-testnet-dataseed.bnbchain.org', 'https://bsc-testnet.bnbchain.org'],
        blockExplorerUrls: ['https://testnet.bscscan.com'],
      },
      maxTxGas: 16_777_216n,
    });
    expect(write.TESTNET_WRITE_CHAIN).toBe(chain);
    expect([...write.WRITE_CHAIN_IDS]).toEqual([31_337, 97]);
    expect([write.isWriteChainId(97), write.isWriteChainId(11_155_111)]).toEqual([true, false]);
    expect(() => write.writeChain(11_155_111)).toThrow(/sends only on the local chain \(31337\) and BNB Chain Testnet \(97\)/);
    expect(write.chainIdHex(97)).toBe('0x61');
  });

  it('a wallet that does not know 97 is offered it (wallet_addEthereumChain after 4902), then switched', async () => {
    const { wallet: w } = await loadBnb();
    const wallet = fakeWallet([11_155_111], 11_155_111);
    const session = new w.InjectedWalletSession(wallet, META);
    await session.connect();
    await session.switchChain(97);
    expect(wallet.chainId).toBe(97);
    expect(wallet.requests.slice(2).map((r) => r.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
    expect(wallet.requests[3]?.params).toEqual([TESTNET_PROFILES.bnb.addChain]);
    // A wallet that knows 97 is only switched.
    const knows = fakeWallet([97], 11_155_111);
    const s2 = new w.InjectedWalletSession(knows, META);
    await s2.connect();
    await s2.switchChain(97);
    expect(knows.requests.map((r) => r.method)).not.toContain('wallet_addEthereumChain');
    // Sepolia is not a write chain of this build.
    await expect(s2.switchChain(11_155_111)).rejects.toMatchObject({ code: 'unsupported_chain' });
  });

  it('the default build never offers 97 to a wallet', async () => {
    const wallet = fakeWallet([11_155_111], 11_155_111);
    const session = new InjectedWalletSession(wallet, META);
    await session.connect();
    await expect(session.switchChain(97)).rejects.toMatchObject({ code: 'unsupported_chain' });
    expect(wallet.requests.map((r) => r.method)).toEqual(['eth_requestAccounts', 'eth_chainId']);
  });
});
