# Launch UIs for our rules launcher factories, built from Flap's template

The Flap track asks for "your own launch UI using the Flap templates". These are two launcher UI packages in the
format of Flap's launcher runtime (`launcher-config-preview/v1`): a creation form (`LauncherConfig`) and a sale page
(`Launcher`) for each of our rules curve launcher factories on BSC Testnet (chain 97).

| Folder | Factory | Quote | Actions on Flap's page |
| --- | --- | --- | --- |
| `rules-bnb/` | `0xa0c6D7be020eD3699508745A4dbAC1A8a1B415C2` (`../deployments/97-v2-rules-native.json`) | tBNB | create, buy the rest (`complete()`), claim, take back (`unwind()`) |
| `rules-usdt/` | `0x61873aD21f3E471910C976ef7993ED40b399eeC0` (`../deployments/97-v2-rules-usdt.json`) | USDT (test) | create, claim, take back |

These are the corrected factories (SH-308, deployed 26 Nov 2026). The first set's addresses, which the UIs no longer
name, are in `../deployments/97-rules-native.json` and `97-rules-usdt.json`.

Each folder holds exactly the three files Flap's checker and Workbench take: `Component.tsx`, `manifest.json`,
`i18n.json` (en, zh, ko). Flap's checker requires all three languages with the same keys (the template's
`scripts/launcher-check-source.mjs`, its translations check). **The zh and ko texts are machine-written and
unchecked**: nobody who reads Chinese or Korean has read them. The two `Component.tsx` differ only in their marked factory block
(`test/rules-ui.test.mjs` checks it).

## What Flap's runtime allows, and what that means here

From the template's guide (`examples/launcher-runtime/README.md` at the commit below):

- **Create**: the form encodes our factory's `CurveConfig` with `host.encode` and sends it with
  `host.submit({ kind: "create", configuration, valueWei })`; the host wraps it in `Portal.newLauncher(factory, data)`.
  The value is `host.quote()` (the salt lock fee). The salt: `host.findSalt()` when its token address (our factory's
  `predictToken`: OpenZeppelin clone of `0x7777c57f...2222` by the Portal) ends in 7777, otherwise the form mines one
  itself as `CreateRulesSale.s.sol` does.
- **Actions**: only zero-argument methods of the sale. `buy(minTokens)` and `sell(tokens, minOut)` take arguments, so
  buying and selling any amount stays on the Square Hole page; the sale page shows its address as text, since the
  template forbids raw links to other sites (`AGENTS.md` and `docs/safety-boundaries.md` in the template). The
  address is the hackathon test site's, set as `ourSite` in each `Component.tsx`; it changes with that site. `complete()` (BNB only: the
  test-dollar `complete(maxCost)` takes an argument and an approval) sends the sale's own `costToComplete()` plus 1%;
  the sale returns what it does not need.
- **The creator's rules** are stored by `RulesVaultFactory.setRules` before the sale exists; Flap's host sends only
  the Portal call, so a sale made with this form gets the default, all income to the pile
  (`RulesVaultFactory.rulesOf`), and the form says so and points to our create page for rules.
- **The form's checks** mirror the factory's `checkConfig`: the field bounds, and in bigint its `curveFor` with the
  curve bounds (virtual tokens above the sale, a pool of at least one token, the raise within one millionth of the
  target, a supply of 100 to 10^15 tokens, and for the test-dollar factory a raise that fits a V2 reserve). Flap's
  liquidity minimum is not mirrored: it needs a Portal read the form does not get.
- **Reads**: no-argument getters, or one-address getters for the connected account, returning address, bool or
  uint256 (`manifest.json` `reads`).

## Template

Flap's template, MIT, fetched, not ours: https://github.com/flap-sh/flap-vault-component-template branch
`test/pool-launch-developer-preview` at commit `3a7fa025f7a73dd6b6ff4eecce4e990bf33e1a06` (13 Nov 2026). Never add it
or its dependencies to this repository; fetch it into a scratch folder outside the checkout:

```sh
mkdir flap-template && cd flap-template
git init -q && git remote add origin https://github.com/flap-sh/flap-vault-component-template
git fetch -q --depth 1 origin 3a7fa025f7a73dd6b6ff4eecce4e990bf33e1a06 && git checkout -q FETCH_HEAD
corepack yarn install --frozen-lockfile --ignore-scripts      # yarn 1.22.22, Node 22 or newer
```

