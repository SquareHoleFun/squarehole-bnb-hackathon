/**
 * TEST SUPPORT (never bundled): a fake Square Hole deployment on a FakeChain. View calls are answered from in-memory
 * state; a mined `createLaunch` emits `PairCreated` and records the pair; a mined `claim` / `claimAsT` /
 * `claimAsQWhenSoldOut` emits its event and consumes the entitlement. Enough to run the writers end to end offline.
 */
import type { Address } from '@squarehole/domain';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAbiItem, type Hex } from 'viem';
import { squareHoleClaimConverterAbi as converterAbi } from '../../abi/squareHoleClaimConverter';
import { squareHoleFungibleTokenAbi as launchTokenAbi } from '../../abi/squareHoleFungibleToken';
import { squareHoleLauncherAbi as launcherAbi } from '../../abi/squareHoleLauncher';
import { rewardLedgerAbi as ledgerAbi } from '../../abi/rewardLedger';
import { squareHoleRegistryAbi as registryAbi } from '../../abi/squareHoleRegistry';
import type { WriteDeployment } from '../deployment';
import { registryPairId, type RegistryPair } from '../registry-reads';
import type { FakeChain, FakeTx } from './fake-chain';

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;
const ZERO = addr(0);

export const FAKE = Object.freeze({
  registry: addr(0x5001),
  launcher: addr(0x5002),
  converter: addr(0x5003),
  hook: addr(0x2a60),
  poolManager: addr(0x5004),
  treasury: addr(0x5005),
  weth: addr(0x5006),
  usdtTest: addr(0x5007),
});

export function fakeDeployment(chainId = 31337): WriteDeployment {
  return Object.freeze({
    schema: 'squarehole.deployment/v1',
    chainId,
    registry: FAKE.registry,
    launcher: FAKE.launcher,
    converter: FAKE.converter,
    hook: FAKE.hook,
    poolManager: FAKE.poolManager,
    treasury: FAKE.treasury,
    registryAdmin: FAKE.treasury,
    templates: Object.freeze([
      Object.freeze({ version: 1, quote: FAKE.weth, label: 'WETH', active: true, startFdvQ: 10n ** 18n, minStartUnitValueQ: 10n ** 14n, maxCollectionUnits: 10_000n, tickSpacing: 60, rangeTicks: 69_060 }),
      Object.freeze({ version: 3, quote: FAKE.usdtTest, label: 'USDT', active: true, startFdvQ: 5_000_000_000n, minStartUnitValueQ: 500_000n, maxCollectionUnits: 10_000n, tickSpacing: 60, rangeTicks: 69_060 }),
    ]),
    testnetMockQuotes: Object.freeze([FAKE.usdtTest]),
    startBlock: 0n,
    endBlock: 0n,
  });
}

interface TokenMeta {
  name: string;
  symbol: string;
}

export class FakeSquareHole {
  readonly chain: FakeChain;
  readonly deployment: WriteDeployment;
  readonly pairs = new Map<string, RegistryPair>();
  readonly tokens = new Map<string, TokenMeta>();
  readonly claimable = new Map<string, bigint>();
  readonly soldOut = new Set<string>();
  /** T paid per converted Q (numerator / 1000) for claimAsT quotes and conversions. */
  tPerQMilli = 2_000n;
  /** The T a mined conversion actually pays, relative to the quote (e.g. 0.95 to model a front-run). */
  executionFactorMilli = 1_000n;
  /** Launcher wiring answers (override to test mismatches). */
  wiring = { registry: FAKE.registry, converter: FAKE.converter, hook: FAKE.hook, converterRegistry: FAKE.registry };
  /** Registry template answers (override to test retired/unknown/mismatching templates). */
  latestTemplate = new Map<string, number>([
    [FAKE.weth.toLowerCase(), 1],
    [FAKE.usdtTest.toLowerCase(), 3],
  ]);
  /** Fields a mined launch records differently from its request (a hostile or buggy launcher). */
  tamper: Partial<RegistryPair> | null = null;
  private tokenCounter = 0x7000;

