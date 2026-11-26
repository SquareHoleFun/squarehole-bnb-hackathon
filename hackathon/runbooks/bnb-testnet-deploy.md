# Runbook: the platform on BNB Chain testnet (chain id 97)

For the orchestrator's real run. Every command runs on the hackathon machine, in a folder that holds this branch
merged and the contract build (forge must say "No files changed" or compile only the `script/bnb/` files).

**The key:**
- It reaches forge as the keystore `hack-deployer` plus its password file, both on the machine. Neither ever appears on
  a command line as a key, nor in a file of the repository.
- The driver (`packages/contracts/script/bnb/bnb-testnet.mjs`) never opens the password file: it hands the path to forge.
- cast gets only `PATH`, `HOME`, `USER`, `LANG` and `TMPDIR` from this process's environment. forge gets the same
  five plus exactly two settings the driver sets itself, neither of them a credential:
  - `FOUNDRY_LINT_LINT_ON_BUILD=false`: forge's linter takes tens of GB on the release's hook when it lints on build.
  - `FOUNDRY_BROADCAST=<the attempt's own record folder>`: each attempt's transaction record goes into its own folder,
    so no run can overwrite another's.
- `--account` takes a plain keystore name only.

**Endpoints:** a real run (`deploy`, `files --write-repo`) accepts only these, and only when they answer chain id 97:
`https://bsc-testnet-rpc.publicnode.com`, `https://bsc-testnet-dataseed.bnbchain.org`,
`https://bsc-testnet.bnbchain.org`, `https://bsc-prebsc-dataseed.bnbchain.org`.

- Deployer (lister, owner of both holding contracts): `0x2EF9A78074bbf674bEA16f21154a30c821A3C576`
- Keeper's wallet (fixed trigger of every converter route): `0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189`
- RPC: `https://bsc-testnet-rpc.publicnode.com` (its eth_getLogs allows ranges of 50,000 blocks; the bnbchain dataseed
  endpoints refuse eth_getLogs)
- Explorer: `https://testnet.bscscan.com/address/<address>` and `https://testnet.bscscan.com/tx/<hash>`
- Gas price: 0.1 gwei; forge sends legacy transactions with `--with-gas-price 100000000`. The chain runs the `osaka`
  rules, with a cap of 16,777,216 gas per transaction; our largest gas limit is 7,745,860.

**Status on 25 November:** steps 1 to 4 were run for real by the orchestrator from commit 9f5056a8 (folder
`~/work/real`). Steps 5 to 8 and the files step run with this fixed driver on the same state file
(`.cache/bnb-testnet/97-state.json`). A state file without the newer fields (the pending marker) loads as it is.

## 0. Before anything is sent

```
cd <folder>/packages/contracts
export RPC=https://bsc-testnet-rpc.publicnode.com
node --experimental-transform-types script/bnb/bnb-testnet.mjs probe --rpc-url $RPC
```

