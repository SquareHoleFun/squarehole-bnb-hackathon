# The hard decisions

What creators find hard to decide, the trade-offs in plain words and what to recommend. Recommendations are
proposals (P) until the founder confirms them; the launch flow's defaults are ETH, 30 days, burn the token on both
sides, no fee cap, royalties off, opens Now (the block after Create), no creator buy, open art, and no contents picked (just the token or
a collection: box creation flow § 2). Every box raises the same 4.206980085 ETH: nothing to choose. The numbers in
the table below are computed from the spec; `node scripts/check.mjs --menu` (from the skill's folder) lists today's
choices and `--numbers` works out any preset (see SKILL.md). The persona tests behind the newer entries are in
`docs/research/listing-friction-v0.md` in the repository.

## 0. How the creator is paid, and what a buyer gets

Explain this before the kind of box whenever the creator says "sell", "earn", "get paid" or "holders get something".

- **The raise is never paid out.** When the curve is full the box graduates at once and the raise becomes the box's
  own pool. Nobody buys "the collection" from the creator, and there is no sale price.
- **"To you" on a fee side:** that side's 10/15 of the 1% fee. Buyers' fees: about 0.0067 ETH per 1 ETH bought (in
  ETH, or converted into the token); sellers' fees: 10/15 of 1% of the tokens sold (in the token, or sold for ETH).
  Each side is chosen on its own, so "to you" can be one side or both, and a fee cap can limit it (§ 3). Fees from
  the curve are held until graduation and go into the refund range if the box fails; after graduation they are
  credited in batches and the payout address collects them. Selling the tokens it receives is visible on chain, and
  buyers read it as sell pressure. The checker's "How the creator is paid" note follows the sides actually chosen.
- **Burn sides pay the creator nothing** from fees; holders gain only through a shrinking supply.
- **Other money:** royalties if marketplaces honour them (§ 4), the tokens their own ETH at start buys (§ 8), and, if
  an open-art box fails, the items go back to the creator.
- **Legal:** fees and royalties to a creator are still being reviewed by Square Hole's lawyers and may have tax or
  legal consequences where the creator lives. Say so once, without alarm.
- **What a buyer gets:** the token. At launch one item is 1/n of all tokens (250 items: 4,000,000 tokens each); as
  burns shrink the supply an item takes fewer, since it costs the tokens in circulation divided by the items still
  in the box (as in the Misfits' vault). After graduation anyone holding that much can **return** an item for the
  tokens (5% off) and take one out. With **hidden art**: **draw** a random item still in the box (1% draw fee) or
  **pick** a returned item by name (25% more); an item that never left cannot be chosen. With **open art** there is
  no draw (nothing is hidden): any item still in the box can be **picked** by its number (25% more).
  Open art: nothing leaves the box before graduation. Hidden art: tickets during the curve (§ 2). Just the token:
  the token alone, no items.
- **What the creator needs:** a wallet with ETH for the creation (0.0015 ETH bootstrap plus gas, about 4-5 million
  gas: roughly 0.005 ETH at 1 gwei, the Overview page shows it) plus any ETH at start. Their buyers need a wallet and
  ETH before the open too: for an audience new to crypto, allow time (§ 6) and tell them early.

## 1. What is inside: just the token or a collection

- **Just the token** (a plain token): the fastest launch, no NFTs and no vault, no art beyond a logo; the logo is the
  token's picture ([examples/gm-coin.json](examples/gm-coin.json)). No royalties, collection page or collection owner.
- **A new collection:** the NFTs sit in the box's vault and back the token. Work: 10 to 10,000 pictures (see
  "Prepare the files"), a logo, a collection cover (a separate picture), optional traits.
- **Existing NFTs, acquisitions, baskets**: later.
- **No art yet:** draft with the planned count and `"metadataTable": "FROM_LAUNCH_FLOW"`; the launch flow counts n
  from the files, so check the draft again once the art exists. For a first community box 10 to 30 items are plenty (P).
- **Recommend:** a collection when the creator has art (that is what makes a box more than a ticker); just the token
  for a community or meme coin without art.

## 2. Open or hidden art

| | Open art | Hidden until drawn |
|---|---|---|
| Buyers see | every item from the start | a ticket; each item shows when it is drawn |
| Taking an item out (after graduation) | any item still in the box, picked by its number (25% more); no draw | a random draw (1% fee), or a returned item by name (25% more) |
| Creator must | upload the art | upload the art **and keep the reveal file safe** (and a copy): items reveal only with it |
| Hype | low: what you see is what you get | a reveal moment; a banner and teasers on the collection page help |
| Open questions | none | who posts reveals for other people's boxes; unopened tickets if a deadline box fails |

- **How the reveal works** (as designed for the Misfits, whose ticket add-on other boxes share; details for other
  boxes are still being designed): during the curve buyers swap one item's worth of tokens (1/n of all tokens at
  launch) for a ticket. At graduation one random number gives every ticket its item, and those items can be opened;
  after that each draw gets its own random number and reveals one item. There is no timed "reveal night" beyond
  graduation. The reveal file holds the secret that proves each item; nobody else has a copy.
