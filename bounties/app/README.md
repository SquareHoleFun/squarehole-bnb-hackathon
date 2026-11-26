# The launch page of the two bounty entries

A small web app (Vite, React, TypeScript and viem, with no wallet kit) for the two entries in `../flap` and
`../openfour`. With it you create and follow a launch, trade, watch the pile grow and hand tokens in. It is served
as part of the platform's own site under `/launches/`, with the platform's top bar, and the platform's Create links to
it ("Launch on": Flap, Four.meme). It uses the browser's injected wallet only for writes. Everything else it reads
from the chain's public endpoints, so it shows all it can read without a wallet.

## Run it

Node 24, from this folder:

```bash
npm ci
node scripts/make-addresses.mjs     # public/addresses.json FROM ../flap/deployments/97*.json (and ../openfour's, once it exists)
npm run dev                         # http://127.0.0.1:5471
PILE_BASE=/launches/ npm run build  # dist/: the folder the site serves at /launches/
```

### On the site (what the web server does)

- **Serve** `bounties/app/dist/` as static files at `/launches/`. `dist/addresses.json` comes from
  `public/addresses.json` (committed; written by `scripts/make-addresses.mjs`, checked by a unit test).
- **No rewrite rule.** The page's own routes are hash routes (`/launches/#/flap/create`, `/launches/#/flap/<launcher>`,
  `/launches/#/four`, `/launches/#/four/<token>`, `/launches/#/pile/<address>`). The server only ever sees
  `/launches/`, `/launches/index.html`, `/launches/addresses.json`, `/launches/assets/*`. `/launches` without the slash
  should answer with a redirect to `/launches/` (as a web server does for a folder). The site's single-page fallback
  must not take `/launches/` before the static files. (`/launch` without the "es" is a route of the platform, a redirect to Create:
  it stays the platform's.)
- **No inline script and no inline style** in the built `index.html`. Every asset (logo, fonts) is its own file; none
  is inlined as `data:`.
- **Hosts the page contacts:** its own origin (scripts, styles, fonts, the logo, `addresses.json`) and the read
  endpoints in `addresses.json`: `https://bsc-testnet-rpc.publicnode.com`, then `https://bsc-testnet-dataseed.bnbchain.org`.
  A policy that fits: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
  connect-src 'self' https://bsc-testnet-rpc.publicnode.com https://bsc-testnet-dataseed.bnbchain.org`.
  BscScan and PancakeSwap appear only as links; the wallet extension is not a network origin.
- **The top bar's links** go to the site's own pages (`/`, `/create`, `/my-box`, `/settings`, `/about/risks`).

### Reads and writes

- **Refused reads.** The page tries each endpoint once. If all fail, it tries the list once more.
  A rate limit pauses background reads for 1 s, then 2 s, then 4 s, up to 8 s. Each request waits for a pause
  only once and times out after 18 s, including the pause. No read waits for a pause while a press runs.
- **Polling.** The page reads again every 30 seconds and at once after a press. While reads fail, the wait doubles, up to 64 seconds.
- **Old numbers.** While reads fail, the last good numbers stay on screen, and the top bar shows how old they are.
- **Events.** BNB Chain's own endpoint keeps the full event history. The page asks it for up to 5,000 blocks per request and sends the requests together.
  If a read fails, the page uses its first endpoint. Since 26 November 2026, that endpoint returns only recent events.
  The lists still name the launches made so far in `addresses.json`.
- **Writes** go through the visitor's wallet. The page reads the network's gas price just before it asks the wallet.
  If the price is unusable or above 5 gwei, nothing is sent. The page sets both fee fields. For the tip, it takes
  the larger of the endpoint's suggested tip and the gas price, adds a tenth, and caps the result at 5 gwei.
  The fee cap is twice the latest base fee plus the tip. The page never sends a legacy gas price. The gas limit depends on the call.
  - the node's estimate plus half, plus 100,000;
  - a fixed 8,000,000 for an OpenFour tax token, whose estimates come out short.

## How it finds the contracts

At load the page reads `addresses.json` beside `index.html`, from its own origin, following no redirect. The file
is validated as a whole before anything is read from the chain:
- chain 97 only;
- every address is exactly an address: all lower case, or mixed case with a correct checksum;
- every endpoint is a parsed https URL;
- `fromBlock` is a decimal string;
- unknown fields are refused, at every level.

The read endpoints that answer must answer chain 97, and only those read for the page. On any failure the page shows the reason and nothing else: no reads, no
writes. One build serves any deployment; replace that one file.

The production bundle takes no file name from the page's address. Only the development server (the browser tests)
also reads `?addresses=<name>.json`: a plain relative name inside the same folder (`import.meta.env.DEV`, which is
false in a build). Plain-http endpoints are likewise accepted there only, for a local chain.

```json
{
  "chainId": 97,
  "rpcUrls": ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet-dataseed.bnbchain.org"],
  "explorer": "https://testnet.bscscan.com",
  "fromBlock": "<first block to read events from, e.g. the factories' deploy block>",
  "flap": {
    "portal": "0x…", "tokenImpl": "0x…", "pileVaultFactory": "0x…", "curveLauncherFactory": "0x…",
    "sales": [{ "launcher": "0x…" }],
    "tokenQuote": {
      "quote": "0x…", "label": "USDT (test)", "launcherFactory": "0x…", "pileVaultFactory": "0x…",
      "sales": [{ "launcher": "0x…" }]
    }
  },
  "openfour": {
    "core": "0x…", "tools": "0x…", "wbnb": "0x…", "presetId": "…", "taxPresetId": "…", "taxTemplate": "0x…", "quotes": ["0x…"],
    "tokens": [{ "token": "0x…", "kind": "preset", "pile": "0x…" }, { "token": "0x…", "kind": "tax", "taxVaultClone": "0x…" }]
  },
  "piles": [{ "pile": "0x…", "rail": "core" }]
}
```

- `flap` takes the fields of `../flap/deployments/97.json` as they are.
- `flap.sales[0].launcher` is `../flap/deployments/97-sale.json`'s `launcher`. The home page also lists every sale
  from the factory's `CurveLauncherCreated` events, starting at `fromBlock`.
- `flap.tokenQuote` takes `../flap/deployments/97-usdt.json` (`quote`, `tokenCurveLauncherFactory`,
  `tokenPileVaultFactory`) and its first sale from `97-usdt-sale.json`, once those exist. `label` is the name the page
  shows for the quote coin (its on-chain symbol is "USD"). The home page also lists the factory's
  `TokenCurveLauncherCreated` sales. `fromBlock` is the earlier of the two deploy blocks.
- `openfour` takes `core`, `tools` and `wbnb` from the copy's `fork-deployment.json` (`addresses`). It also takes
  our preset's id (`preset-registration.json`), Bonding Tax V1's id (`presets.bondingTaxV1`), the tax template
  (`tax-template.json`) and the quote coins the signer allows. Each token comes from `launch-preset.json` or
  `launch-tax.json` (`token`, `kind`, `pile`, `taxVaultClone`). The home page also lists the tokens Core created with
  the two presets.
  - For a tax token the page reads the pile from its tax vault, and shows "No pile yet." until `createPile()` has
    run.
  - Without `pile`, a preset token's pile is read from its Trade module.
  - `openfour.router` overrides the PancakeSwap V2 router used after migration.
- `flap.router` and `flap.wbnb` override the PancakeSwap V2 router and wrapped BNB used after a launch. The defaults
  are the ones the entry's scripts use.

## What the page sends, and to whom

- **Anything can be read; writes are allowed only for the deployment's own contracts.**
  - **A Flap sale** needs buttons that send only when the deployment file names it, or one of the deployment's two
    factories emitted its creation event. The native factory's sales are written to in the native coin. The
    token-quote factory's sales are written to only in the deployment's test token, with that launcher's own ABI,
    and only on that factory's creation event (the file's list of them is for finding them). Create checks the
    token-quote factory's own `quote()` against the file's coin before it offers Create.
  - **A pile** can be written to only if the file names it, or it was taken from such a sale or from one of our
    OpenFour tokens. Its own `token()` must be that token.
  - **An OpenFour token** counts as ours when Core says it exists and was made with one of the two preset ids. Its
    pile must name it. A tax token's vault must be a clone of our template, reached from the token's own founder.
    A file with a tax preset and no template is refused. The clone must be set up for this token and its quote
    coin (`taxVaultToken()`, `taxVaultQuote()`), with or without a pile yet.
  - **A standalone pile** that the file pairs with a token is writable only while its own `token()` is that token.
  - A hostile address in the page's address therefore gets a read-only screen.
