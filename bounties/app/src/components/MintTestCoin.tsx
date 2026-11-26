import type { Address } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import { publicMintAbi } from '../abi/flap';
import { formatAmount, toDecimalString } from '../lib/amounts';
import { NO_STATE, sendWrite, useApp, useChainRead, useTx } from '../lib/app-context';
import { useWallet } from '../lib/wallet';
import { Amount, TxStatus } from './bits';
import { useWriteGate } from './WalletBar';

/** The fixed amount one press mints, in whole coins. */
export const MINT_WHOLE = 2_000n;

/**
 * Getting the test coin: one press mints a fixed 2,000 of the deployment's test quote coin to the connected wallet,
 * through the coin's own public `mint`. The coin is the one the deployment file names (never one from the page's
 * address). The balance shows before, and after the receipt the new balance read back.
 */
export function MintTestCoin() {
  const { config, client } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  // A result belongs to the account that pressed: another account sees none.
  const tx = useTx({ ownerOnly: true });
  const coin = config.flap?.tokenQuote;
  const read = useChainRead(
    async (c) => {
      if (!coin) return undefined;
      const decimals = await c.readContract({ address: coin.quote, abi: erc20Abi, functionName: 'decimals' });
      const balance = wallet.account ? await c.readContract({ address: coin.quote, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.account] }) : undefined;
      return { decimals, balance };
    },
    // no keepOnChange: another account's balance is never shown as this one's
    [coin?.quote, wallet.account],
  );
  // No wallet can be used here: no frame at all (the screen's one place that speaks is the last button's: WalletBar).
  if (!coin || !wallet.present) return null;
  const v = read.state === 'ok' ? read.value : undefined;
  // The pressing account's balance read at the press, and again at the receipt's block: both shown with the result.
  const mint = () => {
    if (!v) return;
    let before: bigint | undefined;
    let owner: Address | undefined;
    const balanceOf = (who: Address, blockNumber?: bigint) =>
      client.readContract({ address: coin.quote, abi: erc20Abi, functionName: 'balanceOf', args: [who], ...(blockNumber !== undefined ? { blockNumber } : {}) });
    void tx.run(
      'Get',
      wallet,
      async (press) => {
        owner = press.account;
        before = await balanceOf(press.account);
        // The test coin's mint is open to anyone: it needs no state.
        return sendWrite(client, wallet, { address: coin.quote as Address, abi: publicMintAbi, functionName: 'mint', args: [press.account, MINT_WHOLE * 10n ** BigInt(v.decimals)] }, press, NO_STATE);
      },
      async (receipt) => {
        const after = await balanceOf(owner!, receipt.blockNumber);
        return { ok: true, note: `Before: ${toDecimalString(before ?? 0n, v.decimals)} ${coin.label}. After: ${toDecimalString(after, v.decimals)} ${coin.label}.` };
      },
      'the new balance',
    );
  };
  return (
    <div className="box mint" data-testid="mint-box">
      <p className="review">
        {v?.balance !== undefined ? (
          <>
            You hold <span data-testid="mint-balance"><Amount value={v.balance} decimals={v.decimals} symbol={coin.label} /></span>
          </>
        ) : null}
      </p>
      <div className="actions">
        {gate ??
          (ready && v ? (
            <button type="button" className="btn" disabled={tx.busy} onClick={() => void mint()} data-testid="mint">
              Get {formatAmount(MINT_WHOLE * 10n ** BigInt(v.decimals), v.decimals)} {coin.label}
            </button>
          ) : null)}
      </div>
      <TxStatus step={tx.step} />
    </div>
  );
}
