/**
 * The only transactions Square Hole ever asks a wallet to send (AGENTS.md: "Creation and reward claims are allowed app
 * transactions"): `createLaunch` on the deployment's launcher, `claim` on a pair's reward ledger (R = Q), and, on the
 * deployment's claim converter, `claimAsT(bytes32,uint256,uint256)` (R = T) and the labelled emergency
 * `claimAsQWhenSoldOut(address,uint256)`. Nothing here can encode any other call, carry value or target another
 * address: `assertSendableCall` is checked again right before the wallet request. There is no swap builder.
 */
import type { Address } from '@squarehole/domain';
import { decodeFunctionData, encodeFunctionData, toFunctionSelector, type Hex } from 'viem';
import { squareHoleClaimConverterAbi as converterAbi } from '../abi/squareHoleClaimConverter';
import { squareHoleLauncherAbi as launcherAbi } from '../abi/squareHoleLauncher';
import { rewardLedgerAbi as ledgerAbi } from '../abi/rewardLedger';
import type { WriteDeployment } from './deployment';

export type WriteFunction = 'createLaunch' | 'claim' | 'claimAsT' | 'claimAsQWhenSoldOut';

export interface WriteCall {
  readonly fn: WriteFunction;
  readonly to: Address;
  readonly data: Hex;
  /** Always zero: no write is payable (no first buy, no deposit). */
  readonly value: 0n;
}

/** Launcher inputs, exactly `SquareHoleLauncher.LaunchParams`. */
export interface LaunchParams {
  /** 0 = Token (plain ERC-20), 1 = Collection (DN404 with automatic fractions). */
  readonly kind: 0 | 1;
  readonly name: string;
  readonly symbol: string;
  /** Collection: N whole NFTs. Token: whole-token supply. */
  readonly units: bigint;
  /** Collection: r = 10^k. Token: 1. */
  readonly fractionsPerNft: bigint;
  readonly templateVersion: number;
  /** R: 0 = Q, 1 = T. */
  readonly payoutAsset: 0 | 1;
  readonly baseURI: string;
  readonly metadataManifestHash: Hex;
}

export const SENDABLE_SIGNATURES: Readonly<Record<string, WriteFunction>> = Object.freeze({
  'createLaunch((uint8,string,string,uint256,uint256,uint32,uint8,string,bytes32))': 'createLaunch',
  'claim(address)': 'claim',
  'claimAsT(bytes32,uint256,uint256)': 'claimAsT',
  'claimAsQWhenSoldOut(address,uint256)': 'claimAsQWhenSoldOut',
});

/** Selector → function, computed from the signatures above (and checked against the generated ABIs in tests). */
export const SENDABLE_SELECTORS: ReadonlyMap<Hex, WriteFunction> = new Map(
  Object.entries(SENDABLE_SIGNATURES).map(([signature, fn]) => [toFunctionSelector(signature), fn]),
);

export function createLaunchCall(deployment: WriteDeployment, params: LaunchParams): WriteCall {
  const data = encodeFunctionData({
    abi: launcherAbi,
    functionName: 'createLaunch',
    args: [
      {
        kind: params.kind,
        name: params.name,
        symbol: params.symbol,
        units: params.units,
        fractionsPerNft: params.fractionsPerNft,
        templateVersion: params.templateVersion,
        payoutAsset: params.payoutAsset,
        baseURI: params.baseURI,
        metadataManifestHash: params.metadataManifestHash,
      },
    ],
  });
  return Object.freeze({ fn: 'createLaunch', to: deployment.launcher, data, value: 0n });
}

/** R = Q: `ledger.claim(account)`; the ledger pays only `msg.sender == account` (ECO-16). */
export function claimCall(ledger: Address, account: Address): WriteCall {
  const data = encodeFunctionData({ abi: ledgerAbi, functionName: 'claim', args: [account] });
  return Object.freeze({ fn: 'claim', to: ledger, data, value: 0n });
}

/** R = T: converts the caller's WHOLE entitlement (the pair-id overload, named explicitly; ADR-0011 §6). */
export function claimAsTCall(deployment: WriteDeployment, pairId: Hex, minTOut: bigint, deadline: bigint): WriteCall {
  const converter = requireConverter(deployment);
  const data = encodeFunctionData({ abi: converterAbi, functionName: 'claimAsT', args: [pairId, minTOut, deadline] });
  if (data.slice(0, 10) !== toFunctionSelector('claimAsT(bytes32,uint256,uint256)')) throw new Error('claimAsT: wrong overload encoded');
  return Object.freeze({ fn: 'claimAsT', to: converter, data, value: 0n });
}

/** The labelled emergency payout in Q while the pool is sold out (never selected automatically; ADR-0011 §6). */
export function claimAsQWhenSoldOutCall(deployment: WriteDeployment, token: Address, maxQ: bigint): WriteCall {
  const converter = requireConverter(deployment);
  const data = encodeFunctionData({ abi: converterAbi, functionName: 'claimAsQWhenSoldOut', args: [token, maxQ] });
  return Object.freeze({ fn: 'claimAsQWhenSoldOut', to: converter, data, value: 0n });
}

function requireConverter(deployment: WriteDeployment): Address {
  if (deployment.converter === null) throw new NotSendableError('this deployment has no claim converter');
  return deployment.converter;
}

export class NotSendableError extends Error {
  constructor(message: string) {
    super(`Refused to send: ${message}`);
    this.name = 'NotSendableError';
  }
}

/**
 * Last gate before a wallet request: the call must be one of the four writes, decode under its own ABI, carry no
 * value, and target the deployment's launcher / converter, or (for `claim`) the ledger the registry reported for the
 * pair (`expectedLedger`, read at preparation). Throws `NotSendableError` otherwise.
 */
export function assertSendableCall(call: WriteCall, deployment: WriteDeployment, expectedLedger: Address | null = null): void {
  const selector = call.data.slice(0, 10).toLowerCase() as Hex;
  const fn = SENDABLE_SELECTORS.get(selector);
  if (fn === undefined || fn !== call.fn) throw new NotSendableError(`selector ${selector} is not an allowed write`);
  if (call.value !== 0n) throw new NotSendableError('writes never carry value');
  const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();
  const abi = fn === 'createLaunch' ? launcherAbi : fn === 'claim' ? ledgerAbi : converterAbi;
  try {
    const decoded = decodeFunctionData({ abi, data: call.data });
    if (decoded.functionName !== fn) throw new Error('mismatch');
  } catch {
    throw new NotSendableError(`calldata does not decode as ${fn}`);
  }
  const target = fn === 'createLaunch' ? deployment.launcher : fn === 'claim' ? expectedLedger : deployment.converter;
  if (!same(call.to, target)) throw new NotSendableError(`${fn} must target ${target ?? 'a registry-reported ledger'}`);
}
