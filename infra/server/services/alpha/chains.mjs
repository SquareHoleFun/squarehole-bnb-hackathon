// The alpha's claim rules, one row per chain (SH-275), shared by the API (intake) and the sender. Sepolia's row holds
// exactly the values both services always had: a 0.05 SepETH starter, 20 claims a day, the test coin's admission step.
// Chain 97 (BNB Chain Testnet, the hackathon build): a 0.015 tBNB starter (SH-284b, the founder 26 November: enough to
// create, fill and launch a small Flap sale alone at five times that day's gas price), 100 claims a day, and no
// admission step, because its test coin's faucet is open. Twelve confirmations, the gas cap and the fee ceiling are the same for both
// (sender/chain.mjs).
export const ALPHA_CHAINS = Object.freeze({
  11155111: Object.freeze({ starter: 50000000000000000n, dailyCap: 20, admission: true, coin: 'SepETH', network: 'Sepolia' }),
  97: Object.freeze({ starter: 15000000000000000n, dailyCap: 100, admission: false, coin: 'tBNB', network: 'BNB Chain Testnet' }),
});

/** The row of a chain the alpha runs on; any other chain is refused. */
export function alphaChain(chainId) {
  if (!Number.isSafeInteger(chainId) || !Object.hasOwn(ALPHA_CHAINS, chainId)) throw new Error('chain refused');
  return ALPHA_CHAINS[chainId];
}