The probe stops at once if the endpoint is not chain 97. Otherwise it prints, read-only:
- chain id 97 and the gas price;
- the deployer's nonce and balance;
- WBNB's code size (3,124);
- no code at chain 56's PoolManager address (0);
- `clzOfOne: 255` (Osaka);
- `drand.verified: true` (the chain's own precompiles verify a real drand round).

**The deployer's nonce must be 0 before step 1** for the predicted addresses below to come out. A different nonce works
as well, but gives other addresses.

## 1. Money

Measured in the plain rehearsal of the second fix round: 91 transactions, 136,130,822 gas. Pools now take 21
transactions: an allowance is cleared only when one is left, and a pair consumes its allowance in full. The real run
of steps 5 to 8 used the earlier pools script: 31 transactions, 3,098,921 gas. Listings on the fork take 18,990 gas
more; the refusal uses the fork's figure. Before each step the driver refuses to send when the wallet holds
less than that step's rehearsal gas at 0.1 gwei plus the BNB it sends, plus 10%, rounded up in wei. It prints both
amounts with all 18 decimals.

| # | Step | Transactions | Gas | tBNB (gas + sent) | Running tBNB | The driver refuses below (tBNB, exact) |
|---|---|---:|---:|---:|---:|---:|
| 1 | dependencies | 6 | 10,932,186 | 0.001093 | 0.001093 | 0.00120254046 |
| 2 | release | 39 | 95,338,087 | 0.009533 | 0.010627 | **0.01048718957** |
| 3 | coins | 5 | 3,869,808 | 0.000386 | 0.011014 | 0.00042567888 |
| 4 | routes (all three) | 6 | 14,720,293 | 0.001472 | 0.012486 | 0.00161923223 |
| 5 | listings | 11 | 3,826,075 | 0.000382 | 0.012868 | 0.00042295715 |
| 6 | helpers | 2 | 4,569,139 | 0.000456 | 0.013325 | 0.00050260529 |
| 7 | pools | 21 | 2,828,230 | 0.000282 + 0.000200 sent | 0.013808 | 0.0005311053 |
| 8 | faucet | 1 | 47,004 | 0.000004 | 0.013813 | 0.00000517044 |
| | total | 91 | 136,130,822 | **0.013813** | | plus 50%: 0.020719 |

- **Fund at least 0.0105 tBNB before the release.** A release that runs dry in the middle has to be paid again from its
  start (see section 4).
- **Routes:** one BNB route needs 0.00053963998 (module plus registration, 4,905,818 gas); the tUSDC route needs
  0.00053995227 (4,908,657 gas). A subset is priced as the sum of its own routes.
- **Pools:** the value part grows with `--bnb-per-pool` (two native pools).
- **`--skip-balance-check`** is accepted only with `--resume`. An extra step needs `--extra-budget <wei>`.

Instalments:

| Wallet holds | What it buys | What it starts |
|---|---|---|
| 0.005 tBNB | steps 1 and 3 (0.001479); the release does not fit | no clock |
| 0.012 tBNB | steps 1, 2, 3 (0.011014), plus one route with `--routes 1` (BNB to tNVDA, 0.000491): 0.011505. Two routes would leave the wallet under the 10% margin | the release modules' clock and the BNB-to-tNVDA route's clock |
| 0.02 tBNB | all eight steps (0.013840), with 0.006 left for the demo | everything |

Other costs:
- **Funding the keeper's wallet:** send it 0.002 tBNB (one transfer, 21,000 gas). This is an estimate; lane b measures
  the keeper's own calls.
- **Creating one demo box:** 2,460,627 gas = 0.000246 tBNB, plus the box's bootstrap and creator buy (BNB box at
  raise 0.001: 0.0000104 BNB). A coin-priced box adds two approvals: 2,566,842 gas = 0.000257 tBNB.
- **Filling a raise of 0.001 in the native coin:** about 0.0012 BNB sent plus 1,992,455 gas (0.000199 tBNB) for a buy,
  a sell, the fill, graduation and one more trade. That is about 0.0014 tBNB, by one wallet or by several.

## 2. The clock

The fee-module directory makes a module selectable only **one day** (86,400 s, `FeeModuleDirectoryV21.DELAY`) after
its registration. The rules come from the code:
- **Directory ids 0 to 3** belong to the release's own modules, registered when the release deploys the directory:
  0 eat (choice `EatPriceCoin`), 1 holders paid in the box's own token (choice `HoldersT`), 2 items paid in the box's
  own token (`ItemsT`), 3 pile of the box's price coin (`Pile`, whose pile asset must be the price coin:
  `ReceiverViews.sol`).
  - `BoxReceiverV2._verifyBuiltin` asks `initialSelectable(choice - 6)` for choices 6 to 9 only.
- **A converter route** is a custom module (choice `Module`, 10). The box names its directory id, and the factory
  checks that row's `readyAt` (`FeeModuleProofV21`).
- **These choices wait for nothing:** `Keep`, `Burn`, `Grow`, `Holders` (holders paid in the PRICE coin), `Items` (in
  the price coin) and `ShopT` (`BoxFactoryV2Parts._choice`).

Read each `readyAt` from the directory (`record(id)`, or `97-extras.json` written by the files step); never derive it
from the order of registration. A route added later gets the next id and its own day.

| Demo box | Its fee choice | What it waits for | Earliest creation |
|---|---|---|---|
| Stock box priced in tNVDA, holders paid in tNVDA | `Holders` (paid in the price coin, tNVDA) | nothing | right after step 5 (listings) |
| Pile box priced in BNB whose fees buy tNVDA (or tGOLD) into its pile | `Module`: the converter route BNB to tNVDA (or BNB to tGOLD) | that route's `readyAt` | the route's registration + 24 h |
| Box priced in tUSDC whose fees buy tNVDA | `Module`: the route tUSDC to tNVDA | that route's `readyAt` | its registration + 24 h |
| Rent Free, the card shop, any box with keep, grow, burn, holders or items in the price coin, or the shop | none of 6 to 10 | nothing | right after step 5 |
| A box that pays holders or items in its own token, or eats, or piles its own price coin | `HoldersT`, `ItemsT`, `EatPriceCoin` or `Pile` | release id 1, 2, 0 or 3 | the release's directory block + 24 h |

