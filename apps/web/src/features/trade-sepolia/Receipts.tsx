/**
 * F156 (SH-ALPHA-TRADE-BOX, SH-ALPHA-TEST-COINS): the transactions a page of the trade folder sent or followed, one row
 * each: what it was, where it stands (a revert with its one line; a mined trade with what it took, and "filled in part"
 * when that is less than its call offered), and its explorer page (Etherscan on Sepolia; the short hash on a local chain).
 * The row also carries the fill's raw amounts, as decimal strings.
 */
import type { SentReceipt } from './use-sends';
import { tradeLine } from './trade-words';

const shortHash = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;

/** Where a row stands, in a word or a few: a mined trade by its fill (in part, or whole with what it took). */
function stateOf(r: SentReceipt): string {
  if (r.status === 'pending') return 'pending';
  if (r.status === 'replaced') return 'replaced';
  if (r.status === 'reverted') return `reverted: ${tradeLine(r.reason ?? 'unknown_revert')}`;
  if (r.fill && r.fill.spent < r.fill.offered) return r.figures ? `filled in part: ${r.figures}` : 'filled in part';
  return r.fill && r.figures ? `confirmed: ${r.figures}` : 'confirmed';
}

export function Receipts({ receipts, explorer }: { readonly receipts: readonly SentReceipt[]; readonly explorer: ((hash: string) => string | null) | null }) {
  if (receipts.length === 0) return null;
  return (
    <ol className="sh-trade-box__receipts" aria-label="Transactions">
      {receipts.map((r) => {
        const href = explorer?.(r.hash) ?? null;
        const fill = r.status === 'success' && r.fill ? r.fill : null;
        return (
          <li key={r.hash} className="sh-trade-box__receipt" data-status={r.status}
            data-fill={fill ? (fill.spent < fill.offered ? 'part' : 'whole') : undefined} data-spent={fill?.spent.toString()} data-offered={fill?.offered.toString()}>
            <span>{`${r.what} ${stateOf(r)}`}</span>
            {href
              ? <a href={href} target="_blank" rel="noopener noreferrer" title={r.hash}><code>{shortHash(r.hash)}</code><span className="sh-visually-hidden"> (opens the explorer in a new tab)</span></a>
              : <code title={r.hash}>{shortHash(r.hash)}</code>}
          </li>
        );
      })}
    </ol>
  );
}
