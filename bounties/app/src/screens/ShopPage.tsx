/**
 * SH-288: a card shop's page (`#/shop/<address>`): a shop our factory made for a token launched on Flap or Four.meme.
 * Its cards as a grid (pick one, pay its pick price in the token), the give side (hand in a card of a listed
 * collection, receive its give price), the budget, what is left of the seven-day cap on gives, and the tax waiting in
 * the shop with a "Refill" press. Every send goes through the page's own path (useTx, sendWrite, withApproval): the
 * approval first (the card for a give, the exact pick price for a pick), then the call, each checked when it goes.
 */
import { usePageTitle } from '../lib/page-title';
import { useEffect, useState } from 'react';
import type { Address, PublicClient } from 'viem';
import { cardsAbi, shopAbi } from '../abi/shop';
import { Amount, AddressLink, Age, Help, Stat, TxStatus } from '../components/bits';
import { ShopCards, useCollectionNames } from '../components/ShopCard';
import { useShopStock } from '../lib/use-shop-stock';
import { useWriteGate } from '../components/WalletBar';
import { formatAmount, toDecimalString } from '../lib/amounts';
import { sendWrite, useApp, useChainRead, useTx, waitForApproval, withApproval, type Need } from '../lib/app-context';
import { shortAddress } from '../lib/chain';
import { PageRefusal } from '../lib/errors';
import { cardKey, cardsLine, flapCreatorOf, flapRulesLauncherOf, giveBlock, giveRefusal, makerOf, ownCardsOf, ownGroup, utcWhen, type ShopInfo, type ShopNow } from '../lib/shop';
import type { AppConfig } from '../lib/config';
import { readFourToken } from './FourToken';
import { useWallet } from '../lib/wallet';
import '../styles/shop.css';

const when = utcWhen;

export function ShopPage({ shop }: { shop: Address }) {
  const wallet = useWallet();
  const { info, ours, now } = useShopStock(shop, wallet.account);
  usePageTitle('shop', ours?.tokenSymbol);
  if (info.state === 'ok' && info.value.kind !== 'ours') {
    return (
      <section className="sh-panel panel" data-testid="shop-page" data-absent={info.value.kind}>
        <p className="muted">{info.value.kind === 'not-created' ? `No shop at ${shortAddress(shop)} yet.` : `No card shop of ours at ${shortAddress(shop)}.`}</p>
      </section>
    );
  }
  if (!ours || now.state !== 'ok' || now.value === undefined) {
    const failed = info.state === 'error' || now.state === 'error';
    return (
      <section className="sh-panel panel" data-testid="shop-page" aria-busy="true">
        <p className="muted">{failed ? 'Could not read the shop yet. Trying again.' : 'Reading the shop…'}</p>
      </section>
    );
  }
  return <ShopBody info={ours} now={now.value} at={now.at} stale={now.stale} />;
}

/**
 * Who made the shop, against who launched its token (the Four.meme token's creator, or the Flap sale's creator, from
 * the deployment file's rails); null where this page cannot tell who launched the token.
 */
async function launchCreatorOf(c: PublicClient, config: AppConfig, token: Address): Promise<Address | null> {
  if (config.openfour) {
    const info = await readFourToken(c, config.openfour.core, token).catch(() => null);
    if (info?.exists) return info.creator as Address;
  }
  const sale = config.flap?.sales.concat(config.flap.tokenQuote?.sales ?? []).find((s) => s.token?.toLowerCase() === token.toLowerCase());
  if (sale) return flapCreatorOf(c, config, sale.launcher);
  // SH-281 step 3: a Flap rules sale (not in the file's list): our rules vault factory's record of the token's sale,
  // then that sale's creator from our launcher factory's own creation event (null if it is not ours)
  const launcher = await flapRulesLauncherOf(c, config, token);
  return launcher ? flapCreatorOf(c, config, launcher) : null;
}