- **Spenders come from the deployment, never from the page's address.** They are the pile, OpenFour's Core, the
  pool router, and for a token-quote sale its launcher.
- **One press is a list of steps, in a dialog.** A write button opens a native modal dialog (the rest of the page is
  inert): its title is the steps in order (for example "1 Approve 300 USDT (test) for this sale · 2 Buy"; "Checking
  allowance" until that is known), each with its own line and link. Each step ends in one of three outcomes:
  confirmed (a successful receipt, with its event where the step needs one), not sent (refused before the wallet, or
  rejected by the wallet), or unknown (the wallet was asked and no hash came back). A read that fails after a
  confirmed receipt keeps the step confirmed and says what could not be read. Cancel (and Escape) only until the
  press's first wallet request. Every ending has one last line and Close; "Nothing was sent" only when no step
  reached the wallet. Only the account that pressed sees the outcome. A second press is impossible while one is open.
- **Every approval goes through one function,** removals too (amount zero). At the press the pressing account's
  allowance is read; when it is not exactly the amount, the press gets the step "Approve <amount>" (exactly that; zero
  and the largest number refused for a grant). After its receipt the allowance is read at that block; only then the
  call, which needs the allowance exactly as approved.
- **The checks at the last moment.** Every step has a required predicate: the chain state it needs (the sale still
  selling, launched or in its refund phase; the token on its curve or on PancakeSwap; the pile still naming its token;
  no pile yet for "Create the pile"; the fee unchanged for a creation) and, for a trade, its quote still at least the
  minimum. It runs inside the provider call that hands the transaction over, after the library's own wallet
  requests, immediately before it is forwarded, between two checks of the wallet's change counter and the page's
  navigation counter (hash changes and leaving the page). A step whose state is gone is not sent and its line says
  why. The transaction carries `from` and chain id `0x61`; raw, batched and signing-only sends are refused.
- **A way out of every wait.** While any step waits on the wallet, "Stop waiting" ends the press: that step's outcome
  is unknown ("Your wallet did not answer for step N. It may still send it: check your wallet's activity before
  pressing again."). A sent step waits for its receipt without a time limit; after 180 s "Still not confirmed",
  "Check again" (reads the receipt now) and "Leave it pending" (the dialog closes; the box keeps every step and hash
  with "Step N is still pending: check it on the explorer before pressing again."). A press that was ended never
  updates the page again: a late answer of its wallet changes no newer press and never navigates.
- **"Create the pile"** is sent only while the vault has no pile, and confirmed only by this transaction's
  `PileCreated` event.
- **Allowances left.** On every verified sale and token page, in every phase, the connected account's allowance to
  that sale's launcher, the pool router, OpenFour's Core or the pile shows when it is not zero, with "Remove
  approval" for exactly that pair.
- **At every press** the quote is read again, the minimum computed with the guard on screen; a zero minimum is
  refused, and so is one worse than shown.
- **No wallet request on load or navigation,** not even `eth_accounts`: the page starts disconnected and asks at
  Connect.
- **Launch** sends the launcher's own `complete()`, which launches or reverts. Native: exactly the cost read at the
  press. Token quote: approve exactly that cost; after the approval the cost is read again and that is sent, never
  above the approval, never zero. A cost above the one on screen is shown and needs a new press. "Confirmed" only on
  the `Launched` event.
- **Account-owned numbers** (balances, owed, claimable, allowances) are never shown for another account, and a mint
  or claim result only to the account that pressed. Wrap is refused when the amount computed at the press is more
  than the button showed ("Your balance changed. Press again.").
- **Event reads** (the sales on Home, the creation proof that writes need, OpenFour's launches, a pile's history)
  all go through one helper (`src/lib/logs.ts`): from the deployment's first block to the head in windows of at most
  40,000 blocks (PublicNode refuses more than 50,000), each window tried once per endpoint; a refused window is halved
  down to 5,000 blocks. What was read is kept for the visit, so later polls read only the new blocks. A read that
  every endpoint refuses shows its error line with "Try again", never "Reading…" for good.
- **Reads** go only to the file's endpoints that answered chain 97 at start, in the file's order; one that did not
  answer is asked again at the next load. Redirects are refused and CCIP Read is off, so no read reaches another host.
- **The Four.meme create form** decodes the signed `createArgs` and rebuilds them from the form, the deployment's
  preset, the preset's module schemas read from OpenFour's Tools, and (for a tax launch) our template. Any difference
  is refused before the simulation, and so is a validity outside the chain's next 10 minutes (plus 5 for clocks). A
  signer refusal shows the page's own text for its code. Only 18-decimal coins are offered, as the signer encodes 18.
- **"Take your money back"** shows the selected call (`unwind`, or `unwindTo` the address entered) simulated now, as
  an estimate, then what the `Unwound` event says was paid. "Nothing to take back." only when the sale says nothing
  is owed.
- **"Get 2,000 USDT (test)"** mints the deployment's test token to the connected wallet through the token's own public
  `mint(address,uint256)`. It shows the pressing account's balance read at the press and at the receipt's block, to
  the last unit.
- **Create** sends exactly the fee on screen; if the Portal's fee changed, it shows the new one and asks for a new
  press.
- **On the OpenFour rail,** a curve sell of a WBNB launch is labelled in BNB (Core pays native BNB), and the tax not
  paid out yet is the token's own counters (`feeAccumulated` in the quote coin, `tokenAccumulated` in tokens).
- **The Flap pool's minimum** counts the token's tax as set at creation; the review says so, as the tax may have
  ended (Flap's token gives no view of when it ends).

## Screens

- `#/` is home: the two rails and their launches.
- `#/flap/create` creates a curve sale through the Launcher Factory. "Paid in" chooses the test token (the default,
  when the file has `tokenQuote`) or BNB; each has the entry's own defaults (1,700 USDT (test) and a virtual 11,600, or
  the native script's). A target below the Portal's floor is refused in the form, with the numbers in that coin. With
  the test token, "Get 2,000 USDT (test)" sits on this screen and on the sale's.
- `#/flap/<launcher>` is one sale. It changes with the sale's phase:
  - while selling: progress on the curve, buy, sell back, time left, and "Launch" (the buy of the rest);
  - after a missed deadline: "Take your money back";
  - after the launch: claim, the pile panel, trades on the pool, and the tax waiting with "Send to the pile".
- `#/four/<token>` is one OpenFour token:
  - progress on the curve;
  - buy and sell on the curve through `Core.buyByBudget` and `Core.sell`, with `Tools.estimate…` quotes; when the
    quote coin is WBNB, the buy offers to wrap the BNB that is missing;
  - after migration, trades on the PancakeSwap V2 pool;
  - the pile panel;
  - for a tax token, the tax held by the token and "Settle into the pile" (a zero self-transfer, as the entry's
    `pile.js settle` does). A redemption does not need it.
  - for a tax token without a pile yet: "Create the pile" (`createPile()`, which anyone may call).
- `#/four/create` creates an OpenFour token (see below).
- `#/pile/<address>` is the pile panel for any `IFeeRules` pile.

## Tests

```bash
npm test             # amounts, quotes, minimum-out, every form refusal, the token address preview, the curve,
                     # the addresses file, error decoding, the pile ABI against both entries' exports
scripts/e2e-local.sh # Playwright, one worker, port 5471: the pile panel on a local anvil chain (port 8581)
FLAP_LIB=<Flap's repository at the entry's submodule commit> WORK=<a build folder> scripts/flap-fork.sh
                     # Playwright on a fork of BSC Testnet (port 8581): the whole Flap rail from the page
WORK=<a folder with ../openfour installed by npm ci, and ../core> scripts/four-fork.sh
                     # Playwright on a fork (port 8581): the OpenFour rail, both kinds of token
```

- `scripts/e2e-local.sh` builds `e2e/chain` with Foundry: a plain test token plus the shared pile from `../core`. It
  seeds the chain with `scripts/seed-local.mjs`.
- `scripts/flap-fork.sh` builds a copy of `../flap` and `../core` with Flap's repository as its library, outside
  this tree. It deploys the factories with the entry's `Deploy` script, creates a short sale with `CreateSale`, and
  then runs `e2e/flap.spec.ts`. That spec covers:
  - create through the Portal, after the floor refusal;
  - buy, sell back, launch, claim;
  - trade on the pool, send the tax to the pile, redeem;
  - a missed deadline taken back in full;
  - a 0.05 BNB sale once the factory's floor multiplier is 0 (a stand-in for Flap, as the entry's rehearsal does).
- The test wallet is one of anvil's unlocked development accounts, injected into the page. No key is used.
- Screenshots go to `../../hackathon/evidence/SH-265/`.

## Creating on the Four.meme rail

OpenFour's Core accepts `createToken(createArgs, signature)` only with a signature of the copy's signer. The form
calls the creation signer of `../openfour/sign/README.md`, which the site serves on the same origin at
`<base>api/four/sign-create`, so `connect-src 'self'` covers it.

- **The request** is exactly the signer's body: `{ kind: "preset" | "tax", creator, name, symbol, tokenUri: "",
  quote, raiseAmount, buyFeeBps, sellFeeBps }`, or `taxBuyBps, taxSellBps` for a tax token. The form checks the
  signer's own bounds first.
- **The answer** `{ createArgs, signature, requestId, validUntil, kind, creator }` is checked before anything is
  sent:
  - it is for this creator and this kind;
  - it is still valid;
  - its fields are bytes.
  The signer's refusal is shown in its own words.
- **Then the visitor's wallet** sends `Core.createToken(createArgs, signature)` after a simulation, with a fixed
  12,000,000 gas for a tax token. The page reads `TokenCreated`, opens the new token, and offers "Create the pile"
  for a tax token.
- **In the browser tests** the development server stands in for the site's signer (`scripts/four-sign-standin.cjs`):
  it uses the entry's own signing function with the fork copy's public test key, on a loopback endpoint only.

## Not done

- **Creating on the Four.meme rail** needs the site's signer at `/launches/api/four/sign-create`; the deployment
  file alone does not make it available.
- **Reads:** one age for all reads that fail (not one per figure), and a composite read whose side call fails can
  show a sale, token or pile as absent until it answers.
- **Leaving the page:** a press dies when the page is left (`pagehide`); a page restored from the browser's
  back-forward cache is not reconciled beyond that.
- **The Create form** takes the deadline in whole hours and the tax in whole days, and trims names and symbols; the
  factory accepts seconds and any non-empty string.
- **A transaction replaced in the wallet** (a cancel or other data) gets no receipt by its hash: the dialog says
  "Still not confirmed"; "Leave it pending" ends the press. Replacements are not reconciled.
- **An outstanding wallet request** of a press that was stopped can still be sent by the wallet: the line says so.
- **Settle** (a zero transfer) and the test coin's mint depend on no chain state; their predicate says so.
- **The quote is not tied to a block:** a press reads it again, but a later block before the wallet answers can
  change it; the minimum or the cap sent still bounds the result.
- **The page sends no first buy with a creation.** It had no enforceable minimum; a creator buys after creating.
- **The pool guard's tax assumption:** after a Flap launch the pool quote takes off the tax rate fixed at creation,
  even after the tax period ends (Flap's token gives no view of when it ends); the review says so. The minimum is
  then lower than it need be, never higher.
- **The pile picture and the "Latest" list** cover the events from the deployment's first block; the list says so.
- **Writes have run only on local chains and forks,** with an injected test wallet. The real test network has been
  read only.
