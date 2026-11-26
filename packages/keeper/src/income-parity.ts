import { keccak256, parseAbi, type Address, type PublicClient } from 'viem';
import { ethParityManifest, type EthParityPin } from './income-parity-manifest';
import type { IncomeBlock, IncomePrice } from './income-price';
import { IncomeValuationError } from './income-failure';
import { atlasRates } from './atlas-rates';

/** F164 D3: the only chain on which a pinned coin may count 1:1 with ETH for keeper room. Mainnet is refused. */
export const ETH_PARITY_CHAIN_ID = '11155111';
/**
 * SH-259: the test networks whose pinned test coins count for keeper room in the native coin, at the same reviewed rate
 * literals: Sepolia, and BNB Chain testnet (97), where the native coin is tBNB. Every other chain is refused.
 */
export const ETH_PARITY_CHAIN_IDS: readonly string[] = Object.freeze([ETH_PARITY_CHAIN_ID, '97']);
const U256 = (1n << 256n) - 1n;
const erc20 = parseAbi(['function decimals() view returns (uint8)']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (a: unknown): a is Address => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && BigInt(a) !== 0n;
const requireThat: (ok: unknown, why: string) => asserts ok = (ok, why) => { if (!ok) throw new IncomeValuationError('PIN_INVALID', `eth parity ${why}`); };

/** A test network of ETH_PARITY_CHAIN_IDS, canonical key, supported decimals, code hash or null, positive uint256 rate. */
export function checkedEthParity(key: string, pin: EthParityPin): EthParityPin {
  requireThat(ETH_PARITY_CHAIN_IDS.includes(pin.chainId), `refused on chain ${pin.chainId}: Sepolia only, or BNB Chain testnet (97)`);
  requireThat(address(pin.token) && key === `${pin.chainId}:${pin.token.toLowerCase()}`, 'key mismatch');
  requireThat(typeof pin.decimals === 'string' && /^(?:[6-9]|1[0-8])$/.test(pin.decimals), 'needs 6..18 decimals');
  requireThat(typeof pin.weiPerCoin === 'string' && /^[1-9][0-9]{0,77}$/.test(pin.weiPerCoin)
    && BigInt(pin.weiPerCoin) <= U256, 'rate out of range');
  requireThat(pin.codeHash === null || /^0x[0-9a-fA-F]{64}$/.test(pin.codeHash), 'code hash malformed');
  return pin;
}

/** The reviewed pin for this chain and coin, or none. A matching entry for any other chain than those two is refused (throws). */
export function ethParityPin(chainId: bigint, token: Address): EthParityPin | undefined {
  const found = Object.entries(ethParityManifest).filter(([, pin]) => pin.chainId === chainId.toString() && same(pin.token, token));
  const first = found[0];
  if (!first) return undefined;
  requireThat(found.length === 1, 'ambiguous');
  return checkedEthParity(...first);
}

/**
 * Fixed test-network valuation at finality (Sepolia, BNB Chain testnet). Unknown coins retain the existing route path. A bad or null pin throws,
 * zeroing the box rather than falling back to another price. Receipt proofs and F111 limits stay unchanged.
 */
export async function readEthParityPrice(pub: PublicClient, q: Address, block: IncomeBlock): Promise<IncomePrice | null> {
  const chainId = await pub.getChainId();
  requireThat(Number.isSafeInteger(chainId) && chainId > 0, 'chain unavailable');
  const pin = ethParityPin(BigInt(chainId), q);
  if (!pin) return null;
  requireThat(pin.codeHash !== null, 'code hash not pinned yet');
  // getBytecode is one of TickReads' cached views (tick-reads.ts).
  const code = await pub.getBytecode({ address: pin.token, blockNumber: block.number });
  requireThat(code !== undefined && code !== '0x' && keccak256(code) === pin.codeHash.toLowerCase(), 'code differs on chain');
  const decimals = await pub.readContract({ address: pin.token, abi: erc20, functionName: 'decimals', blockNumber: block.number });
  requireThat(String(decimals) === pin.decimals, 'decimals differ on chain');
  // SH-266: on chain 97 a coin with an Atlas feed is valued at live prices instead of the rate literal; without a fresh
  // price it throws (VALUATION_UNAVAILABLE: no upkeep for the box). The checks above stay: the pin still names the coin.
  const rates = atlasRates();
  const live = rates && rates.chainId === pin.chainId ? rates.quoteFor(pin.token) : null;
  if (live) {
    return {
      route: [live.route, pin.decimals, pin.codeHash].join(':').toLowerCase(),
      quote(amount) {
        requireThat(typeof amount === 'bigint' && amount >= 0n && amount <= U256, 'amount out of range');
        const value = live.quote(amount);
        requireThat(value >= 0n && value <= U256, 'value out of range');
        return value;
      },
    };
  }
  return {
    route: ['eth-parity', pin.chainId, pin.token, pin.decimals, pin.codeHash, pin.weiPerCoin].join(':').toLowerCase(),
    quote(amount) {
      requireThat(typeof amount === 'bigint' && amount >= 0n && amount <= U256, 'amount out of range');
      const value = amount * BigInt(pin.weiPerCoin) / (10n ** BigInt(pin.decimals));
      requireThat(value <= U256, 'value out of range');
      return value;
    },
  };
}