  constructor(chain: FakeChain, deployment = fakeDeployment(chain.chainId)) {
    this.chain = chain;
    this.deployment = deployment;
    const c = chain;
    c.onCall(FAKE.launcher, launcherAbi, 'registry', () => this.wiring.registry);
    c.onCall(FAKE.launcher, launcherAbi, 'converter', () => this.wiring.converter);
    c.onCall(FAKE.launcher, launcherAbi, 'hook', () => this.wiring.hook);
    c.onCall(FAKE.converter, converterAbi, 'registry', () => this.wiring.converterRegistry);
    c.onCall(FAKE.registry, registryAbi, 'latestTemplateFor', ([quote]) => this.latestTemplate.get(String(quote).toLowerCase()) ?? 0);
    c.onCall(FAKE.registry, registryAbi, 'template', ([version]) => {
      const t = this.deployment.templates.find((x) => x.version === Number(version));
      return t
        ? { quote: t.quote, startFdvQ: t.startFdvQ, minStartUnitValueQ: t.minStartUnitValueQ, tickSpacing: t.tickSpacing, rangeTicks: t.rangeTicks, shape: 1, active: t.active, addedAtBlock: 1n }
        : { quote: ZERO, startFdvQ: 0n, minStartUnitValueQ: 0n, tickSpacing: 0, rangeTicks: 0, shape: 0, active: false, addedAtBlock: 0n };
    });
    c.onCall(FAKE.registry, registryAbi, 'maxCollectionUnits', ([version]) => this.deployment.templates.find((x) => x.version === Number(version))?.maxCollectionUnits ?? 0n);
    c.onCall(FAKE.registry, registryAbi, 'REFERENCE_BUY_NFTS', () => 1_000n);
    c.onCall(FAKE.registry, registryAbi, 'pair', ([pairId]) => this.pairs.get(String(pairId).toLowerCase()) ?? emptyPair());
    c.onCall(FAKE.launcher, launcherAbi, 'createLaunch', ([params], from) => {
      const p = params as { units: bigint; kind: number };
      if (p.kind === 1 && p.units > 10_000n) throw new Error('unreachable: the fake has no CollectionTooLarge');
      void from;
      const token = addr(this.tokenCounter + 1);
      return [registryPairId(this.chain.chainId, token), token];
    });
    c.onCall(FAKE.converter, converterAbi, 'isSoldOut', ([token]) => this.soldOut.has(String(token).toLowerCase()));
    c.onCall(FAKE.converter, converterAbi, 'claimAsT', ([pairId], from) => {
      const pair = this.pairs.get(String(pairId).toLowerCase());
      const q = pair && from ? (this.claimable.get(`${pair.ledger.toLowerCase()}:${from.toLowerCase()}`) ?? 0n) : 0n;
      return [q, (q * this.tPerQMilli) / 1_000n];
    });
    c.onCall(FAKE.converter, converterAbi, 'claimAsQWhenSoldOut', () => 0n);
    chain.logsFor.set(FAKE.launcher.toLowerCase(), (tx) => this.minedLaunch(tx));
    chain.logsFor.set(FAKE.converter.toLowerCase(), (tx) => this.minedConversion(tx));
  }

