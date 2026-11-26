# flap-redeploy: the corrected Flap set on the BNB test network (SH-308)

`commands.txt` (written by `make-commands.py`; change the generator, never the file by hand) has two parts.

**Part A, steps 1 to 33.** It deploys the set corrected after Flap's pre-audit, with the Portal
(0x000042108465206185A077Edc3F3fd2b49060000) and the tax-token implementation
(0x7777c57ff7dc441c1715b2e36fa581c48B782222) of today's files. The set:
- R1: the anti-scam list asked at creation; the test network's module 0x5CfbE713d070e87F67D1bc84312B7eB8Fe4F2B5E is
  every launcher factory's fourth constructor argument.
- R2: the swap guard on the splitter's buy and burn and on the shop's refill, Flap's fix as written: a cap per buy,
  a nonzero minimum, at most one buy a minute per contract.
- R3: each vault factory paired with one launcher factory; no direct `createLauncher`.
- R4: piles and splitters as beacon proxies, upgradeable by Flap's Guardian only.

Part A then runs ONE rules sale end to end on the new BNB rules factory as the proof on chain: "Proof Jar" (PJAR),
rules creator 10% (hack-deployer), pile 60%, buy and burn 30%.

**Part B, steps 34 to 42.** One minimal launch on each of the other three pairs, so that each vault factory has a real
launched token for Flap's vault UI bindings:
- "Proof Pile" (PPILE) on the BNB pile pair;
- "Proof Pile Dollar" (PPUSD) on the test-dollar pile pair;
- "Proof Jar Dollar" (PJUSD, rules 10/60/30) on the test-dollar rules pair.

Part B reads only part A's deployment files: it runs on its own after part A (`... 34 42`) and does not depend on part
A's waits. Each sale writes its own new file, so a failure in part B leaves part A's records untouched.

It is for the step runner, like `hackathon/flap-rules/commands.txt`: steps `# <n> <what>`, a dry line before every
send, check lines ending in `# expect <text>`. It runs from the repository root of the merged tree, after
`forge build` in `bounties/flap` and `bounties/core`:

    RPC=https://bsc-testnet-rpc.publicnode.com bash run-steps2.sh hackathon/flap-redeploy/commands.txt 1 33
    RPC=https://bsc-testnet-rpc.publicnode.com bash run-steps2.sh hackathon/flap-redeploy/commands.txt 34 42

## Cost

Measured in the rehearsal and printed by step 42: see "spent by hack-deployer" in the evidence. The deployer also
needs test USDT for part B's two test-dollar raises of 50 each plus fees; step 35 mints 200, because Flap's test
USDT mints openly.

## What it deploys

| step | script | transactions | new file (never today's) |
|---|---|---|---|
| 2 | `Deploy.s.sol` | PileVaultFactory (naming the next address; it creates its beacon and PileVault implementation), CurveLauncherFactory | `bounties/flap/deployments/97-v2.json` |
| 3 | `DeployToken.s.sol` | TokenPileVaultFactory, TokenCurveLauncherFactory | `97-v2-usdt.json` |
| 4 | `DeployRules.s.sol` VARIANT=native | RulesVaultFactory (two beacons: the RulesVault and the PileVault), RulesCurveLauncherFactory | `97-v2-rules-native.json` |
| 5 | `DeployRules.s.sol` VARIANT=usdt | the same for the test dollar | `97-v2-rules-usdt.json` |
| 6 | `DeployRailShopFactory.s.sol` (bounties/core) | RailShopFactory with the guarded refill | `bounties/core/deployments/97-v2-rail-shop.json` |
| 7 | `DeployStake.s.sol` | RailStakeFactory of this tree (today's predates RailStake's later changes) | `97-v2-stake.json` |
| 8-11 | Flap's helper `whitelist(factory, 0)` | one each | none |
| 15 | `CreateRulesSale.s.sol` | setRules, Portal.newLauncher | `97-v2-rules-native-sale.json` |
| 36, 38, 40 | `CreateSale.s.sol`, `CreateTokenSale.s.sol`, `CreateRulesSale.s.sol` | one sale each | `97-v2-pile-sale.json`, `97-v2-usdt-sale.json`, `97-v2-rules-usdt-sale.json` |

- **Pairing.** Each pair is two consecutive transactions of hack-deployer: the vault factory names the deployer's next
  CREATE address, and the launcher factory lands there. NOTHING ELSE may send from hack-deployer while steps 2 to 5
  run: one transaction in between and the launcher factory's constructor refuses the pair (no money lost; run the
  step again, which deploys a new pair).
