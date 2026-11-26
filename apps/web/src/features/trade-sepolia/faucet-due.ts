/**
 * F156 (SH-ALPHA-TEST-COINS): when the faucet gives an account a drip, as the test-coin page's faucet card and the
 * alpha's "Set me up" (F166, setup-run.ts) both read it. Moved here from TestCoinPage.tsx unchanged (it re-exports them),
 * so the setup does not import the page.
 *
 * F166 af2 (the founder, 2026-11-01): a drip is offered, and sent, only once the account can pay its gas. The sender
 * puts the wallet on the faucet's list first and its starter SepETH minutes later (or in the same block, once the sender
 * sends both together): the card and the setup read both from the chain, in either order (`coinsReady`).
 */
import { MIN_FAUCET_GAS, type CoinState, type FaucetState } from '@squarehole/chain/trade-sepolia';
import { DEFAULT_TIP_CAP, readsGasPrice, TIP_CAPS, type Eip1193Request } from '@squarehole/chain/write';
import { TESTNET } from '@squarehole/chain/write/wallet';

/** What one drip gives (the faucet's `DRIP_AMOUNT` in the coin calls; a plan's `expectedOutput` says the same). */
export const DRIP = 10n ** 18n;

/** Whether the faucet gives this account a drip at the state's block: admitted (or open to all), due, and in the cap. */
export function dripDue(state: Pick<CoinState, 'faucet' | 'blockTimestamp'>): boolean {
  const { faucet } = state;
  return (faucet.open || faucet.admitted) && faucet.nextDripAt <= state.blockTimestamp && faucet.dailyRemaining >= DRIP;
}

/** Why there is no drip for this account at the state's block, as a reason with its line (trade-words.ts). */
export function dripWaitReason(state: Pick<CoinState, 'faucet' | 'blockTimestamp'>): string | null {
  const { faucet } = state;
  if (!faucet.open && !faucet.admitted) return 'not_admitted';
  if (faucet.nextDripAt > state.blockTimestamp) return 'cooldown_active';
  if (faucet.dailyRemaining < DRIP) return 'daily_cap_reached';
  return null;
}

/**
 * What the account must hold for the drip's gas: the plan's gas (the faucet plan's floor, `MIN_FAUCET_GAS`, before a
 * plan named its own) at twice the chain's gas price, as a wallet's own fee cap runs above the price. Without a gas
 * price it could read (null), any SepETH at all.
 */
export function dripGasNeed(gasPrice: bigint | null, gasLimit: bigint = MIN_FAUCET_GAS): bigint {
  // SH-258 fix round 2: where the chain's price floors the fee (BNB Chain testnet) a missing or zero price never lets
  // the button on (the sender refuses such a send): no balance covers it.
  if ((gasPrice === null || gasPrice <= 0n) && PRICE_REQUIRED) return UNREADABLE_PRICE_NEED;
  return gasPrice === null || gasPrice <= 0n ? 1n : gasLimit * gasPrice * 2n;
}

/**
 * SH-258 round 3: why a due drip cannot be pressed for its gas: the chain gave no usable price (where the price is
 * required; more funds would not help), or the account holds too little; null when it can pay.
 */
export function dripGasReason(gasPrice: bigint | null, balance: bigint, gasLimit?: bigint): 'gas_price_unread' | 'gas_price_high' | 'gas_funds' | null {
  if (PRICE_REQUIRED && (gasPrice === null || gasPrice <= 0n)) return 'gas_price_unread';
  // Above the site's ceiling no balance helps: said as that, before any lack of funds (round 3b).
  if (PRICE_REQUIRED && gasPrice !== null && gasPrice > PRICE_CEILING) return 'gas_price_high';
  return balance >= dripGasNeed(gasPrice, gasLimit) ? null : 'gas_funds';
}

/** What no balance holds: the drip's gas need while the chain's price is unreadable on a price-floor chain. */
export const UNREADABLE_PRICE_NEED = 2n ** 255n;
/** Whether this build's test network requires the chain's price for a send (BNB Chain testnet). */
export const PRICE_REQUIRED = readsGasPrice(TESTNET.chainId);
const PRICE_CEILING = TIP_CAPS[TESTNET.chainId]?.ceilingWei ?? DEFAULT_TIP_CAP.ceilingWei;

/** The chain's gas price now (the site's RPC), or null when it could not be read (never taken for zero). */
export async function gasPriceOf(rpc: Eip1193Request): Promise<bigint | null> {
  try {
    const answer = await rpc({ method: 'eth_gasPrice' });
    return typeof answer === 'string' && /^0x[0-9a-f]+$/i.test(answer) ? BigInt(answer) : null;
  } catch {
    return null;
  }
}

/** On the faucet's list (or the faucet is open to all) AND SepETH for the drip's gas: a drip can go, in either order. */
export function coinsReady(faucet: Pick<FaucetState, 'open' | 'admitted'>, sepEth: bigint, need: bigint): boolean {
  return (faucet.open || faucet.admitted) && sepEth >= need;
}