- **Public from creation, also with hidden art:** the trait table (every trait name and value) and special series'
  names and counts. Only which item has which traits stays hidden, so use plain names for values that should surprise.
- **The launch flow sets the ticket** name ("<Name> ticket"), symbol ("<TICKER>-T") and a neutral hidden picture; the
  creator can change only the ticket text and the hidden-item text. Drafts write `"params": "FROM_LAUNCH_FLOW"`.
- **Banner and teasers** (the collection page, any new collection): a banner and up to 4 teasers, each labelled
  "Teaser" and never an item (with hidden art, not one of the item pictures), set at creation only. Its link starts
  as the Website link from Basics. In a draft: the collection-metadata add-on, `"FROM_LAUNCH_FLOW"` per picture.
- **Recommend:** open art for a first box or a creator new to this; hidden art for a PFP drop whose community wants
  a reveal, and only if they understand the reveal file and the one-by-one reveals.

## 3. The kind of box: what each fee side does

Every trade pays a 1% fee. 3/15 always goes to FIT buy-and-burn and 2/15 into the box's own pool. The creator
picks what happens to the other **10/15**, separately for buyers' fees (paid in ETH) and sellers' fees (paid in the
box's token):

- **To the creator:** see § 0, on one side or both.
- **Burn:** buyers' fees buy the token back and burn it, or join FIT's burn ("Burn FIT"); sellers' fees burn the
  token, or "Burn FIT" there too: the tokens are first sold for ETH after graduation, which shows buyers the sell
  warning (see "As collected vs converted"). Less supply for holders; nothing for the creator. "Burn the token" vs
  "Burn FIT": the first helps this box's holders, the second the platform token; take the first when the creator
  does not mind, and on the sellers' side certainly (no selling).
- **To holders:** Demo only for now, marked "pending legal review" (`--network demo` checks a Demo draft). Not on
  testnet until holder payouts are built, and not on mainnet before the legal review; a draft for a real box picks
  another kind.
- **As collected vs converted:** by default each side pays in what it collects (ETH stays ETH, tokens stay tokens).
  Converting into the token is a small limited buy; converting into ETH (selling the token) is a small limited
  **sell** after graduation: steady sell pressure, and buyers see a warning. Recommend "as collected" unless the
  creator really needs one currency.
- **"Can the fees go to my members / holders?"** In the Demo, yes, marked "pending legal review"; for a real box not
  yet. Today: burn on both sides, which helps every holder by shrinking the supply; note the wish in `brief`. Do not
  suggest "fees to you, then airdrop the holders": holders would depend on a promise nobody can check, and it is
  income to the creator all the same.
- **"Deflationary, but fund the project":** buyers' fees to the creator in ETH, sellers' fees burned (each side on
  its own).
- **Fee cap** (only with a side to the creator): at most 1, 4, 8, 16 or 32 ETH per 30 days goes to
  the creator; the rest is burned or goes into the box's pool. A fixed amount, not a share of the raise; 32 ETH is
  what the platform caps itself at on the Misfits. It shows buyers the creator cannot take unlimited fees.
- **Recommend:** burn for community and meme boxes (the default); to the creator when the creator's work is the
  product (art, a project) and they want to be paid for it; buyers' fees to them and sells burned when they want
  both; a fee cap when buyers may worry about how much the creator takes.

## 4. Royalties

- Unenforced (ERC-2981): many marketplaces pay none, so **expect little**. Presets only: off, 1, 2.5 or 5%.
- Where they go: **with the fees** (split like buyers' fees: in a box whose fees go to the creator 10/15 reach the
  creator, in a burn box they are burned; passed on from graduation), **to the creator** (the box collects them and
  credits the fee payout address after graduation; one payout wallet), or **into the pool** (deeper liquidity).
- **Recommend:** off, or 2.5% with the fees; 2.5% to the creator when the creator wants direct income (the artist row
  below). "Normal" on marketplaces is 0 to 5%; 2.5% is a common middle.

## 5. The raise: one size for every box

Every box raises 4.206980085 ETH, the amount the Misfits raise: nothing to choose, so say it as a fact. It is the ETH
the curve must collect before the deadline, and the curve, the start price and the price at graduation are the same
for every box. If it is not reached, the box fails and every token sells back for the same amount of ETH from the
refund range (what the curve collected, plus the launch tax and held fees; within 0.6%, by any route, no expiry:
launch pipeline § 3.7). That is the same amount per token, not what each buyer paid: late buyers, who paid more, get
back less.

<!-- generated:curve (build-references.mjs: do not edit by hand) -->
| Raise | Market cap (all tokens) at the first buy | at graduation | Creator's ETH at start buys: 0.01 | 0.02 | 0.03 | 0.05 | 0.1 | 0.25 | 0.5 ETH |
|---|---|---|---|---|---|---|---|---|---|
| 4.206980085 ETH | 1.3748 ETH | 20.2095 ETH | 0.7% | 1.4% | 2.1% | 3.4% | 6.7% | 15.4% | 26.9% |

At launch one item is 1/n of all tokens, so it is worth the market cap divided by n (ETH at the first buy / at graduation; burns lower the tokens an item takes later): 4.206980085 ETH: 10 items 0.1375 / 2.0209, 250 items 0.0055 / 0.0808, 1,000 items 0.0014 / 0.0202.
In dollars: today's ETH price times these, labelled as a conversion (`scripts/check.mjs --numbers --eth-usd <price>`).

Native ETH; the layout library (`boxCurve`, `curveBuyOut`), bigint, 1,000,000,000 tokens, rounded. Estimates for display: the factory's own swap is the truth.
<!-- /generated:curve -->

- **Ask** (for the deadline, not the raise): how many people will buy in the first days, and roughly how much each?
  4.206980085 ETH is about 84 buyers at 0.05 ETH, or 42 at 0.1 ETH.
- **Dollars:** creators often answer in dollars. Ask them to read today's ETH price from their wallet or an exchange,
  then convert and label it ("at $2,500 per ETH, $2,000 is about 0.8 ETH"; `--numbers --eth-usd 2500 --usd 2000`).
  A conversion, never a prediction. Launchers think in market cap: use the table's words.
- **A small community** (e.g. 30 people at 0.01-0.05 ETH): say plainly that they alone will not fill 4.206980085 ETH.
  There is no smaller raise. Options: 90 or 180 days and buyers from outside the community, or grow the audience first
  and launch later. In a failed box every token sells back from the refund range, and the creator's held fees go into
  it.

## 6. The deadline

- 30, 60, 90 or 180 days after the open. If the raise is not reached by then, the box fails: buying stops and every
  token sells back for the same amount from the refund range (§ 5), not necessarily what its buyer paid.
- Shorter keeps momentum and gives buyers their answer sooner; longer gives a slow community time but keeps money
  waiting and attention fades.
- **Recommend:** 30 days when an existing crypto community can fill 4.206980085 ETH quickly; 60 to 90 days when the
  estimate is below the raise or the buyers still need wallets and ETH; 180 only for a deliberately slow project.

## 7. When it opens

- Now (the default), 5 minutes, 1 hour or 24 hours after Create, or "Pick a time": an exact UTC time, at most 14 days
  ahead. The presets become a UTC time when Create is pressed. A draft holds 0 (Now) or a UTC time
  (`"openAt": "2026-10-20T18:00:00Z"`, spec-json.md); for "5 minutes after Create" write 0 and pick the preset in the
  launch flow.
- Now opens in the block after the creation block, never in it, so the creator's own buy (§ 8) still goes in first.
  Nobody can be told the contract address before it trades; a few minutes (5 min) let the creator post it first.
- A picked time opens in the first block at or after it: Ethereum makes a block every 12 seconds, so the open can be
  up to 12 seconds after the time (on mainnet a time on a whole minute opens 11 seconds after it). If Create lands at
  or after the time, the box opens in the block after Create, so pick a time a few minutes ahead (confirming in the
  wallet and waiting for a block take time). The checker warns when a draft's time has passed or is more than 14 days
  ahead (the factory refuses that).
- The first 6.4 minutes after the open (32 steps of 12 seconds) carry a falling launch tax (93.2% down to 8.1%) that
  stays in the box. Buying in the first minutes is expensive: tell the community, the opposite of "ape the open".
- **Recommend:** Now for a quick launch (the launch tax is the community's head start); 5 minutes or 1 hour to post
  the contract address first; a picked UTC time when the creator wants to announce it (an event, a stream).

## 8. The creator's ETH at start

- An optional buy inside the creation, before anyone else and without the launch tax, shown on the box page. It must
  stay below the raise, and the tokens go to the wallet that creates the box.
- At the start of the curve tokens are cheap, so **small amounts buy large shares** (see the table above;
  `--numbers --buy 0.02` for any amount, `--share 5` for the ETH a share takes). Buyers read a big creator share as a
  dump risk, and fairness-minded communities may prefer none.
- **A team reserve** (e.g. owls for giveaways) is this buy, shown publicly; there is no allowlist or presale.
- **Recommend:** none, or a share of at most about 5% (P). Always show the share before they decide.

## 9. Addresses and what is fixed forever

- In the launch flow one public address is the collection owner and the fee payout address (royalties to the
  creator are credited there too): the wallet connected at launch, unless another address is pasted under Your
  address on the Overview page. `"FROM_LAUNCH_FLOW"` in a draft means that address; ask which one it will be. Just the
  token has no collection owner (zero). A team pastes its Safe (creating from the Safe itself is foreseen by the
  factory design but not tested in the launch flow). Never ask for, or accept, a private key or seed phrase.
- One payout wallet per box; splits between people need a Safe. Only the payout address itself can hand it over to
  another address, which must accept it; nobody else can change it.
- Name, ticker, logo, collection cover, description and every setting are fixed forever once created. Check spelling.

## Prepare the files

- Pictures: PNG, JPEG or WebP (no TIFF, GIF or SVG), each up to 1 MiB and 16 to 4,096 pixels a side, stored as
  uploaded. Large scans: export JPEG or WebP at about 1,000 to 1,500 pixels a side, which usually fits.
- Names: the item number, `1.png` to `n.png` (`0007.png` counts as 7), no 0 and no gaps. Generator output that starts
  at 0 must be renumbered. The file number is the item number.
- Traits (optional): one CSV with a first column `id` and one column per trait, e.g.
  `id,Coat,Pose` / `1,Bay,Galloping` / `2,Grey,Standing`; or JSON; or a folder of `<id>.json` metadata files (only
  `attributes` is read, as generators write them). Plain ASCII, at most 16 trait types with up to 255 values each.
- Special series: give those items a trait (e.g. `Edition: Golden`); the spec stores only the series' name and count.
- Logo: square, PNG, JPEG or WebP, 256 to 4,096 pixels a side, up to 10 MiB; the launch flow shrinks it.
- Collection cover (a new collection): its own picture, uploaded separately from the logo (marketplaces show it).

## Starting points per goal (P)

Every row raises the same 4.206980085 ETH.

| Goal | Contents | Fees (buyers / sellers) | Royalties | Deadline | Opens | Creator buy |
|---|---|---|---|---|---|---|
| First box, unsure | collection, open | burn / burn | off | 60 days | Now | none |
| Artist who wants to be paid | collection, open | creator / creator | 2.5% to you | 60 days (90 if buyers are new to crypto) | 24 h | none or tiny |
| Community or meme token | just the token (gm-coin) | burn / burn | none (no NFTs) | 30 days | Now | none |
| Holders should get something | as the goal above | burn / burn (holder payouts: Demo only) | off or into the pool | 30 days | 1 h | none |
| PFP drop with a reveal | collection, hidden, banner and teasers | burn / burn, or creator (ETH) / burn | 2.5% with the fees | 60 days | 24 h | none |
| Established project | collection, open or hidden | creator or burn on each side, a fee cap | 2.5% | 30 days | picked time | small (at most 5%) |

- Artist: § 0 first; they usually expect the sale price. PFP: the most likely ask is "deflationary but fund the
  project" (§ 3: buyers' fees to the creator, sells burned), plus a banner and teasers; an allowlist is not offered.
  Meme launchers: say "Demo and testnet only" first, then the launch tax and the deadline (pump.fun has neither).

## Where people get stuck (from building the examples and four persona tests)

- **How the creator is paid:** they expect the raise or a sale price; it becomes the pool (§ 0). The biggest surprise.
- **What a buyer gets:** how tokens turn into items, and that with hidden art a new item cannot be picked (§ 0).
- **Dollars:** ETH only; no dollar price; conversions at the creator's price only (§ 5).
- **Small communities:** the one raise, 4.206980085 ETH, for every box, no smaller size; a longer deadline helps (§ 5).
- **Jargon:** "Q" and "T", decision ids and field names mean nothing to most people. Say "ETH" and "the token (GUZZ)".
- **Text rules:** emoji, accents, curly quotes and long dashes are refused; tickers have at most 11 characters and no
  leading `$`. `--field` lists every bad character at once with a suggested text.
- **Creator buy shares:** 0.1 ETH is about 6.7% of all tokens and 0.25 ETH about 15%, a surprise for almost everyone.
- **Fee sides:** each is chosen on its own (to the creator, as collected or converted, or burn); converting into ETH
  sells the token, and buyers see a warning.
- **One raise:** the same 4.206980085 ETH for every box; only ETH as the pricing asset today.
- **Two pictures:** the logo (the token and the box card) and, for a collection, a separate collection cover.
- **Art files:** names must be the item numbers; 10 to 10,000 items; each picture up to 1 MiB; no TIFF.
- **Hidden art:** the reveal file is easy to lose; reveals come one by one, not on one night; trait names are public.
- **Addresses:** `FROM_LAUNCH_FLOW` is the wallet connected at launch unless another is pasted; one address for all.
- **Royalties:** creators expect income that marketplaces mostly do not pay.
- **Links:** not part of the spec; the creator enters them in the launch flow's Basics (Website, X, Telegram), https
  only (X also as an @handle). For a collection the Website link also fills the collection page's link: write it in
  the collection-metadata add-on, or have the creator clear it there.
- **Valid but not enterable:** the launch flow always writes a zero generator hash, leaves royalties at 0% and an
  empty collection page out, takes at most 4 special series and uses one address; the checker says "The launch flow
  cannot enter this yet" for anything else.
- **Refunds:** "everyone gets their money back" is wrong: every token sells back for the same amount (§ 5).
- **Fingerprints:** the logo's, the collection cover's and the art's hashes come from the launch flow (it re-encodes
  the pictures); an assistant cannot compute them from the original files.
- **Units:** "1" in a raw amount field is 1 wei, not 1 ETH; the checker warns about such dust.
- **Opening at an event:** a draft holds the exact UTC time (`"openAt": "2026-10-20T18:00:00Z"`, § 7).
- **Gaps:** of the nine example boxes, three are fully expressible today, four need a stand-in and two must wait
  (holder payouts beyond the Demo, other pricing assets). Those two are the most asked-for features.
