# Holder piles for OpenFour: the tax belongs to the holders

Two pieces for [OpenFour](https://github.com/four-meme-community/openfour-docs), Four.meme's modular launch engine,
with one use case: **a token's tax or trading fee goes into a pile that every holder can redeem, instead of into a
wallet.**

1. **`PileTaxVault`, a tax-vault template** for OpenFour's tax tokens (the Royalty `ForwardVault` path). The token's
   founder tax goes into the holders' pile, on the bonding curve and, after graduation, from every DEX trade.
2. **Pile Bonding, a preset** (`module.trade.pile` plus a validator) for plain tokens: a fee on every buy and sell on
   the bonding curve goes into the holders' pile.

## The user problem

On a launchpad today, a token's trading tax or fee goes to a wallet. Holders have to trust whoever holds that wallet
to do what was promised with the money: buy back, pay out, add liquidity, or simply not leave.

## What is different

Here the tax never reaches a wallet. It lands in a contract (the pile, `FeeRules`) that belongs to the token, and any
holder can hand tokens in at any time and receive

    pile × tokens handed in / tokens in circulation

in the token's quote coin. The tokens handed in are burned (sent to `0x…dEaD`), so the holders who stay keep the same
share per token. The rules are fixed when the token is created: the pile has no owner, no setter, no pause and no
upgrade. Every trade raises what each token can be redeemed for, and nobody can take that away.

"Tokens in circulation" is the supply minus what is burned and minus the token's OpenFour vault. OpenFour mints the
whole supply to the vault and sells it on the curve, so during the sale only the tokens actually SOLD count; after
graduation the vault is empty and the DEX pair's tokens count too (anyone can buy them).

## 1. The tax-vault template (`PileTaxVault`)

[`contracts/PileTaxVault.sol`](contracts/PileTaxVault.sol). OpenFour's `TaxToken` pays its founder share to a
`ForwardVault`, which clones a template chosen at creation and forwards each receipt to the clone. Create a token of
the Bonding Tax preset with:

- founder share 100% (holder, burn and liquidity shares 0), any buy and sell tax the token allows;
- `taxVaultTypeId = keccak256("SafuSkill.ForwardVault.v1")`,
  `taxVaultInitParams = abi.encode((PileTaxVault template, bytes("")))`.

Then:

- ForwardVault clones the template. `authorWallet()` is `0x…dEaD`, so ForwardVault waives its 6% royalty and
  forwards everything. The clone renounces the ownership `BaseTaxVault` gives the creator.
- Right after creation anyone calls `createPile()` on the clone (it also runs on the first tax received). It creates
  the token's `FeeRules` pile in the quote coin, with the token's vault excluded. The vault is not yet set while the
  clone is initialised (measured), so this cannot happen in `initialize`.
- Every unit of tax the clone receives goes into the pile: native BNB (when the quote is WBNB) is wrapped first;
  ERC-20 tax is pushed on ForwardVault's callback. This covers both the bonding-curve tax and, after graduation to
  PancakeSwap V2, the DEX transfer tax, which the token swaps to the quote coin and pays out.
- **When the tax arrives.** OpenFour's `TaxToken` does not pay a trade's tax in that trade: it books it and pays it
  out during the next transfer of the token. On the curve the tax waits in the token in the quote coin
  (`feeAccumulated`), after graduation in tokens (`tokenAccumulated`), and the next trade, redemption, ordinary
  transfer or `pile.js settle` pays it into the pile. So right after a single curve buy the pile can still read 0
  while the tax waits; this is not a threshold that a small trade misses (the curve threshold on the copy,
  `minDispatchQuote`, is 10,000,000,000 wei of the quote coin, 0.00000001); after graduation the token swaps its
  tax tokens only above `minDispatch` (50,000 tokens on the copy).

## 2. The Pile Bonding preset (`module.trade.pile`)

OpenFour's developer guide says that when only fees change, you write a new Trade module and reuse the rest:

| Slot | Module | Source |
| --- | --- | --- |
| Token, token impl | `TOKEN_STANDARD` (OpenFourToken) | OpenFour, reused |
| Vault | `VAULT_BASIC` (StandardVault) | OpenFour, reused |
| Curve | `CURVE_BONDING` | OpenFour, reused |
| **Trade** | **`module.trade.pile`** ([`PileTradeModule`](contracts/PileTradeModule.sol)) | **ours** |
| Migrate | `MIGRATE_BONDING` (graduation to PancakeSwap V2) | OpenFour, reused |
| Validator | [`PilePresetValidator`](contracts/PilePresetValidator.sol) | **ours**, asks OpenFour's bonding validator first |

- When OpenFour creates a token with the preset, `PileTradeModule.init` deploys that token's `FeeRules` pile in the
  quote coin, with the token's vault excluded.
- On every curve trade, Core asks the Trade module for fee tiers; it answers one tier: the side's rate (buy or sell,
  each at most 10%, at least one above zero), paid to the pile.
