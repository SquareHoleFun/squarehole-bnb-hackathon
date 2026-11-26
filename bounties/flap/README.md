# Curve sale with a pile, on Flap Pool Launch

A Launcher Factory for Flap's Pool Launch on BNB Chain. A token is sold along a price curve before any pool exists;
the sale either **graduates** into a Flap pool in one transaction or **unwinds** and gives everyone their share of the
BNB back. From then on the token's buy and sell tax feeds a **pile that any holder can redeem**.

**What is distinctive:** price discovery happens before the pool exists, on a curve nobody can change; a launch that
fails unwinds itself; and from the first trade a share of every trade backs a floor the holders can redeem.

## The mechanism in plain words

1. **Create.** Someone creates a sale through `Portal.newLauncher` (or the factory's own `createLauncher`). The rules
   are fixed at that moment: how many tokens are for sale, the BNB target, how steep the curve is, the deadline, the
   fee on curve trades, the tax after launch and how much of the tax is burned. The factory reads the Portal's own
   liquidity floor and refuses a sale that could never launch. The creator may buy first, at the start price.
2. **Buy and sell on the curve.** Anyone buys from the Launcher at the curve's price, which rises as tokens are sold,
   and anyone may sell back along the same curve before the launch. A 1% (configurable, at most 5%) fee on each
   curve trade is kept apart.
3. **Graduate.** The buy that takes the last sale token launches the token on Flap's Portal in the same
   transaction: all the raised BNB becomes the pool, with as many tokens as make the pool's opening price the curve's
   final price (rounded as stated below); the Portal burns the LP. Before accepting the launch the Launcher checks
   that the token is the predicted one, that all the buyers' tokens arrived, and that the vault is our deployed
   PileVault for that token; otherwise the launching buy reverts and the sale stays open. The Launcher relies on
   Flap's Portal for the pool it creates and returns: it checks the token, the sale tokens and the pile, not the pair
   on the exchange. The buyers claim their tokens one for one. What is left in the Launcher (the curve fees, and any
   BNB sent to it unasked), less the completing buyer's change, goes to the pile: its first money.
4. **The pile.** Buys and sells on the pool pay the tax set at creation, for as long as it runs. Part is burned; the
   vault slot's share (after Flap's protocol fee) reaches this token's `PileVault` once the token's processor has
   swapped the collected tax and `dispatch()` has run. Any holder of claimed tokens may hand them in at any time and
   receives `pile x tokens handed in / tokens in circulation` in BNB, rounded down; the tokens go to the dead address.
   **Tokens in circulation are every token that is not burned and not in the pile itself, the pool's and the
   not-yet-claimed ones included: one floor per token, the same whether a token sits in a wallet or in the pool.**
   Whoever hands in the last circulating tokens empties the pile. (Tokens held where nobody can move or redeem them
   still count, so the floor is for holders who can transfer or redeem their tokens.)
5. **Or unwind.** If the deadline passes before the last sale token is bought, buying and selling stop and every
   account takes back what it put in net: BNB paid for its buys, fees included, minus BNB it received for sells.
   The Launcher holds exactly the sum of those, so everyone is made whole, in any order; no token is created and the
   creator is out only the Portal's salt-lock fee. Only if someone sold back at a profit before the deadline is the
   Launcher short, and then everyone owed gets the same share of their net, the last one emptying the Launcher.

**Nobody can change the rules:** the Launchers are EIP-1167 minimal clones whose code address cannot be changed; the factories have no owner, no fee
and no switch; `upgradeVaultImplementation` reverts on both factories, for Flap's Guardian too; the pile has no
owner, no setter and no pause.

### Who bears the shortfall after a profitable sell-back (worked from `test_unwind_shortfall_bothOrders`)

Alice buys on the curve for 0.5 BNB. Bob then buys for 1.2 BNB and carol for 0.6, which raises the price. Alice
sells all her tokens back and receives 0.665350730729085621 BNB: 0.1654 more than she put in. The deadline passes.
The Launcher holds 1.634649269270914379 BNB; bob is owed his net 1.2, carol 0.6, alice nothing. Bob and carol bear
alice's gain in proportion to what they are owed: each gets 90.81% of their net. Each refund is
`remaining balance x owed / remaining debt`, rounded down, and the last one owed takes what is left, so the order
moves at most rounding units: bob first pays bob 1.089766179513942919 and carol 0.544883089756971460; carol first
pays carol 0.544883089756971459 and bob 1.089766179513942920. Without a profitable sell-back (the usual case)
everyone gets back exactly what they put in, fees included, in any order (`test_unwind_everyoneWhole_bothOrders`).

### BNB that arrives unasked

The Launcher has no `receive`, but BNB can still reach it (sent before its address was used, or forced). While the
sale runs the surplus is `balance - curveBalance - feePot` and changes nothing. At the launch everything but the
completing buyer's change goes to the pile, the surplus included. In an unwind the refunds are shares of the whole
balance, so creditors take the surplus too (one may then get more than its net). With nobody owed, it stays in the
Launcher. After the launch, BNB forced into the Launcher stays there. `progress()` while unwinding reports the
balance still to refund (zero after the last refund).

## What Flap's contracts and roles control