## Checks

From the template's folder (`<repo>` is this repository's top folder):

```sh
corepack yarn -s launcher:check-source <repo>/bounties/flap/ui/rules-bnb
corepack yarn -s launcher:check-source <repo>/bounties/flap/ui/rules-usdt
```

Our own test (Node only, from this repository's top folder; uses the repository's typescript):

```sh
node --test bounties/flap/ui/test/rules-ui.test.mjs
```

It encodes each form's default settings and compares the bytes with Solidity's `abi.encode(CurveConfig)` (pinned from
`forge script`), checks the component's keccak-256 and token address prediction against our real sales, the
manifests against the deployed ABIs, and the messages in all three languages.

## The ZIP for Flap

The ZIP is what Flap takes (three files at its root). It is built, not committed:

```sh
bash bounties/flap/ui/zip.sh bounties/flap/ui/rules-bnb ../square-hole-rules-sale-bnb.zip
```

The build is reproducible (fixed order, time and mode): the same three files give the same sha256 on any machine.

## Registration (Flap's step; nothing here sends anything)

Per the template's `examples/launcher-runtime/testnet-example.md` and `README.md`:

1. Send Flap the ZIP with the chain (97), the factory address, the sale ABI (`../abi/RulesCurveLauncher.json`) and,
   for testing, a real sale of the factory (`../deployments/97-rules-native-sale.json`).
2. Flap checks, builds and publishes it in its Workbench and returns preview links with an `artifactPath`
   (`/launcher/<sale>?chain=bnb-testnet&kind=launcher-detail&artifactPath=...` and a creation preview).
3. A Flap account with `AUDITOR_ROLE` maps the factory to the artifact (scope 5). Then Flap's test site opens the
   form at `/create/launcher?chain=bnb-testnet&factory=<factory>` and every sale of the factory at
   `/launcher/<sale>?chain=bnb-testnet`.

# Vault UIs (SH-309)

Two Vault UI source folders in the format of Flap's Vault runtime (`@/src/sdk`, `@/src/ui`), one per vault kind a
launch of ours can have. Each holds the four files Flap's `vault:check` takes: `Component.tsx`, `VaultABI.ts` (every
contract name and ABI fragment, in one marked block), `manifest.json`, `i18n.json` (English only: the vault checker
accepts it, so nothing machine-translated ships).

| Folder | Vault | Bindings (vault factories, chain 97) | What it does |
| --- | --- | --- | --- |
| `square-hole-pile/` | `PileVault` (the plain sales' pile) | `PileVaultFactory`, `TokenPileVaultFactory` | the pile, what one token redeems for, your tokens; hand in and redeem (approval and `redeem(amount, minOut)` in one press, `minOut` = the vault's own `quoteRedeem(amount)` read just before) |
| `square-hole-rules/` | `RulesVault` (the rules sales' splitter) | both `RulesVaultFactory` | what arrived and is not shared, each rule with its part, what it was sent and what waits (and tokens burned for buy and burn); share out (`distribute()`), pay a creator part that waits (`payOwedCreator(i)`); the pile part's redemption through the vault's `pileOf(token)` resolver (`resolvedContracts` "pile"), and a plain sentence, with no link, when the pile cannot be resolved |

The bindings name today's factories and tokens until the corrected SH-308 factories are deployed; then only the
manifests' `factoryAddress` and `tokenAddresses` change.

## Checks

Vault UIs are checked and packaged in a checkout of the template's MAIN branch (Workbench's freshness and provenance
rules), at `b912fd1f89694a723adfba8e4e68757980239766` for this work:

```sh
corepack yarn vault:scaffold square-hole-pile --chain 97 --factory <factory> --token <token> --locales en   # once
cp <repo>/bounties/flap/ui/square-hole-pile/* src/vaults/square-hole-pile/
corepack yarn -s vault:check square-hole-pile
corepack yarn -s typecheck
corepack yarn -s vault:e2e square-hole-pile --chain 97 --factory <factory> --token <token> --vault <vault>
corepack yarn vault:package square-hole-pile
corepack yarn vault:verify-package dist/square-hole-pile.zip
```