function ShopBody({ info, now, at, stale }: { info: ShopInfo; now: ShopNow; at: number; stale: boolean }) {
  const { config } = useApp();
  // A shop opened by its address may be anyone's: who made it, said plainly (no trust word either way). The swaps stay:
  // they are the contract's to allow, and the page says what it knows.
  const launched = useChainRead((c) => launchCreatorOf(c, config, info.token), [info.token]);
  const maker = makerOf(info.creator, launched.state === 'ok' ? launched.value : undefined);
  const count = cardsLine(now);
  const names = useCollectionNames(info);
  const t = (v: bigint) => <Amount value={v} decimals={info.tokenDecimals} symbol={info.tokenSymbol} />;
  return (
    <section className="sh-panel panel shop" data-testid="shop-page" data-maker={maker}>
      <header className="panel-head">
        <h2>
          {info.tokenSymbol} cards
          {/* The token's collection: the cards' own names, as the cards show them. */}
          <span className="muted shop-names" data-testid="shop-names"> · {info.collections.map((c) => names.get(c.nft.toLowerCase())).join(' · ')}</span>
        </h2>
        <span className="head-end">
          <Age at={at} stale={stale} />
          <Help label="About the shop">
            Swap a card for {info.tokenSymbol}, or {info.tokenSymbol} for a card. Each collection has one price: any of
            its cards costs the same. What a card costs stays in the shop for the next swaps. Tax the token&apos;s rules
            send here can be swapped into it with Refill. Gives are paid up to a room each week (the shop&apos;s seven days,
            counted from its creation); a card bought adds its give price back to that week&apos;s room. A card you get
            comes to your wallet by a plain transfer. The last card stays. The creator chose the collections and the pool,
            from those our factory accepts; a shop is only as good as that choice. Our test collections&apos; owner (our
            deploy wallet) can mint cards, and so draw on the budget up to the week&apos;s room. Cards in the shop:{' '}
            {count.shown.toString()}{count.more ? ` (the first of ${count.listed.toString()} listed)` : ''}. The room is{' '}
            {formatAmount(info.weeklyCap, info.tokenDecimals)} {info.tokenSymbol} a week{now.periodEnds > 0n ? `; the next week starts ${when(now.periodEnds)}` : ''}. Shop{' '}
            <AddressLink address={info.shop} />, token <AddressLink address={info.token} />, made by <AddressLink address={info.creator} />, pool router{' '}
            <AddressLink address={info.router} />, collections{' '}
            {info.collections.map((c, i) => (
              <span key={c.nft}>{i > 0 ? ', ' : ''}<AddressLink address={c.nft} /></span>
            ))}
            .
          </Help>
        </span>
      </header>
      <div className="stats">
        <Stat label="Budget" testId="shop-budget">{t(now.budget)}</Stat>
        <Stat label="Room for gives this week" testId="shop-cap">
          {/* The period's true room: the cap less its gives plus the give prices of its picks (it can be above the cap). */}
          {t(now.capLeft)}
        </Stat>
      </div>
      {maker !== 'launch' ? (
        <p className="muted small" data-testid="shop-maker" data-maker={maker}>
          Made by <AddressLink address={info.creator} />{maker === 'other' ? ', not by the token’s creator.' : '.'}
        </p>
      ) : null}
      {!info.tokenLive ? (
        <p className="muted" data-testid="shop-not-live">The token is not live yet: swaps open when it is.</p>
      ) : (
        <>
          {now.waiting > 0n ? <RefillBox info={info} waiting={now.waiting} /> : null}
          <PickBox info={info} now={now} />
          <GiveBox info={info} now={now} />
        </>
      )}
    </section>
  );
}

