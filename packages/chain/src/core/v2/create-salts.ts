import { bytesToHex, getCreate2Address, hexToBytes, isAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';

/** The hash is predictBox's final hook init-code hash, including the release's hook code and arguments. */
export type PredictBoxV2 = (coordinatorSalt: Hex) => Promise<readonly [Address, Address, Hex]> | readonly [Address, Address, Hex];
export interface CreateSaltInputsV2 {
  readonly priceToken: Address;
  readonly tokenAddressLimit: Address;
  /** Bind factory, creator, spec and block in this provider; this helper owns no client or ambient state. */
  readonly predictBox: PredictBoxV2;
  readonly coordinatorSaltStart?: bigint;
  readonly hookSaltStart?: bigint;
  readonly maxCoordinatorAttempts?: bigint;
  readonly maxHookAttempts?: bigint;
  /**
   * Awaited after every `pauseEveryTries` hook tries (counted over the whole search), only while the search goes on, so a
   * page can yield to its event loop. Absent: the search never pauses, as in a script. It changes nothing in the result.
   */
  readonly pause?: () => Promise<void>;
  /** Tries between two pauses; default HOOK_PAUSE_EVERY_TRIES. */
  readonly pauseEveryTries?: number;
}
/**
 * At the SH-212 laptop measurement (about 10 microseconds per try), this is about 20 ms of hashing.
 * Device and scheduling time vary. No browser or phone timing was measured.
 * A real box needs 16,384 tries on average: about eight pauses when a caller supplies a pause, none otherwise
 * (the web app supplies none).
 */
export const HOOK_PAUSE_EVERY_TRIES = 2_048;

export interface CreateSaltsV2 {
  readonly cs: Hex;
  readonly hs: Hex;
  readonly coordinator: Address;
  readonly token: Address;
  readonly hook: Address;
}

/**
 * The hook rule on a CREATE2 hash (the address is its last 20 bytes): the low 14 bits are 0x2ae0 (0x2a, 0xe0 in the last
 * two bytes under the 0x3f mask) and the first address byte is not the reserved 0x91.
 */
export function isHookHashV2(hash: Uint8Array): boolean {
  return hash.length === 32 && hash[31] === 0xe0 && ((hash[30] ?? 0) & 0x3f) === 0x2a && hash[12] !== 0x91;
}

/** Deterministic bounded search: ascending coordinator salts, then ascending hook salts, exactly as the script. */
export async function findCreateSaltsV2(input: CreateSaltInputsV2): Promise<CreateSaltsV2> {
  const { priceToken, tokenAddressLimit, predictBox, coordinatorSaltStart = 0n, hookSaltStart = 0n,
    maxCoordinatorAttempts = 4096n, maxHookAttempts = 1_000_000n, pause, pauseEveryTries = HOOK_PAUSE_EVERY_TRIES } = input;
  const range = (start: bigint, attempts: bigint, cap: bigint) => start >= 0n && attempts > 0n
    && attempts <= cap && start + attempts <= 1n << 256n;
  if (!isAddress(priceToken) || !isAddress(tokenAddressLimit) || BigInt(tokenAddressLimit) <= BigInt(priceToken)
    || !range(coordinatorSaltStart, maxCoordinatorAttempts, 4096n) || !range(hookSaltStart, maxHookAttempts, 1_000_000n)) {
    throw new RangeError('invalid creation salt search bounds');
  }
  if (!Number.isSafeInteger(pauseEveryTries) || pauseEveryTries < 1) throw new RangeError('invalid creation salt search pause interval');
  let tries = 0;
  for (let i = 0n; i < maxCoordinatorAttempts; i++) {
    const cs = toHex(coordinatorSaltStart + i, { size: 32 });
    const [coordinator, token, initHash] = await predictBox(cs);
    if (!isAddress(coordinator) || coordinator === zeroAddress || !isAddress(token)
      || typeof initHash !== 'string' || initHash.length !== 66 || !/^0x[\da-fA-F]{64}$/.test(initHash)) {
      throw new Error('invalid predictBox result');
    }
    if (BigInt(token) <= BigInt(priceToken) || BigInt(token) >= BigInt(tokenAddressLimit)) continue;
    // One buffer for every try: 0xff, the coordinator, the salt (a big-endian counter written in place), the init hash.
    const buffer = new Uint8Array(85);
    buffer[0] = 0xff;
    buffer.set(hexToBytes(coordinator), 1);
    buffer.set(hexToBytes(initHash), 53);
    buffer.set(hexToBytes(toHex(hookSaltStart, { size: 32 })), 21);
    for (let j = 0n; j < maxHookAttempts; j++) {
      if (pause !== undefined && tries > 0 && tries % pauseEveryTries === 0) await pause();
      tries++;
      const hash = keccak256(buffer, 'bytes');
      if (isHookHashV2(hash)) {
        const hs = toHex(hookSaltStart + j, { size: 32 });
        const hook = getCreate2Address({ from: coordinator, salt: hs, bytecodeHash: initHash });
        if (hook.toLowerCase() !== bytesToHex(hash.subarray(12))) throw new Error('hook salt search disagrees with CREATE2');
        return { cs, hs, coordinator, token, hook };
      }
      for (let k = 52; k >= 21; k--) { // the counter's carry: a byte that wraps to 0 carries into the one before it
        const next = ((buffer[k] ?? 0) + 1) & 0xff;
        buffer[k] = next;
        if (next !== 0) break;
      }
    }
    throw new Error('hook salt search exhausted');
  }
  throw new Error('coordinator salt search exhausted');
}
