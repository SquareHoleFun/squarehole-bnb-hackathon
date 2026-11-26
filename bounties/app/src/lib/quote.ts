import { BaseError, ContractFunctionRevertedError, type Address, type PublicClient } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import { tokenCurveLauncherAbi } from '../abi/flap';
import { nativeSymbol } from './chain';
import { coinLabel, type AppConfig } from './config';

/**
 * What a Flap sale is paid in: the native coin (the first pair of factories) or an ERC-20 such as Flap's test USDT
 * (the token-quote pair). The page learns it from the sale itself (`quote()`, which only the token launcher has).
 * Every amount on the sale screen, the create form and the pool box takes its symbol and decimals from here, and a
 * token sale's writes carry an approval of exactly the amount before a buy and before the completing buy.
 */
export type SaleQuote =
  | { kind: 'native'; symbol: string; decimals: number }
  | { kind: 'token'; address: Address; symbol: string; decimals: number };

export const NATIVE_QUOTE: SaleQuote = { kind: 'native', symbol: 'BNB', decimals: 18 };

/** A coin as a sale quote: its decimals from the chain, its name from the deployment's label or its own symbol. */
export async function tokenQuote(c: PublicClient, config: AppConfig, address: Address): Promise<SaleQuote> {
  const [symbol, decimals] = await Promise.all([
    c.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    c.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return { kind: 'token', address, symbol: coinLabel(config, address, symbol), decimals };
}

/**
 * A coin's unit as this page names it everywhere: the native coin by the chain's name, an ERC-20 by the deployment's
 * label where it has one (Flap's test dollar is "USDT (test)", its on-chain symbol "USD"), else its own symbol.
 */
export async function coinUnit(c: PublicClient, config: AppConfig, address: Address): Promise<{ symbol: string; decimals: number }> {
  if (/^0x0{40}$/i.test(address)) return { symbol: nativeSymbol(), decimals: 18 };
  const q = await tokenQuote(c, config, address);
  return { symbol: q.symbol, decimals: q.decimals };
}

/** The sale's quote: `quote()` answers on a token launcher; the native launcher has no such function and reverts. */
export async function readSaleQuote(c: PublicClient, config: AppConfig, launcher: Address): Promise<SaleQuote> {
  let address: Address;
  try {
    address = (await c.readContract({ address: launcher, abi: tokenCurveLauncherAbi, functionName: 'quote' })) as Address;
  } catch (e) {
    // The contract answered with a revert (no such function): a native sale. A failed endpoint is thrown on.
    if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return NATIVE_QUOTE;
    throw e;
  }
  return tokenQuote(c, config, address);
}

/** The value a payable call carries for `amount` of the quote: the amount for the native coin, nothing for a token. */
export function valueFor(quote: SaleQuote, amount: bigint): bigint | undefined {
  return quote.kind === 'native' ? amount : undefined;
}