- The validator refuses a creation whose fees are out of bounds, and runs OpenFour's own bonding validator on
  everything else.

**The fee runs while the token trades on the curve.** After graduation the standard token has no transfer tax, so the
pile stops growing; it stays redeemable for good, by the same rule. (For a pile that keeps growing, use the template.)

## 3. Their token, our rules (`RulesTaxVault`, SH-287)

The same tax token and ForwardVault path as the template above, but the founder tax goes to a splitter
([`../core/src/RuleSplitter.sol`](../core/src/RuleSplitter.sol), shared with the Flap entry) that shares it by the
creator's rules: a creator part (paid to the creator), a pile part (the holders' `FeeRules` pile), a buy-and-burn part
(buys the token on PancakeSwap and sends it to the dead address). The three parts sum to 10,000 basis points.
- **Fixed before anyone can buy:** the rules sit in the clone's init parameters inside the signed create arguments
  (`taxVaultInitParams = abi.encode((template, abi.encode((creator, creatorBps, pileBps, burnBps))))`). They are
  checked once while the token is created (a bad set reverts the creation) and stored by `_customInit` under
  OpenZeppelin's `initializer`. The clone has no owner and no setter; the splitter's only write is `distribute()`.
- **After creation:** anyone calls `createRules()` (pile and splitter, once; the first tax also does it), and later
  anyone calls the splitter's `distribute()`. A part that cannot be paid now stays owed for a later call.
- **Buy and burn waits for the migration.** OpenFour registers the token's PancakeSwap pair with its quote coin at
  creation and refuses every transfer to or from it before the migration, so nobody can fund that pair early (a
  stranger's pair cannot take the part: `test/RulesTax.early-pair.test.js`). Until the migration the buy fails and
  the part stays owed in the splitter. **For a token that never migrates, that part stays in the splitter for good**:
  nobody can take it, and it is never spent. The creator and pile parts are paid as usual.
- **The payee and the wrapped coin:** the creator part's payee cannot be the clone itself (its part would come back
  in and be shared again). The clone keeps no list of wrapped coins: it counts the quote coin as the wrapped native
  coin only when `deposit()` takes the native value and the quote balance grows by exactly that value, and reverts
  otherwise. Native tax reaches the clone only through ForwardVault, which resolves WBNB from the chain itself; the
  service signs only the WBNB and tETH quotes. The splitter's rules are always in the order creator, pile, buy and
  burn, so the buy is last.
- **Which rule sets:** three parts from 0 to 10,000 summing to 10,000 (`validRules` in `sign/sign-create.js`, used
  by the service and by `pile.js create-tax-rules`; the template checks the sum and the creator payee). A part of 0
  means that rule is not there; with a pile part of 0 no pile is deployed.
- **The first tax before `createRules()`:** the trade succeeds; the token's founder payment fails inside the clone
  (making the splitter needs more gas than the token passes on) and the tax waits in the token (`feeToFounder`). Each
  later transfer tries again and costs its sender more gas (measured on the fork: a buy used 2.22M gas instead of
  0.64M, and 4.40M with a generous limit). Nothing is lost: after anyone calls `createRules()`, the next transfer pays
  everything that waited into the splitter (fork: splitter = founder tax, nothing waiting). The site calls
  `createRules()` right after a creation.
- **A stranger's pool before the migration:** OpenFour refuses token transfers to the registered pair, so it cannot
  be funded; a stranger's `sync()` with 1 wei of the quote coin in the pair does not block the migration (both quote
  coins on the fork); afterwards the splitter buys on the pool the migration seeded.
- **Stated limits:**
  - The rules can give the creator up to 100% of the tax.
  - The buy-and-burn part is owed until the migration, and for good if the token never migrates.
  - The buy has no minimum output: whoever calls `distribute()` chooses the moment.
  - Nothing runs `createRules()` or `distribute()` by itself; someone must call them.
  - On our copy we hold Core's signer and the Registry, and the Registry's owner can upgrade the kit's module beacons.
  - The kit's contracts are fetched at install and were not reviewed by us.
  - Coins other than the quote coin sent to the clone or the splitter are stranded.