function PickBox({ info, now }: { info: ShopInfo; now: ShopNow }) {
  const { client } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const tx = useTx({ decimals: info.tokenDecimals, errors: 'shop' });
  const [chosen, setChosen] = useState<string | null>(null);
  const priceOf = (nft: Address) => info.collections.find((c) => c.nft.toLowerCase() === nft.toLowerCase())?.pickPrice ?? null;
  const picked = now.cards.find((c) => cardKey(c) === chosen) ?? null;
  const price = picked ? priceOf(picked.nft) : null;
  const lastStays = now.cardCount <= 1n;
  const tooFew = now.balance !== undefined && price !== null && now.balance < price;
  useEffect(() => { if (chosen && !picked) setChosen(null); }, [chosen, picked]);
  const pick = () => {
    if (!picked || price === null) return;
    void tx.run('Get this card', wallet, async (press) => {
      const card = picked; const maxPrice = price;
      // When it goes: the shop still holds the card, more than one card, and the price is still the one shown.
      const need: Need = async () => {
        const [held, count, prices] = await Promise.all([
          client.readContract({ address: info.shop, abi: shopAbi, functionName: 'holds', args: [card.nft, card.id] }),
          client.readContract({ address: info.shop, abi: shopAbi, functionName: 'cardCount' }),
          client.readContract({ address: info.shop, abi: shopAbi, functionName: 'pricesOf', args: [card.nft] }),
        ]);
        if (!held) return 'the shop no longer holds this card';
        if (count <= 1n) return 'the last card stays in the shop';
        return prices[1] > maxPrice ? 'the price moved above what you saw' : null;
      };
      const gone = await need();
      if (gone) throw new PageRefusal('state', gone);
      await withApproval(client, wallet, press, {
        token: info.token, spender: info.shop, amount: maxPrice,
        approveLabel: `Approve ${toDecimalString(maxPrice, info.tokenDecimals)} ${info.tokenSymbol} for the shop`, mainLabel: 'Get this card', need,
      });
      const { request } = await client.simulateContract({ account: press.account, address: info.shop, abi: shopAbi, functionName: 'pick', args: [card.nft, card.id, maxPrice, press.account] });
      return sendWrite(client, wallet, request, press, need);
    });
  };
  return (
    <div className="box" data-testid="pick-box">
      <h3>Swap {info.tokenSymbol} for a card</h3>
      {now.cardCount === 0n ? <p className="muted">No cards inside yet.</p> : lastStays ? <p className="muted">The last card stays.</p> : null}
      <ShopCards info={info} cards={now.cards} selection={{ chosen, disabled: lastStays || tx.busy, toggle: (key) => setChosen(chosen === key ? null : key) }} />
      {tooFew ? <p className="refusal" data-testid="pick-refusal">More than you hold.</p> : null}
      <div className="actions">
        {gate ?? (ready ? <button type="button" className="btn btn-primary" disabled={!picked || price === null || lastStays || tooFew || tx.busy} onClick={pick} data-testid="pick">Get this card</button> : null)}
      </div>
      <TxStatus step={tx.step} />
    </div>
  );
}