Our contracts have no owner and no switch, but the launch runs through Flap's Portal, a proxy whose admin roles can
change it. What those roles and contracts decide:

- **Whether a launch can happen:** factory enablement, the floor multipliers, the creation pause, the quote price and
  the floor itself are Flap's settings, read live. A change after a sale is created can make its completing buy
  revert; the sale then stays open until its deadline and unwinds. (Measured on the test network today: an unenabled
  factory was recorded and launched even with creation paused; see the fork tests.)
- **The launch itself:** the Portal mints the token, seeds the pool, burns the LP, hands the buyers' tokens to the
  Launcher and creates the vault through our vault factory. The Launcher checks the token's address, the tokens it
  received and the vault's origin before it accepts; it does not check the pool beyond what the Portal returns (the
  fork tests do).
- **After the launch:** the tax token's behaviour, the tax duration and rates we set within the Portal's bounds, the
  tax processor's liquidation and its protocol fee bucket, and `dispatch()` decide what reaches the pile and when. Only
  the vault slot's share reaches it; part of each tax goes to Flap's protocol fee.
- **What they cannot do:** nothing in Flap's published interfaces lets anyone take BNB already in a pile; the pile has
  no owner, no withdrawal and no upgrade (`upgradeVaultImplementation` reverts, for Flap's Guardian too).

## How it differs from Flap's examples

- `MintLauncher` and `CrowdLauncher` take BNB at one fixed price toward a target, refund it if the target is missed,
  and hand contributors a fixed half of the supply. Crowd's paired vault pays the tax to the **contributors** (10% to
  90%, the rest to the creator).
- Here the price is **discovered on a curve** before the pool exists, buyers can **leave before the launch**, the
  pool opens **at the curve's last price**, a failed sale **unwinds** to everyone's net deposit (less a shortfall
  only after a profitable sell-back), and the tax backs a floor **any holder** can redeem, whoever bought when.

## The curve, exactly

The curve is a virtual constant-product pool `(X0 BNB, Y0 tokens)`. The BNB on the curve when `s` tokens are sold is

```
R(s) = ceil(X0 * Y0 / (Y0 - s)) - X0
```

Every buy of `n` tokens costs `R(s + n) - R(s)` and every sell returns `R(s) - R(s - n)`, so after **any** sequence
of buys and sells the Launcher holds exactly `R(sold)` plus the fee pot, to the wei (fuzz-tested against an
independent oracle). Because `R` is rounded up, a single trade can cost or return a wei more or less than the
unrounded curve would; the reserve stays exact because every trade is a difference of the same `R`. The fee is
`ceil(amount x fee bps / 10000)` on each trade, so its rounding unit goes to the fee pot.

`X0` is chosen at creation and `Y0 = floor((X0 + T) * S / T)`. The exact raise is `R(S)`, which `curveFor` reports
and the factory refuses if it is more than one millionth off `T` (for the tested 600M tokens, 2.6 BNB, `X0` = 10 BNB:
`R(S)` = 2.600000000000000001). At the target the pool gets `R(S)` BNB and
`poolToken = floor((Y0 - S) * R(S) / (X0 + R(S)))` tokens, so the opening price `R(S) / poolToken` is the curve's
final marginal price `(X0 + R(S)) / (Y0 - S)` or above it by less than one part in `poolToken` base units; the
factory requires at least one whole token in the pool. Equal prices do not mean a buyer can sell the next block for
the same: the pool's tax and price impact apply. The supply is `S + poolToken`, and the pool's share of it is about
`X0 / (2 X0 + T)`, below one half before rounding.

## Files

| Path | What it is |
|---|---|
| `src/CurveLauncherFactory.sol` | Flap Launcher Factory (`lf-v1`): checks, floor, both ways in, salt and address previews |
| `src/CurveLauncher.sol` | The sale: curve, fees, graduation through `launchTaxTokenV2`, claims, the unwind |
| `src/CurveMath.sol` | The curve's arithmetic |
| `src/PileVaultFactory.sol` | Flap direct-launch vault factory (`pl-v1`): one `PileVault` per token |
| `src/PileVault.sol` | The pile: `../core/src/FeeRules.sol` behind Flap's vault surface |
| `src/TokenCurveLauncher.sol`, `src/TokenCurveLauncherFactory.sol`, `src/TokenPileVaultFactory.sol` | The same sale with an ERC-20 as the quote (see "With a token as the quote") |
| `src/IPortalFloor.sol` | The Portal's floor views (`graduationFloorV2`, `launchQuoteConfig`) |
| `../core/` | The shared fee-rules core (`IFeeRules`, `FeeRules`) and its tests |
| `abi/` | ABIs for a launch page |
| `script/` | Deploy, create a sale, each step of a sale, a rehearsal on a fork, the ABI export |

Flap's base contracts come from their repository as a git submodule (`lib/flap-pool-launch`), not copied.

## Run the tests

Foundry 1.x, from this folder:

```bash
git submodule update --init --recursive lib/flap-pool-launch
forge test --no-match-path "test/*.fork.t.sol"     # the curve without a chain
(cd ../core && forge test)                         # the pile
script/fork-test.sh                                # the fork tests: anvil on port 8578 against the BNB test network
script/rehearse.sh                                 # the whole real path on a fork, with the gas of every transaction
```

