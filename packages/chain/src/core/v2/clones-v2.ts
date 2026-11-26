/**
 * The TypeScript twins of core v2's clone forms (ticket M1-52), as `BoxClones` builds them
 * (packages/contracts/src/box/libraries/BoxClones.sol): a standard EIP-1167 runtime with its arguments from byte 45,
 * and the receiving runtime (6 bytes in front, the success jump moved) with its arguments from byte 51.
 * - **T** (F102, CQ2-5; `IBoxTokenV2.sol`): exactly the standard proxy of the release's T implementation and the 137
 *   bytes of `BoxTokenV2Args` (holder, vault, ledger, supply, name, symbol): 182 bytes.
 * - **A converter** (ADR-0016's note 2; wave 0's M2; `IConverter.sol`): a receiving clone of the release's converter
 *   implementation with `ConverterArgs` (listing registry, listing id): 75 bytes, at the CREATE2 address
 *   `ConverterArgs.predict` gives for the converter deployer, salt keccak256(abi.encode(routeHash, listingId)).
 * Any other code is refused (null), never guessed.
 */
import { encodeAbiParameters, getAddress, getContractAddress, hexToBigInt, keccak256, parseAbiParameters, type Address, type Hex } from 'viem';

const PROXY_HEAD = '363d3d373d3d3d363d73';
const PROXY_TAIL = '5af43d82803e903d91602b57fd5bf3';
const RECEIVE_PREFIX = '36600557005b';
const RECEIVING_PROXY_TAIL = '5af43d82803e903d91603157fd5bf3';

/** `BoxTokenV2Args.LENGTH` + the 45-byte proxy. */
export const BOX_TOKEN_V2_RUNTIME_LENGTH = 182;
/** `ConverterArgs.LENGTH` + the 51-byte receiving proxy. */
export const CONVERTER_RUNTIME_LENGTH = 75;

const body = (hex: Hex): string => hex.slice(2).toLowerCase();
const impl = (implementation: Address): string => body(implementation);

export function standardRuntime(implementation: Address, args: Hex = '0x'): Hex {
  return `0x${PROXY_HEAD}${impl(implementation)}${PROXY_TAIL}${body(args)}`;
}

export function receivingRuntime(implementation: Address, args: Hex = '0x'): Hex {
  return `0x${RECEIVE_PREFIX}${PROXY_HEAD}${impl(implementation)}${RECEIVING_PROXY_TAIL}${body(args)}`;
}

/** `BoxClones.initCode(runtime)`: PUSH2 length, then the 10-byte constructor, then the runtime. */
export function cloneInitCode(runtime: Hex): Hex {
  const length = (runtime.length - 2) / 2;
  if (length > 24_576) throw new RangeError(`runtime of ${length} bytes is over EIP-170`);
  return `0x61${length.toString(16).padStart(4, '0')}3d81600a3d39f3${body(runtime)}`;
}

/** Whether `code` begins with the standard proxy of `implementation` (`BoxClones.isCloneOf`). */
export function isStandardCloneOf(code: Hex, implementation: Address): boolean {
  return body(code).startsWith(`${PROXY_HEAD}${impl(implementation)}${PROXY_TAIL}`);
}

/** Whether `code` begins with the receiving runtime of `implementation` (`BoxClones.isReceivingCloneOf`). */
export function isReceivingCloneOf(code: Hex, implementation: Address): boolean {
  return body(code).startsWith(`${RECEIVE_PREFIX}${PROXY_HEAD}${impl(implementation)}${RECEIVING_PROXY_TAIL}`);
}

export interface BoxTokenV2Args {
  readonly holder: Address;
  readonly vault: Address;
  readonly ledger: Address;
  readonly supply: bigint;
  readonly name: string;
  readonly symbol: string;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A left-aligned, zero-padded text of `length` bytes (1..max), or null when the length or the padding is wrong. */
function text(hex: string, length: number, max: number): string | null {
  if (length < 1 || length > max) return null;
  if (!/^0*$/.test(hex.slice(length * 2))) return null;
  const bytes = Uint8Array.from(hex.slice(0, length * 2).match(/../g) ?? [], (b) => Number.parseInt(b, 16));
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** T's arguments from its code, if its code is exactly a v2 T clone of `implementation` (else null). */
export function decodeBoxTokenV2Runtime(code: Hex, implementation: Address): BoxTokenV2Args | null {
  const hex = body(code);
  if (hex.length !== BOX_TOKEN_V2_RUNTIME_LENGTH * 2 || !isStandardCloneOf(code, implementation)) return null;
  const args = hex.slice(90);
  const at = (offset: number, bytes: number): string => args.slice(offset * 2, (offset + bytes) * 2);
  const name = text(at(92, 32), Number.parseInt(at(124, 1), 16), 32);
  const symbol = text(at(125, 11), Number.parseInt(at(136, 1), 16), 11);
  if (name === null || symbol === null) return null;
  return {
    holder: getAddress(`0x${at(0, 20)}`),
    vault: getAddress(`0x${at(20, 20)}`),
    ledger: getAddress(`0x${at(40, 20)}`),
    supply: hexToBigInt(`0x${at(60, 32)}`),
    name,
    symbol,
  };
}

export interface ConverterArgsV2 {
  readonly listingRegistry: Address;
  readonly listingId: number;
}

/** A converter's arguments, if its code is exactly a receiving clone of `implementation` (else null). */
export function decodeConverterRuntime(code: Hex, implementation: Address): ConverterArgsV2 | null {
  const hex = body(code);
  if (hex.length !== CONVERTER_RUNTIME_LENGTH * 2 || !isReceivingCloneOf(code, implementation)) return null;
  const args = hex.slice(102);
  return { listingRegistry: getAddress(`0x${args.slice(0, 40)}`), listingId: Number.parseInt(args.slice(40, 48), 16) };
}

/** `ConverterArgs.salt`: keccak256(abi.encode(routeHash, listingId)). */
export function converterSalt(routeHash: Hex, listingId: number): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint32'), [routeHash, listingId]));
}

/** `ConverterArgs.predict` / `IListingRegistry.predictConverter`. */
export function predictConverter(o: { readonly deployer: Address; readonly implementation: Address; readonly listingRegistry: Address; readonly routeHash: Hex; readonly listingId: number }): Address {
  const args = `0x${body(o.listingRegistry)}${o.listingId.toString(16).padStart(8, '0')}` as Hex;
  return getContractAddress({ opcode: 'CREATE2', from: o.deployer, salt: converterSalt(o.routeHash, o.listingId), bytecodeHash: keccak256(cloneInitCode(receivingRuntime(o.implementation, args))) });
}