`vault:e2e` is Playwright on Chromium against the template's local preview, reading chain 97. The ZIP for Flap is the
one `vault:package` writes (with its E2E report); never zip a vault UI by hand.

Our own test, Node only: `node --test bounties/flap/ui/test/vault-ui.test.mjs`.

## What the two pages assume and how they show numbers

- **The coin a vault pays in.** The native coin has 18 decimals. For an ERC-20 asset the pages use the host's payment
  token when it is the vault's asset, and then read nothing more. When the host passes another coin or none, they ask
  the asset's own contract for `decimals()` and `symbol()` (on the address the vault's `asset()` returns; nothing is
  ever written to it). That read never holds back the page: the tiles, the rules, "Share out now" and "Pay this part
  now" appear when their own reads land; until the coin answers, coin amounts read "-" and redeem stays refused. The
  coin is asked once per chain and asset for the visit, also while its answer is on its way; an answer is kept,
  usable or not; only a failed read is asked again. An answer is
  taken only when it is plain: whole decimals from 0 to 36, a symbol that starts with a letter and has at most 16
  letters, digits, dots, underscores or dashes. Without a usable unit the pages show no amount and refuse to redeem
  ("The coin this vault pays in is not known here."). Flap's checker accepts this read without a manifest entry: the
  address is a token-related address read from the vault (the template's own `community-buyback-example` reads a
  vault-given token the same way). A resolver (`resolvedContracts`) cannot give it: a resolver takes at least one
  input, and `asset()` takes none.
- **Limitation: the host's decimals are trusted.** When the host's payment token equals the vault's asset, the pages
  use the host's decimals and symbol as they are (as in the first version); they do not compare them with the
  asset's own answer.
- **The redeem's minimum is the exact fresh quote, with no tolerance (kept on purpose).** At the press the page reads
  `quoteRedeem(amount)` and sends it as `minOut`. The pile refuses a payout below it and rolls the hand-in back
  (`FeeRulesBase._redeem`, `BelowMinimum`), so nobody receives less than the quote read at the press. (The code does
  not compare that quote with the figure the page showed up to 15 seconds earlier; by the assumption below it is not
  lower.) The assumption that also keeps this from refusing for nothing: for a fixed amount the quote cannot fall. The quote is
  `pile x amount / circulating supply`, rounded down. Another holder's redemption takes at most its own rounded-down
  share and lowers the supply by what it handed in, so the pile per circulating token does not fall; income only
  adds; nothing but a redemption moves the pile out (`FeeRules.sol`, the contract's first note); and the circulating
  supply cannot grow: these piles have no excluded holders (`PileVault.initialize` passes none), the pile never sends
  the token out, and the token's total supply is taken as never growing (Flap's tax token; not in our sources). If
  any of that changed (other pile code behind the beacon, a token that mints), a redemption would be refused; it
  would not pay less.
- **Only `redeem`, no `redeemTo`.** The payout goes to the connected wallet. A contract wallet that cannot receive the
  native coin is refused by the pile (`PaymentFailed`); "How it works" says so for a vault that pays in tBNB.
- **"You get now"** is read again 0.4 s after each change of the amount and after every landed refresh round (every
  15 s). Nothing is held for it: an answer is shown if and only if what it was asked for (chain, vault, token, coin
  and amount) is what the page shows when it arrives; any other answer is dropped. Several quotes can be on their
  way at once; one that never answers blocks nothing, and a failed one changes nothing.
- **Nothing of one vault is shown for another.** Every figure is kept with the chain, vault and token it was read
  for (the pile and the quote also with the coin, the quote also with the amount, the typed amount with the vault;
  the visitor's balance and allowance also with the connected account) and is shown only while those are what the
  page shows.
- **Numbers.** Amounts are formatted from bigint, always rounded down: four decimals (eight in the per-token tiles),
  or as many as the first three significant digits need, so an amount that is not zero never reads "0"; the whole
  part has thousands separators. Token counts (the circulating supply, tokens burned) read as whole tokens with
  thousands separators; "Your tokens" keeps its fraction. The "All" button types the exact plain balance, and the
  amount field takes plain digits only.
- **"How it works"** is a short list inside the closed "More" part of each page. On the rules page a line about a
  creator part, the buy and burn or the pile appears only when the vault has such a part.