Deadlines: demo-ready on Thursday 26 November at about 18:00 +07, submission on Friday 27 November at 09:00 +07. A
route whose box must exist by Thursday 18:00 has to be registered by Wednesday 25 November 18:00 +07; for Friday
09:00, by Thursday 09:00.

## 3. The steps

Run each step DETACHED, so a dropped session cannot stop forge in the middle. Then read its log. One step at a time;
the next only after the last one printed `done`.

```
cd <folder>/packages/contracts
export RPC=https://bsc-testnet-rpc.publicnode.com
mkdir -p ../../.cache/bnb-testnet/logs
STEP=listings   # steps 1 to 4 are done; then helpers, pools, faucet
nohup node --experimental-transform-types script/bnb/bnb-testnet.mjs deploy --rpc-url $RPC \
  --account hack-deployer --password-file ~/.secrets/hack-deployer.pass --steps $STEP \
  > ../../.cache/bnb-testnet/logs/run-$STEP.log 2>&1 &
tail -n 30 ../../.cache/bnb-testnet/logs/run-$STEP.log
```

What happens on each run:
- **First line:** `<step>: deployer nonce N, balance X tBNB`.
- **Too little money:** `<step>: the wallet holds X tBNB, the step needs Y tBNB (rehearsal cost plus 10%); nothing
  sent`, and nothing is sent.
- **Before forge starts:** a pending marker goes into the state file: the step, its script, signature and arguments,
  the starting nonce, and forge's own record folder for this run (`.cache/bnb-testnet/broadcast/<step>-<nonce>-<time>`).
  Rehearsals never share a record folder with a real run.
- **After forge:** every recorded transaction is read back from the endpoint (mined, successful, from the deployer, at
  or after the starting nonce). Only then is the step written into the state and the marker removed. The state file is
  written beside itself and renamed into place.
- **Success:** `<step>: done, <n> transactions, <gas> gas, <tBNB> tBNB`, then the running gas table.
- **Forge's own output:** `.cache/bnb-testnet/logs/<step>-<time>.log`.

