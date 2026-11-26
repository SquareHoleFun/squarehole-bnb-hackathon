/**
 * M1-52 red tests: the TypeScript twins of the v2 clone forms the indexer checks (core-v2-m1-tickets.md § 2, M1-52).
 * - T (F102, CQ2-5): the standard 45-byte EIP-1167 proxy of the release's T implementation and 137 bytes of
 *   `BoxTokenV2Args` (182 bytes, `BoxClones.runtime`; `IBoxTokenV2.sol`), decoded from its code.
 * - A converter (ADR-0016's note 2; wave 0's M2): a receiving clone of the release's converter implementation with
 *   `ConverterArgs` (listing registry, listing id; 75 bytes) at `predictConverter`'s CREATE2 address.
 * The expected bytes and addresses were computed by Solidity itself (`BoxClones`, `ConverterArgs.predict`,
 * `BoxTokenV2Args.encode`, solc 0.8.26, `forge script` on 2026-10-06 UTC; SH-V2-M1-52.md), not by this file's twin.
 */
import { keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  BOX_TOKEN_V2_RUNTIME_LENGTH,
  CONVERTER_RUNTIME_LENGTH,
  cloneInitCode,
  converterSalt,
  decodeBoxTokenV2Runtime,
  decodeConverterRuntime,
  isReceivingCloneOf,
  isStandardCloneOf,
  predictConverter,
  receivingRuntime,
  standardRuntime,
} from './clones-v2';

const DEPLOYER = '0xDe91000000000000000000000000000000000001' as Address;
const CONVERTER_IMPL = '0xC0A7000000000000000000000000000000000002' as Address;
const LISTING_REGISTRY = '0x1157000000000000000000000000000000000003' as Address;
const ROUTE_HASH = keccak256(new TextEncoder().encode('m1-52 route'));
const T_IMPL = '0x7000000000000000000000000000000000000004' as Address;
const COORDINATOR = '0xc00d000000000000000000000000000000000005' as Address;
const VAULT = '0x7a01000000000000000000000000000000000006' as Address;

/** From Solidity (see the header). */
const SOL = {
  converterSalt: '0x61e77128ee4eb1d2aa0b8df206ab9b208957e17893ee8ae87bbec5aca41f8244',
  converterInitCodeHash: '0x41f2a1742ab419e394ff0b22778060597602c26e88fd696c557e651e6208216a',
  converterPredicted: '0x9E6D0d709F52e07Ac2b62ee0588Be9cc7Ce0E970',
  converterRuntime:
    '0x36600557005b363d3d373d3d3d363d73c0a70000000000000000000000000000000000025af43d82803e903d91603157fd5bf3115700000000000000000000000000000000000300000007',
  tRuntime:
    '0x363d3d373d3d3d363d7370000000000000000000000000000000000000045af43d82803e903d91602b57fd5bf3c00d0000000000000000000000000000000000057a0100000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000033b2e3c9fd0803ce80000004c696e6b20426f78000000000000000000000000000000000000000000000000084c424f580000000000000004',
} as const;

describe('M1-52 v2 clone forms', () => {
  it("M1-52 a converter's receiving runtime, salt, init code and address equal Solidity's", () => {
    const runtime = receivingRuntime(CONVERTER_IMPL, `0x${LISTING_REGISTRY.slice(2)}00000007` as Hex);
    expect(runtime).toBe(SOL.converterRuntime);
    expect((runtime.length - 2) / 2).toBe(CONVERTER_RUNTIME_LENGTH);
    expect(converterSalt(ROUTE_HASH, 7)).toBe(SOL.converterSalt);
    expect(keccak256(cloneInitCode(runtime))).toBe(SOL.converterInitCodeHash);
    expect(predictConverter({ deployer: DEPLOYER, implementation: CONVERTER_IMPL, listingRegistry: LISTING_REGISTRY, routeHash: ROUTE_HASH, listingId: 7 })).toBe(SOL.converterPredicted);
  });

  it("M1-52 a converter's arguments decode from its code, and other code is refused", () => {
    expect(decodeConverterRuntime(SOL.converterRuntime, CONVERTER_IMPL)).toEqual({ listingRegistry: LISTING_REGISTRY, listingId: 7 });
    expect(isReceivingCloneOf(SOL.converterRuntime, CONVERTER_IMPL)).toBe(true);
    // Another implementation, a standard clone of the right one, a trailing byte, a cut runtime.
    expect(decodeConverterRuntime(SOL.converterRuntime, T_IMPL)).toBeNull();
    expect(decodeConverterRuntime(standardRuntime(CONVERTER_IMPL, `0x${LISTING_REGISTRY.slice(2)}00000007`), CONVERTER_IMPL)).toBeNull();
    expect(decodeConverterRuntime(`${SOL.converterRuntime}00`, CONVERTER_IMPL)).toBeNull();
    expect(decodeConverterRuntime(SOL.converterRuntime.slice(0, -2) as Hex, CONVERTER_IMPL)).toBeNull();
  });

  it("M1-52 a v2 T's 182 bytes decode to its BoxTokenV2Args, and a T of other code is refused", () => {
    expect((SOL.tRuntime.length - 2) / 2).toBe(BOX_TOKEN_V2_RUNTIME_LENGTH);
    expect(isStandardCloneOf(SOL.tRuntime, T_IMPL)).toBe(true);
    expect(decodeBoxTokenV2Runtime(SOL.tRuntime, T_IMPL)).toEqual({
      holder: COORDINATOR,
      vault: VAULT,
      ledger: '0x0000000000000000000000000000000000000000',
      supply: 1_000_000_000n * 10n ** 18n,
      name: 'Link Box',
      symbol: 'LBOX',
    });
    expect(decodeBoxTokenV2Runtime(SOL.tRuntime, CONVERTER_IMPL)).toBeNull();
    expect(decodeBoxTokenV2Runtime(`${SOL.tRuntime}00`, T_IMPL)).toBeNull();
    expect(decodeBoxTokenV2Runtime(receivingRuntime(T_IMPL, `0x${SOL.tRuntime.slice(2 + 90)}`), T_IMPL)).toBeNull();
    // A full ERC-20 (any code that is not the proxy) is not a v2 T.
    expect(decodeBoxTokenV2Runtime(`0x6080604052${'00'.repeat(177)}`, T_IMPL)).toBeNull();
  });

  it('M1-52 bad lengths inside the arguments are refused (a name of 0 or 33 bytes, a symbol of 12)', () => {
    const at = (offset: number): number => 2 + (45 + offset) * 2;
    const withByte = (hex: string, offset: number, byte: string): Hex => `${hex.slice(0, at(offset))}${byte}${hex.slice(at(offset) + 2)}` as Hex;
    expect(decodeBoxTokenV2Runtime(withByte(SOL.tRuntime, 124, '00'), T_IMPL)).toBeNull();
    expect(decodeBoxTokenV2Runtime(withByte(SOL.tRuntime, 124, '21'), T_IMPL)).toBeNull();
    expect(decodeBoxTokenV2Runtime(withByte(SOL.tRuntime, 136, '0c'), T_IMPL)).toBeNull();
  });
});
