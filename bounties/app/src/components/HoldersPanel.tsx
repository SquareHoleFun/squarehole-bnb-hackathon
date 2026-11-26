import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import { railStakeAbi } from '../abi/railStake';
import { formatAmount, toDecimalString } from '../lib/amounts';
import { sendWrite, useApp, useChainRead, useTx, withApproval, type Need } from '../lib/app-context';
import { REFUSALS } from '../lib/forms';
import { checkStake, checkUnstake, findStake, flapPayees, holderRate, readStakeNow, stakeShareText, streamState, timeLeft, type Payees, type StakeInfo, type StakeNow } from '../lib/stake';
import { coinUnit } from '../lib/quote';
import { useWallet } from '../lib/wallet';
import { Amount, Help, Stat, TxStatus } from './bits';
import { useWriteGate } from './WalletBar';
import { useShareFigure } from '../picture/live-figures';

/**
 * SH-290: holder payouts on a token launched on Flap or Four.meme (bounties/core/src/IRailStake.sol). Mounted at the end of
 * the sale's and the token's pages with the token and its creator. It shows only the creator's own stake made by our
 * factory (lib/stake.ts `findStake`), and nothing at all without the factory in the deployment file or without such a
 * stake. Numbers first: what is staked in all and by the visitor, what the visitor can claim now, what is still being
 * paid out and until when, what has arrived and is not yet counted; then the presses Stake (the exact approval, then
 * the stake), Unstake, Claim and Count. Every send goes through the page's write gate and `sendWrite`.
 */
export const HOLDERS_WORDS = Object.freeze({
  title: 'Holders',
  help: 'How holder payouts work',
  helpLines: [
    'Staking pays from what the token’s rules send here, in the coin it arrives in.',
    'What arrives is paid out once someone counts it: bit by bit until the end shown (new income moves that end; while nobody is staked it pauses), to everyone staked, by the second.',
    'Unstaking has no lock and no fee and returns the token, not your earnings (they stay claimable); a token that taxes transfers gives back less.',
  ],
  totalStaked: 'Staked in all',
  myStake: 'You staked',
  claimable: 'You can claim',
  paying: 'Paying out',
  until: 'until',
  paused: 'paused while nobody is staked',
  leftover: 'Left over',
  leftoverNote: 'paid with the next income.',
  waiting: 'Arrived, not counted yet',
  paidOut: 'Paid out',
  stake: 'Stake',
  unstake: 'Unstake',
  claim: 'Claim',
  count: 'Count',
  youHold: 'you hold',
  yourRate: 'Your rate now',
  perDay: 'a day, until the end shown',
});