| # | Step | What it sends | Check on the explorer |
|---|---|---|---|
| 1 | `dependencies` | two holding contracts, PoolManager, DrandSource, the swapper, PoolSwapTest (WBNB is the chain's own) | the six contracts in the state's `dependencies` have code |
| 2 | `release` | the v2 release: 8 linked libraries through the CREATE2 deployer, the offline order-book stand-in, 30 release contracts, the factory last (predicted from the nonce and checked) | the factory has code; the directory's `count()` is 4 |
| 3 | `coins` | tUSDC, tNVDA, tGOLD, tPEPE, tETH (one issuance each to the deployer; tETH's faucet closed) | five coins with their symbols |
| 4 | `routes` | per route its converter module (trigger: the keeper's wallet), then right away its registration through the platform holding contract. `--routes 1`, `2`, `4` or a sum picks routes | the directory's `count()`; `record(id)` shows `readyAt` = block time + 86,400 |
| 5 | `listings` | the native raise lowered to 0.001 BNB; tUSDC, tNVDA, tGOLD, tPEPE, tETH listed (ids 1 to 5; raises below) | `listing(0..5)` on the listing registry |
| 6 | `helpers` | the pair helper and the native-pool helper | two contracts with code |
| 7 | `pools` | BNB/tNVDA at 4 tNVDA per BNB and BNB/tGOLD at 0.25 tGOLD per BNB (0.0001 BNB each), tUSDC/tNVDA, and tUSDC, tNVDA, tGOLD, tPEPE each against tETH | `liquidity(tETH, coin)` on the pair helper is above 0 for each coin; the files step reads both native prices back |
| 8 | `faucet` | tETH's public phase opened | tETH's `open()` is true; anyone can `drip()` 1 tETH a day |

The six listings (id, coin, class, raise in raw units):

| Id | Coin | Class | Raise (raw) | Raise |
|---:|---|---|---:|---:|
| 0 | BNB (native) | NATIVE | 1,000,000,000,000,000 | 0.001 BNB (from the release's initial 4,206,980,085,000,000,000) |
| 1 | tUSDC | STABLE | 1,000,000 | 1 tUSDC |
| 2 | tNVDA | STOCK | 1,000,000,000,000,000 | 0.001 tNVDA |
| 3 | tGOLD | OTHER | 1,000,000,000,000,000 | 0.001 tGOLD |
| 4 | tPEPE | OTHER | 1,000,000,000,000,000 | 0.001 tPEPE |
| 5 | tETH | OTHER | 100,000,000,000,000,000 | 0.1 tETH |

Pool prices: every pool opens at an exact encoded price (`sqrtPriceX96`): BNB/tNVDA 2·2^96 (4 tNVDA per BNB), BNB/tGOLD
2^95 (0.25 tGOLD per BNB), each pair at the pair helper's `_startingPrice` for its budgets. That is exact for all
pairs but tNVDA/tETH: there sqrt(1/10)·2^96 rounds down, and the pool opens at 100.000000000000000000000000015 tNVDA
per tETH. The checks compare these encoded integers, never a rounded price.

Addresses the plain and fork rehearsals predict for nonce 0 (**predictions** until compared with the real state):

| Contract | Address |
|---|---|
| factory | `0xB954a0db33a6351e76E519b4830489531C39d4F0` |
| box registry | `0xf77ef448bbc61d559ee8f657ce3a0b59f1af0daf` |
| listing registry | `0xccf0b8cc9257db834d77f29ea9eb8e5554ba0170` |
| PoolManager | `0xb0fd2d66040d310ed6bffbf8dba9ffcef39f52a4` |
| DrandSource | `0x4d1fdc8838ddb913779b9c5e79e2b2a82c58a264` |
| PoolSwapTest | `0x95c8aa9ad318a897259e1910a9f1ad31bec40c35` |
| tUSDC | `0x25c5789b269d8f76309ce961759d643dce291347` |
| tNVDA | `0x2f8029a6447663e0881b0e21f5e4ad0f1717627e` |
| tGOLD | `0x4ba04db6044a6f442bdb29b032cb019f663ab164` |
| tPEPE | `0xf4f59ecf2221c9c07ca8fcf47a2652008fea2ed8` |
| tETH | `0x860822580d4eb2529de0c74c3e2b1d6d7c183302` |

The route modules on the real chain were deployed by commit 9f5056a8, which deploys all three modules first and then
registers them; the fixed script registers each right after its module. Their addresses therefore differ from a fixed
rehearsal's; the files step takes them from the directory.

## 4. When a step stops

First, in every case: if the state file holds a pending marker, only that step can run until it completes. The driver
refuses any other step. The marker keeps every attempt (its starting nonce and its forge record folder). A retry adds
an attempt; it never replaces one.

**Before a step is written into the state:**
- **The attempts are reconciled with the nonces.** The last attempt's record must hold exactly the nonces from its start
  to the deployer's current nonce, each transaction mined, successful and from the deployer. A stopped attempt's
  record is reconciled for the nonces it actually used. Nonces it did not record are listed as `unrecorded` in the
  state.
- **The step's results are read on chain:**
  - dependencies: code everywhere, the swapper and PoolSwapTest on the PoolManager;
  - release: the factory on the PoolManager, the directory with its four modules;
  - coins: the five symbols and decimals;
  - routes: each selected route registered with the keeper as trigger;
  - listings: the six rows of the table above;
  - helpers: code, owned by the deployer, on the PoolManager;
  - pools: all seven at their encoded price, with the helper's position;
  - faucet: open.

| Step | What running the same command again does |
|---|---|
| any step already in the state file | Sends nothing: reads the step's results on chain and prints `already complete (its results read on chain); nothing sent` (it stops if they do not hold). |
| `dependencies`, `coins` | Deploys the step's contracts again from the start; what the stopped attempt made stays unused (at most that step once more: 0.0011 or 0.0004 tBNB). |
| `helpers` | Looks at the CREATEs of the stopped attempt (its nonces): a pair helper or a native-pool helper there, owned by the deployer and on the PoolManager, is kept; only a missing one is created. |
| `release` | First looks on chain for the factory (a CREATE of the deployer from the marker's starting nonce on, on the PoolManager); if it is there, takes it and sends nothing. Otherwise `--resume` (with `--skip-balance-check` if short) lets forge send the recorded rest; if forge refuses, the command without `--resume` makes a fresh release (the stopped part is lost, the CREATE2 libraries are skipped). |
| `routes` | Takes a route already registered in the directory with the same coins, trigger, release, PoolManager, hop, cap and dust. Otherwise it registers a matching module the stopped attempt created but did not register. Only then does it create one. It never registers the same route twice. |
| `listings` | Row 0: changes the raise only from the release's initial 4,206,980,085,000,000,000 to the target; any other value stops it. A coin already listed must have its id, class and raise from the table, or the step stops. The probe funds are sent only if the holding contract lacks them. |
| `pools` | A pool already initialized must be at exactly its encoded price and hold the helper's own position, or the step stops (someone else's pool is never accepted). Missing pools are seeded. Allowances are set only when they differ, and any allowance left to a helper is cleared. |
| `faucet` | Sends nothing if tETH is already open. |

- When everything of a restartable step is already on chain, the step records `nothingToSend`; the deployer's nonce
  does not move.
- **A transaction reverted, or a result does not hold:** the driver stops before writing the step. Read the step's forge
  log; do not go on to the next step.

## 5. The files

After the last step, wait about 5 seconds: the files are read at the endpoint's finalized block. Then:

```
node --experimental-transform-types script/bnb/bnb-testnet.mjs files --rpc-url $RPC --write-repo --git-commit "$(git rev-parse HEAD)"
```

`--git-commit` must be the full commit the folder holds. If the folder is not a git repository with that commit, leave
the flag out: the manifest then says `gitCommit: null`.

1. **Read:** at ONE finalized block, which must be at or after the last receipt any step recorded (otherwise: wait
   and run again).
2. **Required at that block, or nothing is written:** every step's results as in section 4 (all seven pools at their
   encoded price with the helpers' positions, the open faucet, the six listings, the three routes, the helpers, the
   coins, the release); the state's start block exists on this chain and the factory had no code there.
3. **Read for the files:** addresses, code hashes, symbols, decimals; the listings by `listingCount()`; the routes from
   the directory's records.
4. **Staged:** `--write-repo` stages into a NEW private folder `.cache/bnb-testnet/staging-<time>-<pid>/` and refuses
   `--out`. The coin record must be generated by this read; a file found in a folder never counts.
5. **Checked:** SH-258's `parseCoreManifestV2` and `checkTestnetReleaseOnChain` (any problem stops it);
   `parseCreateOptions` for this release; the coin record with its real chain id 97. Until SH-258's widened parser is
   on this branch, the coin record is checked with 31337 in place of 97, and the output says so.
6. **Published:** each new file is first written beside its place. Then each old file is renamed aside and the new one
   renamed in. On any failure the old files are put back, so the four places hold either the old set or the new one:
   - `packages/contracts/deployments/core-v1/97.json`
   - `packages/chain/src/trade-sepolia/coin-deployment-97.json`
   - `packages/chain/src/create-options/data/97/<factory>.json` (hidden draws, `addon.1`, switched off: configuration)
   - `packages/contracts/deployments/bnb-testnet/97-extras.json`

Any problem: non-zero exit, nothing published.

## 6. Another lane's script (the extra-step hook)

```
nohup node --experimental-transform-types script/bnb/bnb-testnet.mjs deploy --rpc-url $RPC --account hack-deployer \
  --password-file ~/.secrets/hack-deployer.pass --extra '<script path>:<Contract>:<signature>' \
  --extra-args '$factory,$coins.nvda' --extra-budget <wei> > ../../.cache/bnb-testnet/logs/run-extra.log 2>&1 &
```

- `$name.path` takes a value from the state file.
- The script's printed `BNB|<name>|<0x…>` lines are kept under `extra` in the state.
- The money refusal measures the stated `--extra-budget` plus 10%.

## 7. Rehearsing again

```
node --experimental-transform-types script/bnb/bnb-testnet.mjs rehearse --mode plain   # port 8573, about 40 s
node --experimental-transform-types script/bnb/bnb-testnet.mjs rehearse --mode fork    # port 8574
```

- **What a rehearsal sends:** both impersonate the deployer at its real nonce. Every transaction goes to the loopback
  anvil, after the driver checked that it is anvil on chain 97.
- **What the fork reads:** fork mode READS the real test network's state through the RPC above (or `--fork-url`). It
  sends nothing to it.
- **Where output goes:** `.cache/bnb-rehearsal/<run>/`. An output folder or `--dump` file outside `.cache/` or
  `hackathon/rehearsals/` is refused.
- **Flags:**
  - `--interrupt-step <step> --interrupt N`: stops that step after N transactions and runs it again as section 4 says.
  - `--second-runs`: runs every restartable step a second time and requires that it send nothing.
  - `--prove-release-recovery`: drops the factory from the state, puts the marker back, and requires the release step
    to find the factory on chain and send nothing.
  - `--again`: every step once more (restartable ones through their scripts, the others read on chain); the nonce
    must not move.
  - `--from-state <file>` (fork only): continues a real run's state file. `--git-commit <sha>` is written into the
    rehearsal's manifest.
- `runBox` and `runTrade` (the box proof) refuse any node that is not anvil.