- **If a deploy step stops between its two transactions.** The step's check lines tell which state you are in, read
  against the step's file:
  - **both `code`:** the pair is complete;
  - **the vault factory `code`, the launcher factory `none`:** only the vault factory landed;
  - **both `none`:** nothing landed.

  When only the vault factory landed:
  - **If hack-deployer has sent nothing since,** continue the same step's send line with forge's `--resume` added
    (same command, same environment). Forge sends the recorded second transaction at the reserved nonce and the pair
    completes; then run the step's check lines.
  - **Otherwise the pair is dead.** The vault factory names an address no launcher factory can ever have; it holds no
    money and serves no launch. Run the step again: its guard lets it through (the file's launcher factory has no
    code) and it deploys a NEW pair at the deployer's current nonce, overwriting only that step's 97-v2 file.

  The deploy scripts refuse the old resume inputs `PILE_VAULT_FACTORY` and `PILE_VAULT_FACTORY_NONCE`.
- **A step never sends twice.** Steps 2 to 7 start with a guard that refuses when the step's file names a factory with
  code. After a dry run, the file names a simulated address without code, so the guard lets the step through.
- **Today's files.** The 97*.json files in bounties/flap/deployments and bounties/core/deployments are fingerprinted in
  step 1 and compared in steps 33 and 42.
- **The stake factory is redeployed (step 7).** Today's RailStakeFactory predates later changes to RailStake (its
  `STAKE_CODE_HASH` differs from this tree's build); step 7 checks the new one's `STAKE_CODE_HASH` against the build.

## Part A's proof sale (steps 12 to 33), and what a reader sees on chain

| step | what is sent | what a reader sees on chain |
|---|---|---|
| 12, 13 | 0.06 tBNB each to alice and bob | the balances |
| 14 | nothing (a dry call of the creation with the name "USDT") | nothing; the dry call prints `name on the Portal's anti-scam list` |
| 15 | `setRules`, then `Portal.newLauncher` | `RulesSet` at the new rules factory; Flap's `FlapNewLauncherCreated` and our `CurveLauncherCreated` (viaPortal true); `getLauncher(launcher)` names the new factory |
| 16-18 | alice and bob buy, alice sells 10,000,000 back on the curve | `Bought` and `Sold` on the Launcher |
| 19 | the completing buy | the launch: the token, its pool, Flap's launch event, our `RulesVaultCreated(token, splitter, pile, launcher)`; the splitter and the pile are beacon proxies |
| 20-22 | three claims | `Claimed`, token balances |
| 23-25 | three pool trades: buy, sell, buy | swaps on the pair; the tax builds up in the token's tax processor |
| 26 | the dispatch | the processor's vault share arrives at the splitter (zero if Flap's keeper dispatched first) |
| 27 | nothing (reads): the pair's WBNB reserve | written to `.cache/flap-redeploy` |
| 28 | share-out 1 | `IncomeRecognised`, `PartOwed` for each rule; `Delivered` to the creator and the pile; a swap on the pair of one slice (5 bps of the WBNB reserve, or the whole burn part if smaller), tokens to the dead address, `Delivered(2, slice, burned)`; a burn part above the slice stays owed (`LeftOwed(2, ...)`) |
| 29 | nothing: waits until the chain's time is 75 s past share-out 1 | nothing |
| 30 | nothing (reads): the reserve, the owed burn part, what was bought | the next slice = min(owed, 5 bps of the reserve) is written to `.cache/flap-redeploy` |
| 31 | share-out 2 | a swap of exactly that slice; more tokens at the dead address (`burned(2)` grew); the rest still owed |
| 32 | alice redeems 1,000,000 tokens from the pile | tokens to the dead address; the pile pays her |
| 33 | nothing (reads) | today's files unchanged; the splitter's ERC-1967 beacon slot names the rules factory's beacon |

- **Why no trade of ours falls between the share-outs.** The three pool trades come BEFORE the first share-out, and
  nothing of this file trades Proof Jar between the share-outs. The check lines compute each slice from the reserve
  read just before the share-out. A trade in between would move that reserve and the computed slice would no longer
  be the one bought.
- **Waiting.** Like the short-wait file, the wait is a loop over the chain's own time (`cast block latest -f
  timestamp`), with a timeout on each read. The time of each buying share-out is written right after it, and the loop
  ends 75 s later, at most 5 minutes. The swap guard buys at most once a minute per contract; a share-out inside the
  minute pays the other rules and buys nothing.
- **Other buyers.** If Flap's keeper dispatches new tax in between, the burn part grows. The check lines allow that:
  - share-out 1 must have bought min(burn part, 5 bps of the reserve);
  - share-out 2 must have bought exactly the slice computed from the reserve and the owed part read just before, and
    the part still owed must be at least what was owed less the slice.

## The card shop factory (step 6)

RailShop's `refill` now carries the swap guard (Flap's R2 names it): it buys min(waiting, 5 bps of the reserve) at
most once a minute, or reverts. So the set includes a new RailShopFactory with the same routers and card collections. A rules sale with a shop part would name a shop of THIS factory: `jq -r
.factory bounties/core/deployments/97-v2-rail-shop.json`. The proof sales make no shop and no stake.

## Part B (steps 34 to 42)

- **The smallest raises.** 0.05 BNB on the BNB pile pair; 50 test USDT on each test-dollar pair (virtual 4 times the
  raise). With each launcher factory enabled at multiplier 0 by Flap's helper (steps 8 to 11), the Portal's
  creation floor is zero for it (`liquidityFloor` answers a required USD of 0). The limits left are our own
  checkConfig's:
  - at least one whole token in the pool;
  - a supply of 100 to 1e15 tokens;
  - a raise within one millionth of its target.
  A 0.05 BNB sale at multiplier 0 launched in the fork test `test_portal_launcherMultiplierZero_smallSaleLaunches`.
- **What a reader sees:** per pair, the creation (Flap's `FlapNewLauncherCreated`, our creation event), then the
  launch (a token ending in 7777, its pool, its vault). The check lines read:
  - `phase() == 1`;
  - the Portal's `getLaunchVault(token)` naming the launcher's vault;
  - `getLauncher(launcher)` naming the launcher's own factory;
  - the vault factory's own record of the vault (`predictVault` for the pile pairs, `vaultOf` for the rules pair);
  - for the rules pair, the vault's `pileOf(token)` and `ruleCount() == 3`.

## Regenerating the file

The file pins no bytecode, code hash or address: every expectation is computed from the chain when its line runs
(the reserve, the owed part, the slice). After any change to the contracts, one command from the repository root
rewrites it:

    python3 hackathon/flap-redeploy/make-commands.py

A change of the guard's numbers (5 bps, 60 s) needs the same constants changed in `make-commands.py` (`* 5 // 10000`
and the 75 s wait).