The fork tests run against the live test network Portal (`0x000042108465206185A077Edc3F3fd2b49060000`), nothing
mocked: the complete launch directly and through `Portal.newLauncher` (Flap's factory switch on and off), the
pool seeded with exactly the raise at the curve's final price, the LP burned, the claims, trades on the real pool,
the tax dispatched, the pile grown by exactly the vault slot's share, a redemption paid to the last wei, the unwind,
the floor refusal, and a 0.05 BNB sale once Flap sets our factory's floor multiplier to 0.

## Run it on the test network

**These scripts are an operator's tool, not a guard:** run each step once, in order, and look (the status read, the
transaction's receipt) before any retry. They report what they simulated; a fresh retry of a step that already
mined can spend again (a second factory, a second sale, a second buy). The real run on the test network was made
with them (21 transactions).

From this folder, with a keystore (never a key in a file, a variable or a command line); legacy transactions at
0.1 gwei, one at a time. After each step, the `status` read shows the state it should have left (another wallet's
transactions can change the same numbers; the receipt is the proof of your own).

```bash
RPC=https://bsc-testnet-rpc.publicnode.com   # or https://bsc-testnet-dataseed.bnbchain.org, https://bsc-prebsc-dataseed.bnbchain.org
N="--rpc-url $RPC --legacy --with-gas-price 100000000 --slow"
K="--account <keystore> --password-file <password file> --sender <address>"
S="--rpc-url $RPC --sender <address>"                          # for status reads, which send nothing

# 1. the two factories (once); writes deployments/97.json with deployBlock
forge script script/Deploy.s.sol $N $K --broadcast
# 2. a 2.35 BNB sale through Portal.newLauncher; prints the salt and the predicted Launcher, writes deployments/97-sale.json
forge script script/CreateSale.s.sol $N $K --broadcast
# 3. a buy on the curve
ACTION=buy AMOUNT_WEI=20000000000000000 forge script script/Sale.s.sol $N $K --broadcast
# 4. the launch: buys every remaining sale token or reverts (sends costToComplete() + 0.01 BNB, the rest comes back)
ACTION=complete forge script script/Sale.s.sol $N $K --broadcast
ACTION=status forge script script/Sale.s.sol $S              # proof: phase 1, "my claimable tokens" > 0
# 5. claim (refused unless phase 1)
ACTION=claim forge script script/Sale.s.sol $N $K --broadcast
ACTION=status forge script script/Sale.s.sol $S              # proof: claimable 0, token balance up by the claim
# 6. a pool trade, in two legs; the sell is half of what the buy filled
TOKEN=$(cast call "$(jq -r .launcher deployments/97-sale.json)" "token()(address)" --rpc-url $RPC)
B0=$(cast call $TOKEN "balanceOf(address)(uint256)" <address> --rpc-url $RPC | cut -d' ' -f1)
ACTION=pool-buy AMOUNT_WEI=100000000000000000 forge script script/Sale.s.sol $N $K --broadcast
B1=$(cast call $TOKEN "balanceOf(address)(uint256)" <address> --rpc-url $RPC | cut -d' ' -f1)
ACTION=pool-sell TOKENS_WEI=$(node -e "console.log(((BigInt('$B1')-BigInt('$B0'))/2n).toString())") forge script script/Sale.s.sol $N $K --broadcast
#    repeat 6 until status shows "tax waiting for the pile" > 0 (three rounds of 0.1 BNB did, on the fork and live)
# 7. dispatch: sends dispatch() if tax is waiting; if it is already in the pile, says so and sends nothing
ACTION=dispatch PILE_BEFORE_WEI=<"pile (wei)" from the last status> forge script script/Sale.s.sol $N $K --broadcast
ACTION=status forge script script/Sale.s.sol $S              # proof: the pile grew by the "tax waiting" read before
# 8. redeem part of the tokens
ACTION=redeem TOKENS_WEI=10000000000000000000000000 forge script script/Sale.s.sol $N $K --broadcast
ACTION=status forge script script/Sale.s.sol $S              # proof: "pile paid out so far" up; the receipt has Redeemed
```

**When the waiting tax moves by itself.** The token collects its tax in tokens; a sell on the pool swaps the collected
tax to BNB in the token's processor (on the real run: the third pool sell, block 144771875, event
`FlapTaxProcessorProcessTaxTokens`); `status` then shows it as "tax waiting for the pile". It reaches the pile when
anyone calls the processor's public `dispatch()`. On the test network a keeper contract does that for Flap tokens:
on the real run a third-party wallet's `batchDispatch(address[])` moved all 11,405,571,519,287,685 wei to the pile
three blocks later (block 144771878, `FlapTaxProcessorDispatchExecuted`). So "nothing waiting" right after a
positive read is the normal case, not a failure: compare the pile with its earlier read.