function GiveBox({ info, now }: { info: ShopInfo; now: ShopNow }) {
  const { client, config, bump } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const tx = useTx({ decimals: info.tokenDecimals, errors: 'shop' });
  // The wallet's own cards of the shop's collections, as tiles (lib/shop.ts ownCardsOf): select one, one press.
  const own = useChainRead((c) => (wallet.account ? ownCardsOf(c, config, info, wallet.account) : Promise.resolve(undefined)), [info.shop, wallet.account ?? ''], { keepOnChange: true, owner: wallet.account ?? '', forOtherOwner: () => undefined });
  const mine = own.state === 'ok' ? own.value ?? [] : [];
  const [chosen, setChosen] = useState<string | null>(null);
  const card = mine.find((c) => cardKey(c) === chosen) ?? null;
  const entry = card ? info.collections.find((c) => c.nft.toLowerCase() === card.nft.toLowerCase()) ?? null : null;
  useEffect(() => { if (chosen && !card) setChosen(null); }, [chosen, card]);
  const block = entry ? giveBlock(now, entry.givePrice) : null;
  const line = giveRefusal(block, now.periodEnds);
  const group = ownGroup(wallet.account, own.state === 'ok' ? { state: 'ok', count: (own.value ?? []).length } : own.state === 'error' ? { state: 'error' } : { state: 'loading' });
  const give = () => {
    if (!card || !entry) return;
    void tx.run(`Get ${info.tokenSymbol}`, wallet, async (press) => {
      const nft = entry.nft; const minPaid = entry.givePrice; const cardId = card.id;
      const need: Need = async () => {
        const [cardOwner, budget, capLeft] = await Promise.all([
          client.readContract({ address: nft, abi: cardsAbi, functionName: 'ownerOf', args: [cardId] }),
          client.readContract({ address: info.shop, abi: shopAbi, functionName: 'budget' }),
          client.readContract({ address: info.shop, abi: shopAbi, functionName: 'capLeft' }),
        ]);
        if (cardOwner.toLowerCase() !== press.account.toLowerCase()) return 'the card is not in your wallet';
        return giveBlock({ budget, capLeft }, minPaid) === null ? null : 'the shop cannot pay this card now';
      };
      const gone = await need();
      if (gone) throw new PageRefusal('state', gone);
      const approved = async () => {
        const [one, all] = await Promise.all([
          client.readContract({ address: nft, abi: cardsAbi, functionName: 'getApproved', args: [cardId] }),
          client.readContract({ address: nft, abi: cardsAbi, functionName: 'isApprovedForAll', args: [press.account, info.shop] }),
        ]);
        return all || one.toLowerCase() === info.shop.toLowerCase();
      };
      // One press: the shop may take this one card (when it may not yet), then the swap.
      if (!(await approved())) {
        press.steps([`Let the shop take #${cardId}`, `Get ${info.tokenSymbol}`]);
        const hash = await sendWrite(client, wallet, { address: nft, abi: cardsAbi, functionName: 'approve', args: [info.shop, cardId] }, press, need);
        await press.mined(hash);
        await waitForApproval(press, approved);
        press.alsoNeeds = async () => ((await approved()) ? null : 'the card’s approval changed');
      } else press.steps([`Get ${info.tokenSymbol}`]);
      const { request } = await client.simulateContract({ account: press.account, address: info.shop, abi: shopAbi, functionName: 'give', args: [nft, cardId, minPaid] });
      return sendWrite(client, wallet, request, press, need);
    });
  };
  if (info.collections.length === 0) return null;
  return (
    <div className="box" data-testid="give-box">
      <h3>Swap a card for {info.tokenSymbol}</h3>
      {group === 'failed' ? (
        <p className="refusal" data-testid="own-error">
          Could not read your cards.{' '}
          <button type="button" className="link-btn" onClick={bump}>Try again</button>
        </p>
      ) : null}
      {group === 'none' ? <p className="muted" data-testid="own-none">No cards of these collections in your wallet.</p> : null}
      {group === 'cards' ? (
        <ShopCards info={info} cards={mine} side="give" selection={{ chosen, disabled: tx.busy, toggle: (key) => setChosen(chosen === key ? null : key) }} />
      ) : null}
      {line ? <p className="refusal" data-testid="give-refusal">{line}</p> : null}
      <div className="actions">
        {/* No press without a card to give: a wallet with none reads the line above instead of a dead button. */}
        {gate ?? (ready && group === 'cards' ? <button type="button" className="btn btn-primary" disabled={!card || block !== null || tx.busy} onClick={give} data-testid="give">Get {info.tokenSymbol}</button> : null)}
      </div>
      <TxStatus step={tx.step} />
    </div>
  );
}

function RefillBox({ info, waiting }: { info: ShopInfo; waiting: bigint }) {
  const { client } = useApp();
  const wallet = useWallet();
  const { ready, gate } = useWriteGate();
  const tx = useTx({ decimals: info.tokenDecimals, errors: 'shop' });
  const refill = () =>
    void tx.run('Refill', wallet, async (press) => {
      // All that waits now (the amount read at the press; at most what waits when it goes).
      const amount = await client.readContract({ address: info.shop, abi: shopAbi, functionName: 'waiting' });
      if (amount === 0n) throw new PageRefusal('state', 'nothing is waiting');
      const need: Need = async () => ((await client.readContract({ address: info.shop, abi: shopAbi, functionName: 'waiting' })) >= amount ? null : 'what waits changed');
      const { request } = await client.simulateContract({ account: press.account, address: info.shop, abi: shopAbi, functionName: 'refill', args: [amount] });
      return sendWrite(client, wallet, request, press, need);
    });
  return (
    <div className="shop-refill" data-testid="refill-box">
      {/* One line: what waits, its press (with a wallet), its (?). */}
      <div className="shop-refill-line">
        <span data-testid="shop-waiting">
          Waiting to be swapped <Amount value={waiting} decimals={info.assetDecimals} symbol={info.assetSymbol} />
        </span>
        {ready && !gate ? <button type="button" className="btn" disabled={tx.busy} onClick={refill} data-testid="refill">Refill</button> : null}
        <Help label="About Refill">Swaps what waits into {info.tokenSymbol} on the token&apos;s pool, for the shop&apos;s budget. Anyone may press it. It takes any amount of {info.tokenSymbol} back: no protection against a bad price. Without a pool the press fails and what waits stays.</Help>
      </div>
      <TxStatus step={tx.step} />
    </div>
  );
}
