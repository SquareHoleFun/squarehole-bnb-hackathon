/**
 * SH-258: what the site prints for the native coin: `ETH` on Sepolia (and the local chains), `BNB` on BNB Chain
 * testnet (`SH_TESTNET=bnb`; packages/chain/src/config/testnet-profile.ts `coin.symbol`). Wallets name the testnet coin
 * themselves (SepoliaETH, tBNB); the site mirrors what it printed for ETH on Sepolia.
 */
import { TESTNET } from '@squarehole/chain/write/wallet';

export const NATIVE_SYMBOL: string = TESTNET.coin.symbol;
/** The wrapped native coin's name in words ("WETH", "WBNB"). */
export const WRAPPED_NATIVE_SYMBOL = `W${NATIVE_SYMBOL}`;
/** What the gas lines name (SH-258): Sepolia's as they were ("SepETH"), the wallet's symbol elsewhere ("tBNB"). */
export const GAS_SYMBOL: string = TESTNET.name === 'sepolia' ? 'SepETH' : TESTNET.coin.walletSymbol;
