import { sha256, type Hex } from 'viem';

/** BoxDrandQuicknet.sol: quicknet only, never /public/latest or an unpinned beacon alias. */
export const QUICKNET_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const QUICKNET_RELAYS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com'] as const;
export const QUICKNET_GENESIS = 1_692_803_367n;
export const QUICKNET_PERIOD = 3n;
const P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (; exponent > 0n; exponent >>= 1n, base = base * base % P) {
    if (exponent & 1n) result = result * base % P;
  }
  return result;
}

/** Encoding conversion only. The pinned on-chain BLS pairing check MUST validate the result before selection. */
export function decompressQuicknet(compressed: Hex): Hex {
  if (!/^0x[89ab][0-9a-f]{95}$/i.test(compressed)) throw new Error('invalid quicknet G1 encoding');
  const raw = BigInt(compressed);
  const x = raw & ((1n << 381n) - 1n);
  if (x >= P) throw new Error('noncanonical quicknet coordinate');
  const rhs = (x * x % P * x + 4n) % P;
  let y = pow(rhs, (P + 1n) / 4n);
  if (y * y % P !== rhs || y === 0n) throw new Error('invalid quicknet curve point');
  if ((y > (P - 1n) / 2n) !== ((raw & (1n << 381n)) !== 0n)) y = P - y;
  return `0x${x.toString(16).padStart(96, '0')}${y.toString(16).padStart(96, '0')}`;
}

/** Bound response memory even if Content-Length is absent or false. */
async function readAnswer(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('relay unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 8192) throw new Error('relay response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => {}); }
}

function signatureOf(answer: unknown, round: bigint): Hex {
  if (!answer || typeof answer !== 'object') throw new Error('invalid relay response');
  const a = answer as Record<string, unknown>;
  // HTTP drand uses JSON integer round numbers. Reject unsafe ones; decimal strings also work for offline feeds.
  const reported = typeof a.round === 'string' && /^\d+$/.test(a.round) ? BigInt(a.round)
    : typeof a.round === 'number' && Number.isSafeInteger(a.round) ? BigInt(a.round) : 0n;
  if (reported !== round || typeof a.signature !== 'string' || !/^[0-9a-f]{96}$/i.test(a.signature)
    || typeof a.randomness !== 'string' || !/^[0-9a-f]{64}$/i.test(a.randomness)) throw new Error('invalid relay response');
  const compressed: Hex = `0x${a.signature}`;
  if (sha256(compressed).slice(2) !== a.randomness.toLowerCase()) throw new Error('relay randomness mismatch');
  return decompressQuicknet(compressed);
}

/** Race independent public relays; HTTP success alone is never validity. No relay error text reaches logs. */
export async function fetchQuicknet(
  round: bigint,
  validate: (signature: Hex) => Promise<void>,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<Hex> {
  if (round <= 0n || round >= 1n << 64n) throw new Error('invalid quicknet round');
  const controllers: AbortController[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    return await Promise.any(QUICKNET_RELAYS.map(relay => {
      const controller = new AbortController();
      controllers.push(controller);
      const work = async () => {
        const response = await fetcher(`${relay}/${QUICKNET_HASH}/public/${round}`, {
          signal: controller.signal, redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'curl/8 (squarehole keeper)' },
        });
        const signature = signatureOf(await readAnswer(response), round);
        if (controller.signal.aborted) throw new Error('relay timed out');
        await validate(signature);
        return signature;
      };
      const timeout = new Promise<never>((_, reject) => timers.push(setTimeout(() => {
        controller.abort(); reject(new Error('relay timed out'));
      }, timeoutMs)));
      return Promise.race([work(), timeout]);
    }));
  } catch { throw new Error('no valid quicknet relay answer'); }
  finally {
    timers.forEach(clearTimeout);
    controllers.forEach(c => c.abort());
  }
}
