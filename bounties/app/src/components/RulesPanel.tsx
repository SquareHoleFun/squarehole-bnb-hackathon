/**
 * SH-287 on the launch page: a token's rules for its income, as fixed (bounties/core/src/IRuleSplitter.sol). Before the
 * launch, the parts stored for the sale; after it, the splitter's own rules, what it has sent each and what waits, and
 * one press, Share out, that calls `distribute()`. The caller shows this only for a splitter its own factory created.
 */
import type { ReactNode } from 'react';
import type { Abi, Address, PublicClient } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import { sendWrite, useApp, useChainRead, useTx } from '../lib/app-context';
import { formatBps } from '../lib/amounts';
import { payeesOf, RULE_KIND, ruleName } from '../lib/rules';
import { chainViewRead, payeeNames } from '../lib/payee-names';
import { useWallet } from '../lib/wallet';
import { AddressLink, Amount, Help, ReadError, TxStatus } from './bits';
import { useWriteGate } from './WalletBar';
import { useShareFigure } from '../picture/live-figures';

/** The splitter's reads and its one write (the same in RulesVault and RuleSplitter). */
export const ruleSplitterAbi = [
  { type: 'function', name: 'ruleCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'rule',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'kind', type: 'uint8' },
      { name: 'bps', type: 'uint16' },
      { name: 'target', type: 'address' },
    ],
  },
  { type: 'function', name: 'owed', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'delivered', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'burned', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'pending', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalOwed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'distribute', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const satisfies Abi;

export interface FixedRule {
  kind: number;
  bps: number;
  target: Address;
}

export interface RuleNow extends FixedRule {
  owed: bigint;
  delivered: bigint;
  burned: bigint;
}

export interface SplitterNow {
  rules: RuleNow[];
  pending: bigint;
}

export async function readSplitter(c: PublicClient, splitter: Address): Promise<SplitterNow> {
  const [count, pending] = await Promise.all([
    c.readContract({ address: splitter, abi: ruleSplitterAbi, functionName: 'ruleCount' }),
    c.readContract({ address: splitter, abi: ruleSplitterAbi, functionName: 'pending' }),
  ]);
  const rules = await Promise.all(
    Array.from({ length: Number(count) }, async (_, n) => {
      const i = BigInt(n);
      const [[kind, bps, target], owed, delivered, burned] = await Promise.all([
        c.readContract({ address: splitter, abi: ruleSplitterAbi, functionName: 'rule', args: [i] }),
        c.readContract({ address: splitter, abi: ruleSplitterAbi, functionName: 'owed', args: [i] }),
        c.readContract({ address: splitter, abi: ruleSplitterAbi, functionName: 'delivered', args: [i] }),
        c.readContract({ address: splitter, abi: ruleSplitterAbi, functionName: 'burned', args: [i] }),
      ]);
      return { kind: Number(kind), bps: Number(bps), target, owed, delivered, burned };
    }),
  );
  return { rules, pending };
}

export interface RulesPanelProps {
  /** Before the launch: the parts as stored for the sale (no splitter yet). */
  fixed?: FixedRule[];
  /** After the launch: the splitter our factory created. */
  splitter?: Address;
  asset: { symbol: string; decimals: number };
  tokenSymbol: string;
  /** Writes allowed (a sale or token this page trusts). */
  writable: boolean;
  /** What the parts share, as one sentence ("Of the curve fees at the launch, and of …"). */
  of: string;
  /** The rail: its buy back and when its parts become final differ. */
  rail: 'flap' | 'four';
  /** The launch's creator: a rule paying it is "Creator"; any other payee is named by `named` or "Paid to". */
  creator?: Address;
  /**
   * The launch's token (or, before a Flap launch, the token it will create): with it and the creator, a payee is
   * named "Card shop" or "Holders" when, and only when, lib/payee-names.ts proves it on chain against the deployment
   * file's factories (`shops.factory`, `railStake.factory`); anything else stays "Paid to <address>".
   */
  token?: Address;
  /** Other lanes' seam: what to show for the launch's payees (CREATOR rules' targets, in rule order). */
  renderPayees?: (payees: Address[]) => ReactNode;
}

/** The buy back's sentence per rail (the Flap pool exists from the launch; the Four.meme copy's pool only after the move). */
export const BUY_BACK_SAYS: Readonly<Record<'flap' | 'four', string>> = Object.freeze({
  flap: 'Buys the token on its pool at each share-out and sends it to the dead address.',
  four: 'Buys the token and sends it to the dead address. It waits until the token moves to PancakeSwap; if it never moves, it waits for good.',
});

/** When the parts become final per rail: setRules is taken only before the sale exists; the clone's parameters are signed into the token's creation. */
export const FINAL_SAYS: Readonly<Record<'flap' | 'four', string>> = Object.freeze({
  flap: 'Nobody, not the creator either, can change the parts once the sale exists.',
  four: 'Nobody, not the creator either, can change the parts once the token exists.',
});

export function RulesPanel({ fixed, splitter, asset, tokenSymbol, writable, of, rail, creator, token, renderPayees }: RulesPanelProps) {
  const { client, config } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const tx = useTx();
  const now = useChainRead((c) => (splitter ? readSplitter(c, splitter) : Promise.resolve(undefined)), [splitter]);
  const v = now.state === 'ok' ? now.value : undefined;
  const rows: (FixedRule & Partial<RuleNow>)[] = v ? v.rules : (fixed ?? []);
  const owedAll = v ? v.rules.reduce((a, r) => a + r.owed, 0n) : 0n;
  const anything = v ? v.pending > 0n || owedAll > 0n : false;
  // The names the chain proves for the paying rules' targets (none without the factories, the token or the creator).
  const payees = payeesOf(rows);
  const shops = config.shops?.factory;
  const stakes = config.railStake?.factory;
  const proven = useChainRead(
    (c) =>
      token && creator && payees.length && (shops || stakes)
        ? payeeNames(chainViewRead(c), { shops, stakes }, { token, creator }, payees)
        : Promise.resolve({} as Record<string, string>),
    [token, creator, shops, stakes, payees.join(',')],
  );
  const names = proven.state === 'ok' ? proven.value : {};
  const named = (a: Address) => names[a.toLowerCase()];
  // SH-319: each rule's part, name and what it was sent, for the page's picture (this panel's own reads).
  useShareFigure(
    'rules',
    rows.length
      ? { rows: rows.map((r) => ({ kind: r.kind, bps: r.bps, name: ruleName(r.kind, r.target, creator, named), sent: r.delivered, burned: r.burned })), decimals: asset.decimals, symbol: asset.symbol }
      : undefined,
  );
  return (
    <section className="sh-panel panel box-panel" data-testid="rules-panel">
      <header className="panel-head">
        <h3>Rules</h3>
        <Help label="About the rules">
          <span data-testid="rules-of">{of} {FINAL_SAYS[rail]}</span>{' '}
          {rows.some((r) => r.kind === RULE_KIND.burn) ? <span data-testid="rules-buy-back">{BUY_BACK_SAYS[rail]} </span> : null}
          {v ? <>
            A part that cannot be paid now stays owed and is tried again at the next share-out.{' '}
            Share out splits what waits by the parts, then sends each rule what it is owed; what cannot be sent stays owed.
          </> : null}
        </Help>
      </header>
      {now.state === 'error' ? <ReadError text="Could not read the rules yet. Trying again." testId="rules-error" /> : null}
      <ul className="rules-list">
        {rows.map((r, i) => (
          <li key={i} data-testid={`rule-${i}`} data-kind={r.kind}>
            <span className="rules-name">
              {(() => {
                const name = ruleName(r.kind, r.target, creator, named);
                const bps = <strong data-testid={`rule-${i}-bps`}>{formatBps(BigInt(r.bps))}</strong>;
                if (r.kind !== RULE_KIND.creator) return <><span data-testid={`rule-${i}-name`}>{name}</span> {bps}</>;
                // "Paid to <address>"; a named payee or the creator: the name, then where it goes
                return name === 'Paid to' ? (
                  <><span data-testid={`rule-${i}-name`}>Paid to</span> <AddressLink address={r.target} /> {bps}</>
                ) : (
                  <><span data-testid={`rule-${i}-name`}>{name}</span> {bps}<span className="muted small"> to <AddressLink address={r.target} /></span></>
                );
              })()}
            </span>
            {r.delivered !== undefined ? (
              <span className="rules-nums small">
                <span>
                  {r.kind === RULE_KIND.burn ? 'spent on buying' : 'sent'}{' '}
                  <span data-testid={`rule-${i}-delivered`}>
                    <Amount value={r.delivered} decimals={asset.decimals} symbol={asset.symbol} />
                  </span>
                </span>
                {r.kind === RULE_KIND.burn ? (
                  <span>
                    reached the dead address{' '}
                    <span data-testid={`rule-${i}-burned`}>
                      <Amount value={r.burned ?? 0n} decimals={18} symbol={tokenSymbol} />
                    </span>
                  </span>
                ) : null}
                {r.owed ? (
                  <span>
                    owed{' '}
                    <span data-testid={`rule-${i}-owed`}>
                      <Amount value={r.owed} decimals={asset.decimals} symbol={asset.symbol} />
                    </span>
                  </span>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {v ? (
        <>
          <p className="stat-value small">
            Waiting to be shared:{' '}
            <span data-testid="rules-pending">
              <Amount value={v.pending} decimals={asset.decimals} symbol={asset.symbol} />
            </span>
          </p>
          {writable && splitter ? (
            <div className="actions">
              {gate ??
                (ready ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={tx.busy || !anything}
                    data-testid="share-out"
                    onClick={() =>
                      void tx.run('Share out', wallet, async (press) => {
                        const { request } = await client.simulateContract({ account: press.account, address: splitter, abi: ruleSplitterAbi, functionName: 'distribute' });
                        return sendWrite(client, wallet, request, press, async () => {
                          const n = await readSplitter(client, splitter);
                          return n.pending > 0n || n.rules.some((r) => r.owed > 0n) ? null : 'nothing waits to be shared out';
                        });
                      })
                    }
                  >
                    Share out
                  </button>
                ) : null)}
            </div>
          ) : null}
          <TxStatus step={tx.step} />
        </>
      ) : null}
      {renderPayees ? renderPayees(payeesOf(rows)) : null}
    </section>
  );
}