`script/rehearse.sh` plays this on a local fork (it computes each fill; its defaults are a 1 BNB curve buy and 0.3
BNB pool legs, set `BUY_WEI` and `TRADE_WEI` to match) and prints every step's gas.
`CreateSale.s.sol` takes its settings from the environment (see its header); its defaults are a 600,000,000-token
sale to 2.35 BNB with `X0` = 16 BNB (the price rises 31% along the curve), the rehearsed default that clears the
Portal's floor today. `TARGET_WEI=50000000000000000 VIRTUAL_WEI=200000000000000000` makes a 0.05 BNB sale where
Flap's floor multiplier for our factory is 0. The pool legs accept no less than the router's quote minus the
token's tax and `SLIPPAGE_BPS` (default 200); `redeem` accepts no less than the pile's quote.

**The record of each action.** Forge writes every run's transactions to `broadcast/<script>/97/run-<timestamp>.json`
and the latest to `run-latest.json` of that script; keep the folder until the run is over. Each action's record is
the timestamped file of its run. `--resume` continues the latest run of a script, so resume a stopped `Sale.s.sol`
action before running another one.

**If an endpoint answers "rate limit" or "nonce too low" in the middle of a step.** With `--slow` forge sends one
transaction, waits for its receipt, then sends the next, writing each hash into the record as it goes. An error in
the middle leaves: the transactions before it mined (with receipts in the record); possibly the one in flight, sent
but unconfirmed; the rest not sent. Do not start the step again from scratch: Deploy or CreateSale would send a
second factory or a second sale. Instead:
1. Look at the recorded hashes and the wallet's nonce on another endpoint: `cast receipt <hash> --rpc-url <other>`,
   `cast nonce <address> --rpc-url <other>`.
2. Continue the same step, with the same command and environment, on a working endpoint, adding `--resume`: set
   `RPC=<other>` and rebuild `N` and `S` (they hold the old endpoint), then the same `forge script ... --broadcast
   --resume`. Forge sends only what its record does not show as confirmed. A pool swap whose 600-second deadline has
   passed fails; send that leg again as a fresh action after checking it did not mine.
"Nonce too low" means the chain already holds a transaction at that nonce: either the one in flight was mined (its
receipt shows it; resume) or the endpoint served a stale nonce (another endpoint shows the real one; resume there).

