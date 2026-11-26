/**
 * SH-258: the test network's clock, for estimates only (never a contract rule: the launch window's 12-second tax steps
 * and its 384 seconds are the contracts' own, TAX_STEP_SECONDS and WINDOW_SECONDS). Sepolia stamps a block every 12
 * seconds; BNB Chain testnet about every 0.45 s, and its block timestamps count whole seconds, so the next block's
 * time is at most one second on.
 */
import { TESTNET } from '@squarehole/chain/write/wallet';

/** Seconds from one block's timestamp to the next one's: 12 on Sepolia, 1 on BNB Chain testnet. */
export const NEXT_BLOCK_SECONDS: bigint = BigInt(Math.max(1, Math.ceil(TESTNET.blockTimeMs / 1000)));

/**
 * How far past the last block the launch tax is read: Sepolia's next block is 12 s on (the tax its buy pays); on BNB
 * Chain testnet the next block may still carry the same whole second, so the tax shown is the one at the last block's
 * time (never the next, lower step early; re-read finding 8).
 */
export const TAX_LOOKAHEAD_SECONDS: bigint = TESTNET.name === 'sepolia' ? 12n : 0n;

/** "about 6 minutes", "about 15 seconds": how long `blocks` blocks take on the test network. */
export function blocksDuration(blocks: number): string {
  const seconds = Math.round((blocks * TESTNET.blockTimeMs) / 1000);
  return seconds >= 60 ? `about ${Math.round(seconds / 60)} minutes` : `about ${seconds} seconds`;
}
