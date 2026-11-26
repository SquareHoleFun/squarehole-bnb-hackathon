import type { Address } from 'viem';
import { allowanceAt, NO_STATE, useApp, useChainRead, useTx, withApproval } from '../lib/app-context';
import { useWallet } from '../lib/wallet';
import { Amount, TxStatus } from './bits';
import { useWriteGate } from './WalletBar';

export interface AllowancePair {
  token: Address;
  spender: Address;
  symbol: string;
  decimals: number;
  /** Who may take it, in words ("this sale", "the pool router", "the pile", "OpenFour's Core"). */
  to: string;
}

/**
 * What the connected account still allows `spender` to take of `token`, read now, when it is not zero, with "Remove
 * approval": approve(spender, 0) for exactly the pair shown, confirmed by reading it back as zero at the receipt's block.
 */
export function Allowance({ token, spender, symbol, decimals, to }: AllowancePair) {
  const { client } = useApp();
  const wallet = useWallet();
  const { ready } = useWriteGate();
  const tx = useTx({ decimals, ownerOnly: true });
  const read = useChainRead(async (c) => (wallet.account ? allowanceAt(c, token, wallet.account, spender) : undefined), [token, spender, wallet.account]);
  const left = read.state === 'ok' ? read.value : undefined;
  // An allowance that could not be read is said so, never shown as nothing.
  const unread = read.state === 'error';
  if (!wallet.account || (!unread && (left === undefined || left === 0n) && tx.step.kind === 'idle')) return null;
  return (
    <div className="allowance" data-testid="allowance" data-spender={spender} data-token={token}>
      {unread && left === undefined ? (
        <p className="muted small" data-testid="allowance-unread">
          Allowed to {to}: not read
        </p>
      ) : null}
      {left !== undefined && left > 0n ? (
        <p className="muted small">
          Allowed to {to}: <Amount value={left} decimals={decimals} symbol={symbol} />{' '}
          {ready ? (
            <button
              type="button"
              className="link-btn"
              data-testid="remove-approval"
              onClick={() =>
                void tx.run(
                  'Remove approval',
                  wallet,
                  // The one approval function, amount zero, for exactly this pair; its allowance read at the press.
                  async (press) =>
                    (await withApproval(client, wallet, press, { token, spender, amount: 0n, approveLabel: `Remove approval for ${to}`, need: NO_STATE }))!,
                  async (receipt) =>
                    (await allowanceAt(client, token, receipt.from, spender, receipt.blockNumber)) === 0n
                      ? { ok: true }
                      : { ok: false, error: { name: 'not-zero', sentence: 'The allowance is not zero after it.' } },
                  'the allowance',
                )
              }
            >
              Remove approval
            </button>
          ) : null}
        </p>
      ) : null}
      <TxStatus step={tx.step} />
    </div>
  );
}

/** Every allowance of the connected account to this page's contracts that is not zero, each with its own removal. */
export function Allowances({ pairs }: { pairs: AllowancePair[] }) {
  if (!pairs.length) return null;
  return (
    <section className="allowances" data-testid="allowances">
      {pairs.map((p) => (
        <Allowance key={`${p.token}-${p.spender}`} {...p} />
      ))}
    </section>
  );
}