  /** Adds an existing pair (R = Q or R = T) with a ledger; returns its token. */
  addPair(rewardSide: 'Q' | 'T', options: { quote?: Address; name?: string; symbol?: string } = {}): RegistryPair {
    this.tokenCounter += 1;
    const token = addr(this.tokenCounter);
    const ledger = addr(this.tokenCounter + 0x1000);
    const record: RegistryPair = {
      chainId: BigInt(this.chain.chainId),
      pairId: registryPairId(this.chain.chainId, token),
      kind: 1,
      token,
      mirror: addr(this.tokenCounter + 0x2000),
      ledger,
      collector: addr(this.tokenCounter + 0x3000),
      hook: FAKE.hook,
      poolId: `0x${'ab'.repeat(32)}`,
      quote: options.quote ?? FAKE.weth,
      rewardSide: rewardSide === 'T' ? 1 : 0,
      converter: rewardSide === 'T' ? FAKE.converter : ZERO,
      fractionsPerNft: 1_000_000n,
      units: 1_000n,
      initialSupply: 10n ** 27n,
      templateVersion: 1,
      startFdvQ: 10n ** 18n,
      minStartUnitValueQ: 10n ** 14n,
      tickSpacing: 60,
      tickLower: -207_300,
      tickUpper: -138_240,
      liquidity: 1n,
      sqrtPriceX96: 1n,
      metadataManifestHash: `0x${'33'.repeat(32)}`,
      creator: FAKE.treasury,
      createdAtBlock: 1n,
    };
    this.pairs.set(record.pairId.toLowerCase(), record);
    this.tokens.set(token.toLowerCase(), { name: options.name ?? 'Pair', symbol: options.symbol ?? 'PAIR' });
    this.chain.onCall(ledger, ledgerAbi, 'claimable', ([account]) => this.claimable.get(`${ledger.toLowerCase()}:${String(account).toLowerCase()}`) ?? 0n);
    this.chain.onCall(ledger, ledgerAbi, 'payoutAsset', () => record.rewardSide);
    this.chain.onCall(ledger, ledgerAbi, 'token', () => token);
    this.chain.onCall(ledger, ledgerAbi, 'claim', ([account]) => this.claimable.get(`${ledger.toLowerCase()}:${String(account).toLowerCase()}`) ?? 0n);
    this.chain.logsFor.set(ledger.toLowerCase(), (tx) => this.minedClaim(tx, ledger));
    this.tokenMeta(token);
    return record;
  }

  setClaimable(pair: RegistryPair, account: Address, amount: bigint): void {
    this.claimable.set(`${pair.ledger.toLowerCase()}:${account.toLowerCase()}`, amount);
  }

  private tokenMeta(token: Address): void {
    this.chain.onCall(token, launchTokenAbi, 'name', () => this.tokens.get(token.toLowerCase())?.name ?? '');
    this.chain.onCall(token, launchTokenAbi, 'symbol', () => this.tokens.get(token.toLowerCase())?.symbol ?? '');
  }

  private minedLaunch(tx: FakeTx) {
    const { args } = decodeFunctionData({ abi: launcherAbi, data: tx.input }) as { args: readonly [Record<string, unknown>] };
    const p = args[0] as { kind: number; name: string; symbol: string; units: bigint; fractionsPerNft: bigint; templateVersion: number; payoutAsset: number; metadataManifestHash: Hex };
    this.tokenCounter += 1;
    const token = addr(this.tokenCounter);
    const template = this.deployment.templates.find((t) => t.version === p.templateVersion);
    const record: RegistryPair = {
      ...{
      chainId: BigInt(this.chain.chainId),
      pairId: registryPairId(this.chain.chainId, token),
      kind: p.kind,
      token,
      mirror: p.kind === 1 ? addr(this.tokenCounter + 0x2000) : ZERO,
      ledger: addr(this.tokenCounter + 0x1000),
      collector: addr(this.tokenCounter + 0x3000),
      hook: FAKE.hook,
      poolId: `0x${'cd'.repeat(32)}`,
      quote: template?.quote ?? ZERO,
      rewardSide: p.payoutAsset,
      converter: p.payoutAsset === 1 ? FAKE.converter : ZERO,
      fractionsPerNft: p.fractionsPerNft,
      units: p.units,
      initialSupply: p.units * p.fractionsPerNft * 10n ** 18n,
      templateVersion: p.templateVersion,
      startFdvQ: template?.startFdvQ ?? 0n,
      minStartUnitValueQ: template?.minStartUnitValueQ ?? 0n,
      tickSpacing: 60,
      tickLower: -207_300,
      tickUpper: -138_240,
      liquidity: 1n,
      sqrtPriceX96: 1n,
      metadataManifestHash: p.metadataManifestHash,
      creator: tx.from,
      createdAtBlock: this.chain.head.number + 1n,
      },
      ...this.tamper,
    };
    this.pairs.set(record.pairId.toLowerCase(), record);
    this.tokens.set(token.toLowerCase(), { name: p.name, symbol: p.symbol });
    this.tokenMeta(token);
    const event = getAbiItem({ abi: registryAbi, name: 'PairCreated' });
    const recordParam = event.inputs[3];
    const topics = encodeEventTopics({ abi: registryAbi, eventName: 'PairCreated', args: { pairId: record.pairId, token, quote: record.quote } }) as Hex[];
    const data = encodeAbiParameters([recordParam], [record] as never);
    return [{ address: FAKE.registry, topics, data }];
  }