**If a run stops**, what is on chain decides what to do next (`cast receipt <hash> --rpc-url $RPC` for each hash in
the action's record):
- Deploy stopped after its first transaction: only the PileVaultFactory exists. Rerun with
  `PILE_VAULT_FACTORY=<its address> PILE_VAULT_FACTORY_NONCE=<the nonce of its creation transaction (cast tx <hash> nonce)>`: the script
  checks that the address is the sender's at that nonce and that its code is this build's, then sends only the second.
- CreateSale: once mined, the salt fee is spent, the deadline runs and a first buy (if any) is on the curve. If the
  sale file was not written, set `LAUNCHER=<the printed predicted Launcher>` for the next steps.
- A curve buy is one transaction; the sale goes on. `complete` launches or reverts: if it reverted, nothing changed
  (the status still shows phase 0); run it again. If the deadline passes first, `ACTION=unwind` returns each
  account's net.
- A mined `claim` is final; `claim` again is refused with NothingToClaim.
- `pool-buy` is one transaction: if it mined, the fill is in the token balance; sell it with `pool-sell` (fresh
  deadline, fresh least-accepted output). `pool-sell` is two (approve, sell): a stop after the approve leaves an
  allowance to the router of exactly `TOKENS_WEI` (status shows it); run `pool-sell` again with the same amount.
- `dispatch` is one transaction; a mined dispatch with nothing waiting is refused before sending, so a mined one
  moved the waiting tax (the status read before and after shows how much).
- `redeem` is two (approve, redeem): a stop after the approve leaves an allowance to the pile, which only the
  wallet's own redemption can use; run `redeem` again.

## With a token as the quote (Flap's test USDT)

The same sale, priced, paid and pooled in an ERC-20 instead of BNB, so a complete launch needs no test BNB beyond gas
and the Portal's salt-lock fee. Read on chain 97 on 25 Nov 2026: Flap's Portal enables its test USDT as a quote
(`launchQuoteConfig(0, USDT)` = enabled at a price of 1 USD), and anyone can mint it through its public
`mint(address,uint256)`.

- Test USDT on chain 97: `0x190C989D5665a0e404B444b53CAE9AbCfb600157` (on chain its name and symbol are "USD", 18
  decimals).
- New contracts: `TokenCurveLauncher`, `TokenCurveLauncherFactory`, `TokenPileVaultFactory`. The native contracts
  are unchanged; the curve maths, the `CurveConfig` shape and the pile (`PileVault`, held in the quote) are shared.
- **One quote per factory pair**, fixed at deployment; both factories refuse to deploy unless the Portal reports that
  quote as enabled, and the vault factory serves exactly it. A raise above what a standard V2 pair can hold as a
  reserve (`type(uint112).max`) is refused at creation.
- **No change.** A buy takes a maximum cost and a minimum of tokens and pulls exactly cost plus fee by
  `transferFrom`; a cap above the cost of the rest buys the rest. `complete(maxCost)` pulls exactly the cost of the
  rest plus its fee and launches, or reverts as a whole. A sell takes a minimum payment.
- **What the transfer checks guarantee**, for the factory's one fixed quote: on a pull, this Launcher's balance grew
  by exactly the amount during the call (a quote that delivers less makes it revert); on a payment out (sells,
  unwinds and the sweep to the pile), the Launcher lost exactly the amount and the recipient gained exactly it. They
  do not cover what the sender is charged beyond the amount, or a rebase between calls: use a plain ERC-20 (the test
  USDT is one). Claims use a safe transfer of the sale token. The Portal's pull of the raise is checked by the
  Launcher's debit and by its allowance reading zero afterwards.
- **The launch** relies on Flap's Portal for the pool it creates and returns, its funding and the LP burn: the
  Launcher checks the token, the sale tokens and the pile (ours, deployed, holding this quote), not the pair on the
  exchange. Everything left in the Launcher then goes to the pile.
- **A missed sale** refunds by the same rule as the native one: each account its net deposit when nobody sold back
  at a profit; otherwise everyone owed gets the same share of their net, the last one emptying the Launcher (see
  "Who bears the shortfall after a profitable sell-back" above; `test_unwind_shortfallAfterAProfitableSeller_isProportional`).
- **No native coin** in the Launcher except the salt-lock fee at creation: every other function refuses value, and
  the Launcher has no `receive`. (The pile accepts the zero-value wake call that follows an ERC-20 payment and refuses
  BNB.) There is no first buy in this variant; the creator buys like anyone else.
- **The tax** reaches the pile in the quote: the vault slot's share of the collected tax, once the processor has
  swapped it and `dispatch()` has run (a transfer, then an empty wake call); the pile counts it by its balance.
  Redemptions pay the quote.
- **The floor** is computed by the Portal in USD at its price for the quote (1 USD per test USDT on 25 Nov 2026):
  about 1,610 USD for the default curve (1,700 USDT raise, 11,600 virtual).

**What a creator needs for the default sale funded by one buyer:** about 1,720 minted test USDT (the raise plus the
1% curve fee) and about 0.007 test BNB (the 0.005 salt-lock fee plus gas; a full rehearsed run with a second buyer
and three pool rounds used 20.9 million gas, 0.0021 BNB at 0.1 gwei). Other settings, more buyers or a lower floor
change these numbers.

Run once, in this order (an operator's tool: look at the status and the receipt before any retry). Each action
approves exactly what it is quoted to spend, checks the approval, asserts its own effect on forge's simulation of the
same transaction, and clears and reads back any allowance left; `ACTION=status` reads the mined state.

```bash
RPC=https://bsc-testnet-rpc.publicnode.com
N="--rpc-url $RPC --legacy --with-gas-price 100000000 --slow"
K="--account <keystore> --password-file <password file> --sender <address>"            # the creator
KA="--account <second keystore> --password-file <its password file> --sender <its address>"   # a second buyer
S="--rpc-url $RPC --sender <address>"
forge script script/DeployToken.s.sol $N $K --broadcast        # 1. the two token-quote factories; deployments/97-usdt.json
ACTION=mint AMOUNT_WEI=5000000000000000000000 forge script script/TokenSale.s.sol $N $K --broadcast    # 2. 5,000 test USDT
forge script script/CreateTokenSale.s.sol $N $K --broadcast    # 3. a 1,700 USDT sale via Portal.newLauncher
ACTION=buy MAX_COST_WEI=300000000000000000000 forge script script/TokenSale.s.sol $N $K --broadcast    # 4. creator buys
ACTION=mint AMOUNT_WEI=1000000000000000000000 forge script script/TokenSale.s.sol $N $KA --broadcast   # 5. second buyer
ACTION=buy MAX_COST_WEI=200000000000000000000 forge script script/TokenSale.s.sol $N $KA --broadcast
ACTION=sell TOKENS_WEI=<half of its "my tokens on the curve"> forge script script/TokenSale.s.sol $N $KA --broadcast
ACTION=complete forge script script/TokenSale.s.sol $N $K --broadcast   # 6. approves exactly costToComplete(), launches
ACTION=claim forge script script/TokenSale.s.sol $N $K --broadcast      # 7. both claim
ACTION=claim forge script script/TokenSale.s.sol $N $KA --broadcast
ACTION=pool-buy AMOUNT_WEI=100000000000000000000 forge script script/TokenSale.s.sol $N $K --broadcast    # 8. USD -> token
ACTION=pool-sell TOKENS_WEI=<half the fill> forge script script/TokenSale.s.sol $N $K --broadcast          #    token -> USD
#    repeat 8 until status shows "tax waiting for the pile" > 0 (one round need not be enough; three were on a fork)
ACTION=dispatch PILE_BEFORE_WEI=<"pile (quote)" from the last status> forge script script/TokenSale.s.sol $N $K --broadcast   # 9.
ACTION=redeem TOKENS_WEI=10000000000000000000000000 forge script script/TokenSale.s.sol $N $K --broadcast   # 10. paid in USD
ACTION=status forge script script/TokenSale.s.sol $S
```

`script/rehearse-usdt.sh` plays this on a fork (with a second buyer, three pool rounds and the fills computed) and
prints every step's gas, the BNB and the test USDT spent.

**For a page,** compared with the native sale: the buyer approves the Launcher for the quote before `buy(maxCost,
minTokens)` and `complete(maxCost)` (no value sent); `quoteBuy(maxCost)` returns tokens, cost and fee, a snapshot for
the selling phase (what is pulled is cost plus fee at inclusion, or the call reverts); pool trades go quote to token
and back on the token/USD pair; the pile, its `quoteRedeem` and every redemption are in the quote (18 decimals for the
test USDT); `quote()` on the Launcher and the factories names it. The phase table below applies as for the native
sale.

## Their token, our rules (a launch whose income follows the creator's rules)

A launch on Flap whose VAULT slot income is shared, by fixed parts the creator chooses before the sale exists, among
up to four rules: **creator** (paid to an address), **pile** (the token's PileVault, redeemable by every holder),
**buy and burn** (buys the token on its PancakeSwap pool and sends it to the dead address). Flap's own burn slot stays
as it is.

- The shared piece is `../core/src/RuleSplitter.sol` (interface `IRuleSplitter.sol`): one per token, income recognised
  by balance, `distribute()` by anyone, a rule that cannot be served now keeps its part owed and never holds back the
  others, nothing stranded, no owner. Its header lists how each property is met and its stated limits.
- On Flap: `RulesVault` (the splitter with Flap's vault surface: `description()`, `vaultUISchema()`, a light
  `receive()`, which is all the Portal requires of a vault) and `RulesVaultFactory` (the VAULT slot's factory). It
  pairs with `RulesTokenCurveLauncherFactory` (test dollar) or `RulesCurveLauncherFactory` (BNB): text-only copies of
  the launcher sources whose on-chain texts say the income follows the creator's rules. `python3
  script/rules-launchers.py check` proves the copies differ from the originals only in names, string literals and
  comments; the deployed launchers and factories are untouched. `setRules` refuses a launcher factory whose
  `pileVaultFactory()` is not this vault factory, and the constructor refuses a router without code (and, for BNB, one
  whose `WETH()` is zero). Two stateless deployers create the pile and the splitter (they keep the factory under the
  contract size limit).
- **What a buyer reads on Flap.** The Launcher's `description()` (title "Curve sale with the creator's rules"; the
  income "is shared by the creator's rules ... read them at the RulesVaultFactory with rulesOf(this launcher); without
  rules, all of it fills a pile any holder can redeem"), which the Portal folds into `FlapNewLauncherCreated` when the
  sale is created (1,470 bytes, under the Portal's 4 KB cap); the factory's `launcherDataSchema()` on the create form
  says the same. After the launch the vault's own `description()` lists every rule and its part (Flap's vault panel,
  per Flap's README).
- **The rules are set first, then the sale:** `RulesVaultFactory.setRules(launcherFactory, salt, rules)` stores them
  under the Launcher address that factory will give this creator for this salt, write-once, and only while that
  address has no code. A sale created without rules gets PILE 100% for good. So a buyer can read the final rules
  before the first buy: `rulesOf(launcher)` (PILE and BUY_BURN targets read 0 until the launch) or the `RulesSet`
  event. After the launch: the Launcher's `pileVault()` is the splitter (`ruleCount()`, `rule(i)`, `owed(i)`,
  `delivered(i)`, `burned(i)`), `pileOf(token)` the pile, `RulesVaultCreated(token, splitter, pile, launcher)` the proof
  that our factory made them.
- At the launch the Portal calls the factory, which deploys the pile and the splitter with the stored rules (the
  pile and the router filled in). The splitter exists only from inside the launch transaction, which also seeds the
  pool, so nothing can be shared before the pool exists.

Proven on a fork of the live Portal (`test/RulesPile.fork.t.sol`): rules creator 20%, pile 50%, buy and burn 30%, in
the test dollar and in BNB: trades raise income, `distribute()` pays the creator exactly its part, grows the pile by
exactly its part (then redeemable), and sends the bought tokens to the dead address; create-then-rules is refused and
the pile gets everything. `script/rehearse-rules.sh` plays the whole test-dollar run (26.4 million gas, 0.0076 tBNB
including the 0.005 salt fee).

Stated limits of a rules sale:

- `newVault` serves any Portal launch that names this vault factory, so a foreign launcher factory can produce a real
  `RulesVaultCreated` for its own token. A page lists only sales from OUR paired launcher factories and identifies a
  vault by `vaultOf(token)`, never by its code or deployer.
- `setRules` shows the token's salt one transaction before the create, so someone can lock that salt at the Portal
  first for the price of the salt fee; the creator then mines a new salt (and sets the rules again for it).
- `launchInfo().pileVault_` and the `Launched` event name the RulesVault on a rules sale, not the pile. The older
  scripts (`TokenSale.s.sol`, `Sale.s.sol`) treat that address as a pile: their status read skips it, their dispatch
  and redeem actions revert there; a rules sale uses `RulesSale.s.sol` for those, with the pile at `pileOf(token)`.

```bash
export DEPLOYMENTS_FILE=deployments/97-rules-usdt.json SALE_FILE=deployments/97-rules-usdt-sale.json VARIANT=usdt
forge script script/DeployRules.s.sol $N $K --broadcast                       # the pair (4 tx)
ACTION=mint AMOUNT_WEI=5000000000000000000000 forge script script/TokenSale.s.sol $N $K --broadcast
CREATOR_BPS=2000 PILE_BPS=5000 BURN_BPS=3000 PAYEE=<address> forge script script/CreateRulesSale.s.sol $N $K --broadcast   # setRules, then the sale
ACTION=buy MAX_COST_WEI=300000000000000000000 forge script script/TokenSale.s.sol $N $K --broadcast
ACTION=complete forge script script/TokenSale.s.sol $N $K --broadcast
ACTION=claim forge script script/TokenSale.s.sol $N $K --broadcast
#   pool rounds as in the token-quote section, then:
ACTION=dispatch forge script script/RulesSale.s.sol $N $K --broadcast          # the processor's waiting share to the splitter
ACTION=distribute forge script script/RulesSale.s.sol $N $K --broadcast        # creator, pile, buy and burn
ACTION=redeem TOKENS_WEI=10000000000000000000000000 forge script script/RulesSale.s.sol $N $K --broadcast
ACTION=status forge script script/RulesSale.s.sol $S
```

## Holders paid on their token (RailStake)

Our own boxes pay holders from a balance history only our token keeps; a token born on Flap has none. The smallest
true version: holders who stake the token are paid, evenly per staked token and second, the income that arrives at a
`RailStake` (`../core/src/RailStake.sol`, interface `IRailStake.sol`), without burning anything. One per creator and
token, everything fixed at creation, no owner. On a rules launch it is the payee of a CREATOR rule.

- `RailStakeFactory.create(token, asset, period)` (the caller is the creator) at `stakeAddress(creator, token, asset,
  period)`: the address commits to every setting, so the stake a launch names can only ever have those settings. It
  works before the token exists; income paid there before the create is counted by the first sync.
  `stakeOf(creator, token)` finds it without the settings, `isStake(stake)` says our factory made it.
- `stake(amount)` (approve first; credited by the balance increase), `unstake(amount)` (only the staker, in full, at
  any time; touches the token only), `sync()` (anyone: counts what arrived and streams it), `claim()` /
  `claimTo(to)`. Reads: `claimable(a)`, `stakedOf(a)`, `totalStaked()`, `ratePerSecond()`, `streamEnd()`,
  `undistributed()`, `unsynced()` (arrived, not yet counted: a page's "share out" button), `arrived()`, `claimed()`.
- The stream: a sync sets the seconds left to the amount-weighted mean of the leftover's seconds left and a full
  period for the new income, so a large income streams over about a period and one wei synced every block moves the
  end by nothing; while nobody stakes the stream pauses with its seconds left.
- For a guide: the first staker after a pause collects the waiting stream while alone, per second, never at once; a
  staker who comes right before a share-out and leaves after s seconds gets at most its share of the rate times s
  (the income adds at most income / period to the rate); the token itself can freeze stakes (a token that stops its
  own transfers); a stake is real only when the rule's payee is `stakeOf(creator, token)`; the stake's asset must
  match the payer's (a native payment to a dollar stake is refused, and the splitter keeps that part owed).

A page shows a token's stake when `stakeOf(creator, token)` is not zero, `isStake` is true and the stake's `token()`
and `factory()` match, with the creator from the Launcher's `creator()`; on a rules sale the holders' rule's payee in
`rulesOf(launcher)` must be that stake. The rules put the buy and burn last (it makes the heaviest outside call).

Proven on a fork of the live Portal (`test/RailStake.fork.t.sol`): the creator's stake for the token to come, the
rules creator 10%, pile 30%, holders 40%, buy and burn 20%, a test-dollar launch; trades, the share-out pays the stake
exactly its part, two holders stake, time passes, their claims add up to what arrived (rounding stays in the stake)
and follow stake times seconds; both unstake their tokens in full; a late staker earns from its first second.

`script/stake-stand.sh` builds a stand on a local fork (anvil, PORT, default 8622) with these scripts and keeps it
up for a page (KEEP=0 makes it the rehearsal); it writes `deployments/anvil-97-stand.json` (factory, token, stake,
launcher, splitter) and prints how to make more income arrive (the test dollar mints openly) and pass time.

The real run (after the rules pair of the section above; `$N` the endpoint, `$K` the keystore flags):

```bash
forge script script/DeployStake.s.sol $N $K --broadcast                       # the RailStakeFactory (1 tx) -> deployments/97-stake.json
export DEPLOYMENTS_FILE=deployments/97-rules-usdt.json SALE_FILE=deployments/97-rules-usdt-sale.json VARIANT=usdt
ACTION=mint AMOUNT_WEI=5000000000000000000000 forge script script/TokenSale.s.sol $N $K --broadcast
CREATOR_BPS=1000 PILE_BPS=3000 BURN_BPS=2000 HOLDERS_BPS=4000 STAKE_PERIOD=604800 \
  forge script script/CreateRulesSale.s.sol $N $K --broadcast                 # stake, rules, sale (3 tx); `stake` in the sale file
ACTION=buy MAX_COST_WEI=300000000000000000000 forge script script/TokenSale.s.sol $N $K --broadcast
ACTION=complete forge script script/TokenSale.s.sol $N $K --broadcast
ACTION=claim forge script script/TokenSale.s.sol $N $K --broadcast
ACTION=stake TOKENS_WEI=<half the claimed tokens> forge script script/Stake.s.sol $N $K --broadcast
#   pool rounds as in the token-quote section, then:
ACTION=dispatch forge script script/RulesSale.s.sol $N $K --broadcast
ACTION=distribute forge script script/RulesSale.s.sol $N $K --broadcast       # the stake receives its 40%
ACTION=sync forge script script/Stake.s.sol $N $K --broadcast                 # counted, streaming over the period
ACTION=claim forge script script/Stake.s.sol $N $K --broadcast                # any time later
ACTION=status forge script script/Stake.s.sol $S
```

The launch page's `bounties/app/public/addresses.json` then takes `"railStake": { "factory": "<factory from
deployments/97-stake.json>" }`.

## What a page calls

| Step | Call |
|---|---|
| Preview | `factory.curveFor(saleTokens, targetRaise, virtualBnb)`, `factory.checkConfig(config, viaPortal)` (reverts with the reason), `factory.liquidityFloor(...)`, `factory.predictToken(salt)` (mine until it ends in 7777), `factory.creationFee()` |
| Create | `Portal.newLauncher{value: creationFee + firstBuy}(factory, abi.encode(config))`, or `factory.createLauncher{value}(config)`; the Launcher is in `CurveLauncherCreated` (and the Portal's `FlapNewLauncherCreated`) or `factory.predictLauncher(creator, salt)` |
| Progress | `launcher.progress()`, `prices()`, `config()`, `costToComplete()`, `tokensOf(account)`, `phase()`; events `Bought`, `Sold` |
| Buy / sell | `launcher.quoteBuy(budget)` then `buy{value: budget}(minTokens)`; `quoteSell(tokens)` then `sell(tokens, minOut)` |
| Complete | `launcher.costToComplete()` then `complete{value: cost + margin}()`: buys every remaining sale token and launches, or reverts (`NotCompleted(tokensStillForSale)` when the value would buy only part; other errors for a closed sale or a refused launch); the unused value comes back |
| Refund | `launcher.owed(account)`, then `unwind()`, or `unwindTo(recipient)` for an account that cannot take plain BNB, after a missed deadline (`phase() == 2`); event `Unwound` |
| Claim | `launcher.claimable(account)`, `claim()`; `launchInfo()` gives the token, pool and pile |
| Pile | `pileVault.pile()`, `circulatingSupply()`, `quoteRedeem(amount)`, `totalPaidOut()`, `description()` |
| Redeem | `token.approve(pileVault, amount)` then `pileVault.redeem(amount, minOut)`; event `Redeemed` |

**Which reads a page may call in which phase** (`phase()`: 0 selling, 1 launched, 2 unwinding). The launcher's
curve quotes are meant for the selling phase: after a launch or during an unwind they can revert or describe a trade
that cannot happen, so gate them by phase.

| Read | 0 selling | 1 launched | 2 unwinding |
|---|---|---|---|
| `phase()`, `progress()`, `config()`, `prices()`, `tokensOf(a)`, `owed(a)`, `deadline()`, `raiseTarget()`, `totalSupply()`, `poolToken()` | yes | yes | yes |
| `quoteBuy(budget)`, `costToComplete()` | yes | no | no |
| `quoteSell(tokens)` | yes, with `tokens <= sold()` | no | no |
| `claimable(a)`, `launchInfo()`, `token()`, `pool()`, `pileVault()` | (zero values) | yes | (zero values) |
| pile vault: `pile()`, `circulatingSupply()`, `totalPaidOut()`, `description()` | no vault yet | yes | no vault |
| pile vault: `quoteRedeem(amount)` | no | yes, with `amount <= circulatingSupply()` | no |

Beside "circulating supply" a page can say: *Every token that is not burned and not in the pile counts, in the
pool and unclaimed ones included: each token has the same claim on the pile wherever it sits.*

## Not done

- No audit. Flap has not reviewed or enabled these factories; on the test network today the Portal accepts them
  anyway (see the fork tests), and on BNB Chain it would not without Flap.
- The Launcher's display text is English in both the English and the Chinese fields.
- The fork tests use the public test network endpoint; Flap's own README warns it can be slow or rate limited.
- Two quotes only: BNB and Flap's test USDT (the token-quote section; Pay Packet and Swap Deck were sold in it).
  Another ERC-20 quote needs a factory pair of its own, which deploys only when Flap's Portal enables that quote
  (`src/TokenCurveLauncherFactory.sol`).
- The pile: revenue that arrives during a holder's own hand-in (a tax token that does its tax work inside ordinary
  transfers) stays in the pile for the remaining holders; the hand-in's payout is fixed before it. A redemption
  after which nothing circulates is the last one and takes the whole pile, including such revenue. The payout itself
  is exact: the pile loses exactly what is paid and an ERC-20 recipient gains exactly that, so an asset that taxes or
  skips its own transfers cannot be used for a pile; a native recipient that pays the pile back during its own
  payment fails its redemption. Revenue that arrives after the last circulating token is handed in waits in the
  pile for whoever holds tokens next (on a live pool the pool's own tokens count as circulating, so this does not
  happen while the pool exists).