## What the file depends on

- **Behaviour:**
  - the four launcher factories, the three vault factories and their implementations;
  - the swap guard (`bounties/core/src/PairPriceGuard.sol`: at most 5 bps of the quote reserve per buy, at most one
    buy a minute per contract).
- **Scripts:** `Deploy.s.sol`, `DeployToken.s.sol`, `DeployRules.s.sol`, `CreateRulesSale.s.sol`, `CreateSale.s.sol`,
  `CreateTokenSale.s.sol`, `Sale.s.sol`, `TokenSale.s.sol`, `RulesSale.s.sol`, and bounties/core's
  `DeployRailShopFactory.s.sol`; `DeployStake.s.sol`.
- **Constructor arguments:** fixed in the scripts: Portal, tokenImpl, router 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3,
  test USDT 0x190C989D5665a0e404B444b53CAE9AbCfb600157, the anti-scam module.

## Rehearsal

The file was rehearsed on anvil forks of the test network, with the three wallets impersonated (no keystore; sends
made `--unlocked`) and `--block-time 1` so the chain's time moves while the file waits. Parts A and B were run on the
merged tree.

The results and the blocks are in `hackathon/evidence/SH-308.md`.

## For the founder: the addresses and transactions after the real run

Filled from the files the run writes (one command per row, from the repository root):

| what | where |
|---|---|
| BNB pile pair: CurveLauncherFactory, PileVaultFactory | `jq -r '.curveLauncherFactory, .pileVaultFactory' bounties/flap/deployments/97-v2.json` |
| test-dollar pile pair | `jq -r '.tokenCurveLauncherFactory, .tokenPileVaultFactory' bounties/flap/deployments/97-v2-usdt.json` |
| BNB rules pair, beacons | `jq -r '.launcherFactory, .rulesVaultFactory, .beacon, .pileBeacon' bounties/flap/deployments/97-v2-rules-native.json` |
| test-dollar rules pair, beacons | `jq -r '.launcherFactory, .rulesVaultFactory, .beacon, .pileBeacon' bounties/flap/deployments/97-v2-rules-usdt.json` |
| the pile factories' beacons and every implementation | `cast call <vault factory> 'beacon()(address)'` and `'beaconImplementation()(address)'` (rules factories also `'pileBeaconImplementation()(address)'`) |
| card shop factory | `jq -r .factory bounties/core/deployments/97-v2-rail-shop.json` |
| stake factory | `jq -r .factory bounties/flap/deployments/97-v2-stake.json` |
| the four sales: token, launcher | `jq -r '.token, .launcher'` of `97-v2-rules-native-sale.json` (Proof Jar), `97-v2-pile-sale.json` (Proof Pile), `97-v2-usdt-sale.json` (Proof Pile Dollar), `97-v2-rules-usdt-sale.json` (Proof Jar Dollar) |
| the four sales: vault | `cast call <launcher> 'pileVault()(address)'` (for the pile pairs the vault IS the pile) |
| the two rules sales: pile | `cast call <vault> 'pileOf(address)(address)' <token>` |

**Transaction hashes:** forge prints none for broadcasts on this network, but it writes every transaction with its
hash and receipt to `bounties/flap/broadcast/<Script>.s.sol/97/run-<time>.json` (and `run-latest.json`), and to
`bounties/core/broadcast/DeployRailShopFactory.s.sol/97/` for the shop factory. One line lists them all:

    jq -r '.transactions[] | [.transactionType, .contractName // .function // "", .hash] | @tsv' bounties/flap/broadcast/*/97/run-1*.json bounties/core/broadcast/*/97/run-1*.json

The cast sends (Flap's helper, the gas to alice and bob) print their hash in the runner's log of that step.