  private minedClaim(tx: FakeTx, ledger: Address) {
    const key = `${ledger.toLowerCase()}:${tx.from.toLowerCase()}`;
    const amount = this.claimable.get(key) ?? 0n;
    this.claimable.set(key, 0n);
    const topics = encodeEventTopics({ abi: ledgerAbi, eventName: 'Claimed', args: { account: tx.from, recipient: tx.from } }) as Hex[];
    return [{ address: ledger, topics, data: encodeAbiParameters([{ type: 'uint256' }], [amount]) }];
  }

  private minedConversion(tx: FakeTx) {
    const decoded = decodeFunctionData({ abi: converterAbi, data: tx.input }) as { functionName: string; args: readonly unknown[] };
    if (decoded.functionName === 'claimAsT') {
      const pair = this.pairs.get(String(decoded.args[0]).toLowerCase());
      if (!pair) return [];
      const key = `${pair.ledger.toLowerCase()}:${tx.from.toLowerCase()}`;
      const q = this.claimable.get(key) ?? 0n;
      this.claimable.set(key, 0n);
      const tOut = (((q * this.tPerQMilli) / 1_000n) * this.executionFactorMilli) / 1_000n;
      const topics = encodeEventTopics({ abi: converterAbi, eventName: 'ClaimConverted', args: { token: pair.token, holder: tx.from } }) as Hex[];
      return [{ address: FAKE.converter, topics, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [q, tOut]) }];
    }
    const token = decoded.args[0] as Address;
    const pair = [...this.pairs.values()].find((p) => p.token.toLowerCase() === token.toLowerCase());
    if (!pair) return [];
    const key = `${pair.ledger.toLowerCase()}:${tx.from.toLowerCase()}`;
    const q = this.claimable.get(key) ?? 0n;
    this.claimable.set(key, 0n);
    const topics = encodeEventTopics({ abi: converterAbi, eventName: 'ClaimPaidInQSoldOut', args: { token, holder: tx.from } }) as Hex[];
    return [{ address: FAKE.converter, topics, data: encodeAbiParameters([{ type: 'uint256' }], [q]) }];
  }
}

function emptyPair(): RegistryPair {
  return {
    chainId: 0n,
    pairId: `0x${'00'.repeat(32)}`,
    kind: 0,
    token: ZERO,
    mirror: ZERO,
    ledger: ZERO,
    collector: ZERO,
    hook: ZERO,
    poolId: `0x${'00'.repeat(32)}`,
    quote: ZERO,
    rewardSide: 0,
    converter: ZERO,
    fractionsPerNft: 0n,
    units: 0n,
    initialSupply: 0n,
    templateVersion: 0,
    startFdvQ: 0n,
    minStartUnitValueQ: 0n,
    tickSpacing: 0,
    tickLower: 0,
    tickUpper: 0,
    liquidity: 0n,
    sqrtPriceX96: 0n,
    metadataManifestHash: `0x${'00'.repeat(32)}`,
    creator: ZERO,
    createdAtBlock: 0n,
  };
}