/** The creator a Flap sale names (bounties/flap/abi/CurveLauncher.json `creator()`; stake.test.ts compares the entry). */
export const launcherCreatorAbi = [
  { type: 'function', name: 'creator', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

/** The panel on a Flap sale's page, once launched: its creator read from the sale. */
/**
 * `payees`: the sale's rules' payees as the sale page read them at the deployment file's rules vault factory (SH-281
 * step 3); without them, the rules the launcher's own factory reports (flapPayees). findStake checks the stake either way.
 */
export function FlapHolders({ launcher, token, payees }: { launcher: Address; token: Address; payees?: readonly Address[] }) {
  const { config } = useApp();
  const creator = useChainRead((c) => (config.railStake ? c.readContract({ address: launcher, abi: launcherCreatorAbi, functionName: 'creator' }) : Promise.resolve(null)), [launcher, config.railStake?.factory]);
  if (creator.state !== 'ok' || creator.value === null) return null;
  return (
    <HoldersPanel
      token={token}
      creator={creator.value}
      payees={payees ? async () => payees : flapPayees(launcher)}
      payeesKey={payees ? `${launcher}:${payees.join(',')}` : launcher}
    />
  );
}

/** The panel for one token, or nothing. `payees`: who the launch's tax pays (lib/stake.ts); `payeesKey` names it. */
export function HoldersPanel({ token, creator, payees, payeesKey }: { token: Address; creator: Address; payees: Payees; payeesKey: string }) {
  const { config } = useApp();
  const factory = config.railStake?.factory;
  const found = useChainRead((c) => (factory ? findStake(c, factory, creator, token, payees) : Promise.resolve(null)), [factory, creator, token, payeesKey]);
  if (!factory || found.state !== 'ok' || found.value === null) return null;
  return <Stake info={found.value} />;
}

function Stake({ info }: { info: StakeInfo }) {
  const wallet = useWallet();
  const { config } = useApp();
  const meta = useChainRead(async (c) => {
    const [decimals, symbol] = await Promise.all([
      c.readContract({ address: info.token, abi: erc20Abi, functionName: 'decimals' }),
      c.readContract({ address: info.token, abi: erc20Abi, functionName: 'symbol' }),
    ]);
    // the sale's coin as the rest of the page names it (coinUnit: the deployment's label, e.g. "USDT (test)")
    const asset = await coinUnit(c, config, info.asset);
    return { token: { decimals: Number(decimals), symbol: String(symbol) }, asset };
  }, [info.stake]);
  // Another account's numbers are never shown as this one's (no keepOnChange).
  const now = useChainRead((c) => readStakeNow(c, info, wallet.account), [info.stake, wallet.account]);
  if (meta.state !== 'ok' || now.state !== 'ok') return null;
  return <StakeView info={info} n={now.value} t={meta.value.token} a={meta.value.asset} />;
}

type Unit = { decimals: number; symbol: string };

function StakeView({ info, n, t, a }: { info: StakeInfo; n: StakeNow; t: Unit; a: Unit }) {
  // SH-319: the stake for the page's picture (this panel's own read).
  useShareFigure('holders', { value: n.totalStaked, decimals: t.decimals, symbol: t.symbol });
  const state = streamState(n);
  const mine = n.mine;
  // Per day, from the scaled rate (the whole-unit rate can read 0 while a stream pays).
  const perDay = mine ? holderRate(n.rateScaled, mine.staked, n.totalStaked, 86_400n) : 0n;
  return (
    <section className="sh-panel panel holders" data-testid="holders-panel" data-stake={info.stake}>
      <header className="panel-head">
        <h2 className="screen-title">{HOLDERS_WORDS.title}</h2>
        <Help label={HOLDERS_WORDS.help}>
          {HOLDERS_WORDS.helpLines.map((line) => <span key={line} className="help-line">{line} </span>)}
        </Help>
      </header>
      <div className="stats">
        <Stat label={HOLDERS_WORDS.totalStaked} testId="holders-total">
          <Amount value={n.totalStaked} decimals={t.decimals} symbol={t.symbol} />
        </Stat>
        {mine ? (
          <Stat label={HOLDERS_WORDS.myStake} testId="holders-mine">
            <Amount value={mine.staked} decimals={t.decimals} symbol={t.symbol} />
            {n.totalStaked > 0n && mine.staked > 0n ? <span className="muted small" data-testid="holders-share"> {stakeShareText(mine.staked, n.totalStaked)}</span> : null}
          </Stat>
        ) : null}
        {mine ? (
          <Stat label={HOLDERS_WORDS.claimable} testId="holders-claimable">
            <Amount value={mine.claimable} decimals={a.decimals} symbol={a.symbol} />
          </Stat>
        ) : null}
        <Stat label={state === 'leftover' ? HOLDERS_WORDS.leftover : HOLDERS_WORDS.paying} testId={state === 'leftover' ? 'holders-leftover' : 'holders-paying'}>
          <Amount value={n.undistributed} decimals={a.decimals} symbol={a.symbol} />
          {state === 'leftover' ? (
            <span className="muted small" data-testid="holders-leftover-note"> {HOLDERS_WORDS.leftoverNote}</span>
          ) : state === 'streaming' ? (
            <span className="muted small" data-testid="holders-until"> {HOLDERS_WORDS.until} {new Date(Number(n.streamEnd) * 1000).toUTCString().slice(5, 22)} UTC ({timeLeft(n.streamEnd - n.now)})</span>
          ) : state === 'paused' ? (
            <span className="muted small" data-testid="holders-paused"> {HOLDERS_WORDS.paused}</span>
          ) : null}
        </Stat>
        <Stat label={HOLDERS_WORDS.waiting} testId="holders-unsynced">
          <Amount value={n.unsynced} decimals={a.decimals} symbol={a.symbol} />
        </Stat>
        <Stat label={HOLDERS_WORDS.paidOut} testId="holders-claimed">
          <Amount value={n.claimed} decimals={a.decimals} symbol={a.symbol} />
        </Stat>
        {mine && perDay > 0n && state === 'streaming' ? (
          <Stat label={HOLDERS_WORDS.yourRate} testId="holders-rate">
            <Amount value={perDay} decimals={a.decimals} symbol={a.symbol} /> <span className="muted small">{HOLDERS_WORDS.perDay}</span>
          </Stat>
        ) : null}
      </div>
      <Presses info={info} n={n} t={t} a={a} />
    </section>
  );
}

function Presses({ info, n, t, a }: { info: StakeInfo; n: StakeNow; t: Unit; a: Unit }) {
  const wallet = useWallet();
  const { client } = useApp();
  const { ready, gate } = useWriteGate();
  const tx = useTx({ decimals: t.decimals, ownerOnly: true, errors: 'stake' });
  const [stakeText, setStakeText] = useState('');
  const [unstakeText, setUnstakeText] = useState('');
  useEffect(() => tx.reset(), [info.stake]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = n.mine;
  const stakeChecked = checkStake(stakeText, t.decimals, mine?.balance);
  const unstakeChecked = checkUnstake(unstakeText, t.decimals, mine?.staked);
  // Every step needs the stake still this token's, read when it goes.
  const stillOurs: Need = async () => ((await client.readContract({ address: info.stake, abi: railStakeAbi, functionName: 'token' })) as string).toLowerCase() === info.token.toLowerCase() ? null : 'the stake names another token';
  const write = (functionName: 'stake' | 'unstake' | 'sync' | 'claim', args: readonly bigint[], account: Address) =>
    client.simulateContract({ account, address: info.stake, abi: railStakeAbi, functionName, args } as never).then(({ request }) => request as Record<string, unknown>);

  const doStake = () => stakeChecked.ok && tx.run(HOLDERS_WORDS.stake, wallet, async (press) => {
    const amount = stakeChecked.value;
    await withApproval(client, wallet, press, {
      token: info.token,
      spender: info.stake,
      amount,
      approveLabel: `Approve ${toDecimalString(amount, t.decimals)} ${t.symbol} for the stake`,
      mainLabel: HOLDERS_WORDS.stake,
      need: stillOurs,
    });
    return sendWrite(client, wallet, await write('stake', [amount], press.account), press, stillOurs);
  }).then((r) => { if (r) setStakeText(''); });
  const doUnstake = () => unstakeChecked.ok && tx.run(HOLDERS_WORDS.unstake, wallet, async (press) => {
    press.steps([HOLDERS_WORDS.unstake]);
    return sendWrite(client, wallet, await write('unstake', [unstakeChecked.value], press.account), press, stillOurs);
  }).then((r) => { if (r) setUnstakeText(''); });
  const doClaim = () => tx.run(HOLDERS_WORDS.claim, wallet, async (press) => {
    press.steps([HOLDERS_WORDS.claim]);
    return sendWrite(client, wallet, await write('claim', [], press.account), press, stillOurs);
  });
  const doCount = () => tx.run(HOLDERS_WORDS.count, wallet, async (press) => {
    press.steps([HOLDERS_WORDS.count]);
    return sendWrite(client, wallet, await write('sync', [], press.account), press, stillOurs);
  });

  return (
    <div className="holders-presses">
      {n.unsynced > 0n ? (
        <div className="actions">
          {ready ? <button type="button" className="btn" disabled={tx.busy} onClick={() => void doCount()} data-testid="holders-count">{HOLDERS_WORDS.count}</button> : null}
        </div>
      ) : null}
      <div className="box" data-testid="holders-stake-box">
        <label className="field">
          <span className="field-label">
            {HOLDERS_WORDS.stake} {t.symbol}
            {mine ? (
              <button type="button" className="link-btn" disabled={tx.busy} onClick={() => setStakeText(toDecimalString(mine.balance, t.decimals))}>
                {HOLDERS_WORDS.youHold} {formatAmount(mine.balance, t.decimals)}
              </button>
            ) : null}
          </span>
          <input inputMode="decimal" value={stakeText} onChange={(e) => setStakeText(e.target.value)} placeholder="0" disabled={tx.busy} data-testid="holders-stake-amount" />
        </label>
        {stakeText !== '' && !stakeChecked.ok ? <p className="refusal" data-testid="holders-stake-refusal">{REFUSALS[stakeChecked.refusal]}</p> : null}
        <div className="actions">
          {gate ?? (ready ? <button type="button" className="btn btn-primary" disabled={tx.busy || !stakeChecked.ok} onClick={() => void doStake()} data-testid="holders-stake">{HOLDERS_WORDS.stake}</button> : null)}
        </div>
      </div>
      {mine && mine.staked > 0n ? (
        <div className="box" data-testid="holders-unstake-box">
          <label className="field">
            <span className="field-label">
              {HOLDERS_WORDS.unstake} {t.symbol}
              <button type="button" className="link-btn" disabled={tx.busy} onClick={() => setUnstakeText(toDecimalString(mine.staked, t.decimals))}>
                {HOLDERS_WORDS.myStake.toLowerCase()} {formatAmount(mine.staked, t.decimals)}
              </button>
            </span>
            <input inputMode="decimal" value={unstakeText} onChange={(e) => setUnstakeText(e.target.value)} placeholder="0" disabled={tx.busy} data-testid="holders-unstake-amount" />
          </label>
          {unstakeText !== '' && !unstakeChecked.ok ? <p className="refusal" data-testid="holders-unstake-refusal">{REFUSALS[unstakeChecked.refusal]}</p> : null}
          <div className="actions">
            {ready ? <button type="button" className="btn" disabled={tx.busy || !unstakeChecked.ok} onClick={() => void doUnstake()} data-testid="holders-unstake">{HOLDERS_WORDS.unstake}</button> : null}
          </div>
        </div>
      ) : null}
      {mine && mine.claimable > 0n && ready ? (
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={tx.busy} onClick={() => void doClaim()} data-testid="holders-claim">
            {HOLDERS_WORDS.claim} <Amount value={mine.claimable} decimals={a.decimals} symbol={a.symbol} />
          </button>
        </div>
      ) : null}
      <TxStatus step={tx.step} />
    </div>
  );
}