- Proof on a fork: `test/RulesTax.lifecycle.test.js` (both quote paths, rules 20/50/30), `test/RulesTax.early-pair.test.js`
  (both quote paths) and `test/RulesTax.pins.test.js`. The day's on-chain steps: `scripts/rules-steps.sh`, run by
  `scripts/rules-run.sh` (with a dry mode; a step that stops inside the handover window gives Core's signer back to the
  service's key before the run ends).

## The pile (`FeeRules`)

[`../core/src/FeeRules.sol`](../core/src/FeeRules.sol), shared with our entry for another launchpad and imported as
`file:../core`. One instance per token; revenue arrives by plain transfer; `redeem(amount, minOut)` pays
`pile × amount / circulating`, rounded down (the last holder takes the rest), and sends the tokens to `0x…dEaD`.

## On BSC Testnet

Both pieces run on a developer-owned OpenFour copy on BSC Testnet (chain 97), brought up and driven by
`scripts/real-run.sh` on 25 November 2026 (19:50 to 20:00, UTC+7): 106 transactions from the run wallet
[`0xd5D5633737f2fFd8E79E0AAf008795aB43215530`](https://testnet.bscscan.com/address/0xd5D5633737f2fFd8E79E0AAf008795aB43215530), 50 of them the kit's deployment and 56 our steps, every one
verified by its own check. All addresses are in [`deployments/97.json`](deployments/97.json), written from the run's
records by `scripts/write-deployment.js`.

**The copy.** Registry [`0xB9820Ee9F400E3beD21495cf10aF6D39da1480c2`](https://testnet.bscscan.com/address/0xB9820Ee9F400E3beD21495cf10aF6D39da1480c2), Core
[`0xC7A76fEcec11e1F2290Eb60B0E14671e2FEb2f82`](https://testnet.bscscan.com/address/0xC7A76fEcec11e1F2290Eb60B0E14671e2FEb2f82), Tools [`0xB96E1091A99a9b9AD35E570c0761438cBC4236eD`](https://testnet.bscscan.com/address/0xB96E1091A99a9b9AD35E570c0761438cBC4236eD), FeeRouter
[`0x3C659B8e331f6e800313B640F56d7857ca7D7F99`](https://testnet.bscscan.com/address/0x3C659B8e331f6e800313B640F56d7857ca7D7F99). Since the run of 26 November its Core takes creation
signatures from the signing service's key `0xd2eF3c93b162977A6350ce35Fbc2e8Fb6A523A4e`; the run wallet no longer signs.

**1. The tax-vault template** [`0x9A665580052C37A235Fb3Bf914319BCD4C386036`](https://testnet.bscscan.com/address/0x9A665580052C37A235Fb3Bf914319BCD4C386036) on OpenFour's Bonding Tax V1 (preset
1778027615723): token [`0x00C80DFaC0465F10E9a8D3eFB9cEf8750a733835`](https://testnet.bscscan.com/address/0x00C80DFaC0465F10E9a8D3eFB9cEf8750a733835) (created in [`0xb8dd0aac…`](https://testnet.bscscan.com/tx/0xb8dd0aac82cc749b32e3cecb2cde4bc9beaa4892ea675bca60d94c7018565a6f)),
quote WBNB, raise 0.1 WBNB, tax 3% each way, founder share 100%; its ForwardVault clones the template into
[`0x492C16Bf3Ee5092647811f2EC4aD4c494116Bfb7`](https://testnet.bscscan.com/address/0x492C16Bf3Ee5092647811f2EC4aD4c494116Bfb7), whose pile is [`0x80E4A7FDD8bd8ADf02F41aB458f41806dB67DD73`](https://testnet.bscscan.com/address/0x80E4A7FDD8bd8ADf02F41aB458f41806dB67DD73). In
wei of WBNB, as the run's log shows:

- a curve buy of 50,000,000 tokens: the pile still at 0, the buy's tax waiting in the token (it is paid at the next
  transfer);
- a curve sell of 5,000,000 tokens: 50,167,224,080,267 into the pile; `settle`: 5,236,118,442,245 more;
- a redemption of 10,000,000 tokens: 12,311,853,893,891 paid out, the tokens burned;
- graduation in three rounds: 1,153,845,526,417,970 and 1,153,846,129,162,168 of curve tax into the pile; the token
  migrated to PancakeSwap V2;
- after graduation, DEX trades taxed in tokens: 647,377,238,781,839 into the pile when a sell settled them; a
  redemption of 100,000,000 tokens paid 302,844,483,130,363 in one transaction and its hand-in paid
  304,551,603,608,629 of waiting tax into the pile; `settle`: 133,688,969,754,878;
- a redemption of the rest (680,308,289.27 tokens): 2,395,263,419,810,547 paid out.

At the end: received 3,448,712,810,247,996 in all (the sum of the seven payments above), paid out
2,710,419,756,834,801 (the three redemptions), holding 738,293,053,413,195 for the holders still in.

**2. The Pile Bonding preset** (preset 1778027700001; Trade module implementation
[`0xB2e3C6C68b76B1cBc39311eF03433abC33558fBA`](https://testnet.bscscan.com/address/0xB2e3C6C68b76B1cBc39311eF03433abC33558fBA), validator [`0x45522cEf5F67c2eFA8FE295C348fE2626FAf0B9e`](https://testnet.bscscan.com/address/0x45522cEf5F67c2eFA8FE295C348fE2626FAf0B9e)): token
[`0x64019AEA4e0322Dc6cd4e314315Cf08385C23AfC`](https://testnet.bscscan.com/address/0x64019AEA4e0322Dc6cd4e314315Cf08385C23AfC) (created in [`0x88ea4f8f…`](https://testnet.bscscan.com/tx/0x88ea4f8fa43b5fc2681b1f6b631000a88cc430acc5bfe1de6ab8e3a2a0378b68)),
quote tETH, raise 1 tETH, fee 1% each way, pile [`0x4586b51076B99e0480bB8144B28087571358aDe0`](https://testnet.bscscan.com/address/0x4586b51076B99e0480bB8144B28087571358aDe0). A curve buy of
50,000,000 and a sell of 5,000,000 tokens; a redemption of 10,000,000 tokens paid 41,039,512,979,639; graduation in
four rounds, migrated to PancakeSwap V2; a DEX buy; a redemption of the rest (792,016,202.35 tokens) paid
7,995,257,914,360,292. At the end, in wei of tETH: received 10,034,907,456,281,636, paid out 8,036,297,427,339,931,
holding 1,998,610,028,941,705.

**Checked afterwards, read only:** `node scripts/check-real.js <the run's out/> <its log>` reads the chain through
the public endpoints: the deployment anchor holds for the run's records, both launches read Migrated, both piles
hold, received and paid out at least what the log's last status lines say (equal at the time of the run), and Core's
signer is the one the run's records call for. Before a completed `set-signer` operation that is the run wallet;
after one, exactly the address the last completed one recorded (its transaction checked on chain); an unfinished
one fails the check. The line names the case it read (output in `hackathon/evidence/SH-264.md`).

## Run it

Needs Node 18 or later and [Foundry](https://getfoundry.sh)'s `anvil` and `cast` for the local fork. Nothing global
is installed by this project.

```bash
npm install                   # also fetches the OpenFour kit at a pinned commit into node_modules/openfour-kit
npx hardhat compile
scripts/test-local.sh         # anvil fork of BSC Testnet; copy brought up with the kit's fork-deploy; 30 tests
npm run test:signer           # the signer and preflight refusals; no chain needed
scripts/rehearse-local.sh     # the real run's commands in order, signed from a throwaway keystore, gas per step
scripts/kit-smoke-local.sh    # the kit's own example presets (Bonding V1, Bonding Tax V1) on a fork
```

The OpenFour kit has no licence file and no top-level `package.json`, so it is not republished here: `npm install`
fetches it ([`scripts/fetch-kit.js`](scripts/fetch-kit.js)) and nothing of it is committed.

### The real run: checklist

OpenFour's official testnet Registry is written by Four.meme only; their kit's `fork-deploy` tool brings up a
developer-owned copy (the same implementations, new proxies; you own the Registry and are Core's signer), and that is
where the pieces run. The whole run is one list, [`scripts/steps.sh`](scripts/steps.sh); the rehearsal on a fork runs
the same list. The tax launch trades in WBNB (judges hold tBNB, and a page can wrap it), the preset launch in tETH.

**The run needs 0.16 tBNB and 1.1 tETH** in the wallet `0xd5D5633737f2fFd8E79E0AAf008795aB43215530`; a fresh
start refuses a wallet holding less. *(Changed in the last round: test BNB is scarce. The tax launch raises 0.1
WBNB, the smallest the copy's bonding validator allows; 0.15 tBNB is wrapped for it and it spent 0.095 in the
rehearsal; the whole run measured about 64M gas, 0.0064 tBNB at 0.1 gwei, 0.008 with a quarter of headroom. The
preset launch raises 1 tETH and spent at most 0.997.)*

**Before.** A fresh checkout of `bounties/openfour` with no `out/` folder; the wallet funded as above; its keystore
and password file at hand. Nothing else is set in the environment (`real-run.sh` refuses the
local-fork switch, `OPENFOUR_OUT_DIR` and a loopback endpoint outright).

**Run.** In `bounties/openfour`, after `npm install`. *(Changed in the last round: the environment is exported
once, so the direct commands below see it too.)*

```bash
export RPC_URL=https://bsc-testnet-rpc.publicnode.com
export OPENFOUR_KEYSTORE=<keystore file> OPENFOUR_KEYSTORE_PASSWORD_FILE=<password file>
scripts/real-run.sh 0xd5D5633737f2fFd8E79E0AAf008795aB43215530
```

It runs each step below and **stops unless the step exits 0 and its last line is exactly the one listed**: do not go
on by hand; read "After a stop". Rerunning `scripts/real-run.sh` is safe: a finished step prints `done before; nothing
sent` (or `... already; nothing sent`) above its OK line and sends nothing. Every action carries its `--action` id:
the same id never runs twice.

| Step | Last line, exactly | What it checked before printing it |
| --- | --- | --- |
| `kit fork` | `OK fork` | the five proxies are the contracts this attempt's first five transactions created (from the recorded start nonce), Core's signer is the wallet, and the one owner read, the Registry's, is the wallet (the other four are proven by the nonces that created them); the kit's presets and WBNB as the file says |
| `pile wrap 0.15 --action tax-wrap-1` | `OK wrap.tax-wrap-1` | the WBNB `Deposit` of exactly 0.15 in the receipt |
| `pile tax-template` | `OK tax-template` | the template's code is on chain |
| `QUOTE=$WBNB RAISE_AMOUNT=0.1 pile create-tax` | `OK create-tax` | `TokenCreated` of Bonding Tax V1 by the wallet; the clone's pile is the token's, with the vault excluded |
| `pile buy 50000000 --launch tax --action tax-buy-1` | `OK tax.tax-buy-1` | exactly 50,000,000 tokens received; no tax deferred; the quote approval back at 0 |
| `pile status --launch tax` | `OK status tax` | nothing: it prints the pile (right after a curve buy the buy's tax still waits in the token) |
| `pile sell 5000000 --launch tax --action tax-sell-1` | `OK tax.tax-sell-1` | exactly the tokens sold, at least the bound received (native tBNB counted); the founder tax dispatched in it is what reached the pile |
| `pile settle --launch tax --action tax-settle-1` | `OK tax.tax-settle-1` | `FeeDispatched`, no deferral, and the founder tax dispatched is what reached the pile |
| `pile redeem 10000000 --launch tax --action tax-redeem-1` | `OK tax.tax-redeem-1` | `Redeemed` with at least the quote; the tokens at the dead address; the approval back at 0 |
| `pile graduate 0.04 --launch tax --action tax-grad-1` | `OK tax.tax-grad-1` | each round's tokens received; the phase is Migrated; the approval back at 0 |
| `pile dex-sell 10000000 --launch tax --action tax-dex-sell-1` | `OK tax.tax-dex-sell-1` | at least the bound received from PancakeSwap |
| `pile dex-buy 0.005 --launch tax --action tax-dex-buy-1` | `OK tax.tax-dex-buy-1` | at least the net bound of tokens received |
| `pile redeem 100000000 --launch tax --action tax-redeem-2` | `OK tax.tax-redeem-2` | one transaction: paid the quote, and the tax its hand-in dispatched reached the pile |
| `pile dex-sell ... tax-dex-sell-2`, `pile settle ... tax-settle-2`, `pile redeem all ... tax-redeem-3`, `pile status --launch tax` | `OK <the action id>` / `OK status tax` | as above |
| `pile register` | `OK register` | the Registry reads back the module, the preset and its fee configuration as written |
| `QUOTE=$TETH RAISE_AMOUNT=1 pile create` | `OK create` | `TokenCreated` of the Pile Bonding preset by the wallet |
| `pile buy / sell / redeem / graduate / dex-buy / redeem all ... --launch preset --action preset-...` | `OK preset.<action id>` | as for the tax launch |
| `pile status --launch preset` | `OK status preset` | nothing: it prints |

**After the run**, for creation from the site (sign/README.md): make the signing service's key (a keystore of its
own: `hack-foursigner` on the machine), then, with the run's keystore variables set as for the run, `node -r
./scripts/signer-preload.js scripts/pile.js set-signer --keystore ~/.foundry/keystores/hack-foursigner
--password-file ~/.secrets/hack-foursigner.pass --expect-signer 0xd5D5633737f2fFd8E79E0AAf008795aB43215530`; last
line `OK set-signer`. From then on this wallet no longer signs creations. The target is derived by decrypting the
service keystore (only its address is kept, and printed before sending); the service proves it again at startup.
`set-signer <0x address>` stays for a key without a keystore file there. *(Changed in the last rounds: each target
is its own operation; `OK set-signer` comes only after Core's signer reads that address; Core comes from the
anchored deployment. Refused as targets on a real run: the wallet itself and the 81 addresses of the public test
mnemonic at indices 0 to 19 and 4240 to 4300; any other public key is not on that list, which is why the target
comes from the service keystore.)*

**After a stop** (the exit code is printed):

- **2, refused input**: something in the environment, the command or `out/` is not as it must be (the message names
  it). Fix that; rerun `scripts/real-run.sh`. *(Changed: exit 2 can come after earlier transactions of the same
  step, e.g. inside `register`; look at `out/ops/` before assuming nothing was sent.)* `out/.lock exists`: check that no run is active, then
  remove `out/.lock`.
- **3, no answer or no receipt in time**: the message names the hash. Look it up on the other endpoint
  (`https://bsc-testnet.publicnode.com`) or on testnet.bscscan.com. Then rerun `scripts/real-run.sh`: the step finds
  its recorded transaction (or sends the same signed bytes again) and never signs a second one. (This holds for
  `pile` steps; for `kit fork` see below.)
- **4, an earlier operation was finished first**: an interrupted operation was finished and its check run; the
  requested step was not run. Rerun `scripts/real-run.sh`.
- **1 with "reverted on chain"**, then **5** on every later run: the transaction reverted. Look it up; then
  `node -r ./scripts/signer-preload.js scripts/pile.js resolve <operation> --expect-signer
  0xd5D5633737f2fFd8E79E0AAf008795aB43215530` sets it aside, and the rerun sends that step anew. **5** without a
  revert: the transaction's nonce looked used by another transaction; the same `resolve`. *(Changed: `resolve` sets an
  operation aside ONLY on proof: a failed receipt of its own hash, or a different transaction of the wallet mined at
  its nonce, which it finds and prints. Without proof it exits 3 and leaves the operation open: look again later.)*
- **1, a check failed**: the message says which. Do not go on; the records in `out/` show where the run stands.
- **`kit fork` stopped** (any code): rerun `scripts/real-run.sh`. *(Changed: "inconclusive" with code 3 means a
  lookup failed or a receipt was not found on this endpoint: retry later, never abandon on it.)* A copy the kit completed is recovered from this
  attempt's records and the kit's file after the chain confirms it (nothing sent). A copy stopped halfway is refused
  with code 5; to abandon it and bring up a new copy (about 0.0034 tBNB), run exactly
  `node -r ./scripts/signer-preload.js scripts/kit.js fork --expect-signer 0xd5D5633737f2fFd8E79E0AAf008795aB43215530 --fresh-copy`,
  then rerun `scripts/real-run.sh`.

What every command checks first: the signer comes only from the keystore pair (a `DEPLOYER_PRIVATE_KEY` or a
`.env` stops the run); the endpoint is one of `https://bsc-testnet-rpc.publicnode.com` and
`https://bsc-testnet.publicnode.com`, chain 97; the wallet equals the expected address and is not a public test key;
the kit's other inputs (`BSC_TESTNET_RPC_URL`, `DRY_RUN`, `PROXY_DEPLOY_TX`, `REBATE_ADDRESS`, `SIH_POOL_MANAGER`,
`SOURCE_DEPLOYMENT`, `TREASURY_ADDRESS`, `SIGNER_ADDRESS`, `PRESET_AUTHOR`, `DOTENV_KEY`, `DOTENV_CONFIG_PATH`) and
`OPENFOUR_GAS_PRICE_WEI` and `OPENFOUR_OUT_DIR` are refused when present; the price is `eth_gasPrice` read now;
every request to the endpoint gives up after 45 seconds; one run at a time (`out/.lock`, never taken over). Every
record in `out/` names the endpoint, the chain's block-1 hash, the wallet and the copy's Registry, and another run's or
copy's record (a deployment file, a plan, an operation) is refused. Every transaction is signed and recorded before it
is broadcast, and marked verified only by its own check (for setup steps: the chain's read-back). Bounds come from
quotes of the net output and are above zero; approvals are for the exact amount, and an action completes only when
its allowance reads zero. Quote coins must have 18 decimals. Tax-token transactions carry fixed gas limits (8M; 12M
for its creation): at 0.1 gwei at most 0.0008 and 0.0012 tBNB each, only the gas used is paid.

### Limits of this tool

This is a tool one operator runs once, on a test network, with a wallet of test coins. What it does not cover, and
what the operator does about it:

- **A kit deployment stopped halfway** is abandoned, not resumed (the kit's own sends are not journaled). Rerun; on
  code 5 use the exact `--fresh-copy` command above (about 0.0034 tBNB).
- **The kit's send and wait have separate time limits** (45 s each, not one shared deadline). A kit step that times
  out has an unknown outcome: rerun `real-run.sh`, which checks the chain before anything else.
- **The kit reads its key from its own process environment** (no child process at the pinned commit). Run the kit
  only through `scripts/kit.js`.
- **The kit's input list** that the preflight refuses was read from the kit's source at the pinned commit. Install
  only with `npm install`.
- **The kit presets are checked as registered and open**, not by their full definition. Use only a copy this run
  made (the deployment anchor already refuses any other).
- **A WBNB sell's native proceeds** are measured as the wallet's balance change in the sell's block (gas added back),
  so a payment from someone else in the same block would count. Never send to this wallet during the run.
- **The native check needs the endpoint's recent balance history.** Rerun promptly after a stop.
- **A replaced transaction** is found by searching the last 20,000 blocks of the endpoint's state. If it cannot be
  found, `resolve` leaves the operation open: look the wallet's history up on bscscan and try again later.
- **Stray coins in a tax-vault clone whose quote is not WBNB** stay there. The run uses WBNB for the tax launch.
- **The signing function reads a request's fields more than once.** A parsed JSON body cannot change between reads;
  pass only parsed JSON to it.
- **Some tests would still pass with the guard they describe removed** (listed in the evidence). The rehearsal
  exercises the real commands end to end; read its proofs, not only the counts.

### For a launch page

ABIs are in [`abi/`](abi). Creating a token needs a signature from Core's signer (OpenFour's design; in production
Four.meme's API signs), so on a developer-owned copy tokens are created by `pile.js` or by a signing service of the
copy's owner. Everything else is open to anyone: `Tools.getPresetEncodeSchemas`, `estimateBuy`,
`estimateBuyByBudget`, `estimateSell`; `Core.buy`, `buyByBudget`, `sell`; the pile's `pile()`,
`circulatingSupply()`, `quoteRedeem(amount)`, `redeem(amount, minOut)`; its events `RevenueRecognised` and
`Redeemed`. Give tax-token transactions an explicit gas limit (see below). With WBNB as the quote coin a curve buy
pulls WBNB (approve it to Core), but a curve sell pays its proceeds in native tBNB (measured on the fork); the pile
and the DEX pay in WBNB. A visitor who holds tBNB wraps it first (`WBNB.deposit`, `pile.js wrap` here).

## For the reviewer

Every state-changing function of ours, and who may call it:

| Contract | Function | Who | What it can do |
| --- | --- | --- | --- |
| `PileTaxVault` (clone) | `initialize(token, quote, owner, roles, params)` | once, ForwardVault while cloning | binds token and quote; sets the type id; renounces ownership |
| | `createPile()` | anyone; effective once | creates the pile after the token exists (reverts before); excludes the token's vault |
| | `receive()` | anyone | wraps the clone's whole native balance (wrapped-native quote only; else refused) and pushes everything held into the pile |
| | `onERC20TaxReceived(asset, amount)` | the token or the ForwardVault only; quote coin only | pushes everything held into the pile |
| | `flush()` | anyone | wraps any native balance when the quote is wrapped native, pushes the quote held into the pile, nowhere else |
| | `updateShares`, `transferOwnership`, `renounceOwnership` | inherited | no-op; owner is zero after `initialize`, so nobody |
| `PileTradeModule` (clone) | `init(token, fourCore, params, version)` | once, OpenFour Core at creation | binds the token, fixes the fee rates, creates the pile |
| `PilePresetValidator` | none | | |
| `FeeRules` (pile) | `redeem`, `redeemTo` | any holder but an excluded one | hands tokens to `0x…dEaD`, pays the quoted share |
| | `sync()` | anyone | emits an event; moves nothing |

What nobody can change after creation: the pile's token, coin and excluded holder; the pile's redemption rule; the
template behind a token's ForwardVault (OpenFour's rule); the clone's pile; the Pile Bonding fee rates of a token.
Nothing of ours has an owner, a setter, a pause, an upgrade path or a withdrawal.

What depends on OpenFour itself: the Registry owner (Four.meme on OpenFour; the deployer on a copy) can upgrade module
beacons, which could change `PileTradeModule`'s code for existing tokens; it cannot touch a pile, which is a plain
contract created per token. The tax token's own rates are fixed by OpenFour's `TaxToken` at creation.

Properties the tests pin, on a fork of BSC Testnet with a copy brought up by the kit's own tool:

- template, both quote paths (an ERC-20 of our own; WBNB with native tax): ForwardVault clones it; the clone has no
  owner and `authorWallet` DEAD; the pile excludes exactly the token's vault; `createPile()` twice gives one pile;
  every unit paid to the founder is in the pile (`pile.totalReceived() == TaxToken.feeFounder()`, no quote and no
  native left in ForwardVault or the clone, nothing deferred); after graduation each DEX sell and buy is taxed 3% on
  its own and the tax reaches the pile; every redemption moves exactly the tokens handed in to the dead address;
  a second `initialize` and an owner call fail with their exact reasons;
- template on its own: what the pile receives is what `TaxToPile` reports, also for a quote coin with a transfer fee;
  `flush()` wraps native that arrived without a call; native is refused for a plain quote; `createPile()` is refused
  before the token has a vault;
- preset: every slot but Trade equals Bonding V1, `customDataId` included; each buy and sell pays
  `realised curve quote × rate / 10000` into the pile to the last unit (the curve quote the vault booked); a buy fee
  above 10%, a sell fee above 10% and two zero fees are each refused with their own reason; a curve trade after
  graduation fails with OpenFour's `CoreErrBadPhase()`; a second `init` fails with its exact reason;
- the signer and preflight refusals (`test-node/signer.test.js`, 11 cases);
- both: during the sale circulating supply equals the tokens in traders' hands; after graduation it equals the
  holders' tokens plus the pair's; every redemption pays `pile × amount / circulating` to the last unit and burns the
  tokens.

Interactions worth knowing:

- **TaxToken does its tax work inside transfers.** After graduation a wallet-to-wallet transfer swaps the
  accumulated DEX tax and pays the founder, here the pile. The pile's hand-in is such a transfer: the pile fixes the
  payout BEFORE the hand-in (from the pile and circulating supply as they were) and accepts a pile that grows during
  it, so the redemption succeeds in one transaction and the tax it dispatched stays for the other holders (tested).
  To pay pending tax in without redeeming, any transfer does it, e.g. a zero-amount self-transfer (`pile.js settle`).
  On the fork an explicit `dispatchTax()` deferred that swap ("TransferHelper: TRANSFER_FROM_…") where a transfer
  performed it.
- **Gas estimates on the tax token can be short**: it runs swaps in try/catch, and an estimate can settle on the
  cheaper catch branch. Tax-token transactions here carry fixed limits (see "On BSC Testnet").
- **ForwardVault does run on chain 97**: the developer guide says it initialises only on chains 56 and 4663, but
  `contracts/taxvault/vaults/ForwardVault.sol` maps chain 97 to WBNB, and the tests use the copy's live
  implementation.

## What is NOT done

- **Not on OpenFour's official Registry.** Registration there is Four.meme's; this runs on a developer-owned copy made
  with their kit. The template and the preset are ready to submit.
- **18-decimal quote coins only tested.** Creation amounts are encoded with 18 decimals, as in the kit.
- **No audit.** The contracts are unaudited demo code. (The launch pages are in `../app`, served by the site at
  `/launches/`.)
