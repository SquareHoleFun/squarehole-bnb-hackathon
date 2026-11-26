Square Hole: contracts for Flap, corrected after your pre-audit (BNB Chain testnet, chain 97)

From our repository at commit 3272b398051055ba7e4454de5307e171fc76eba2 (26 November 2026).
Test network only. Not audited. License: MIT (see the SPDX line of each file).
The first archive was commit ee285cd81f650dde3919f262205f1e9273ad06ca.

WHAT CHANGED, BY YOUR FINDING
  R1  Name and symbol are screened at creation. Every launcher factory takes your anti-scam module as its fourth
      constructor argument (test network 0x5CfbE713d070e87F67D1bc84312B7eB8Fe4F2B5E, main network
      0xfFb69d59f62454f3B8322Bc1a9FCE6E171a5264f) and checkConfig refuses a listed name or a listed symbol, each
      with its own reason. A module that reverts, answers short or wrong data, or runs out of gas refuses creation.
  R2  The two swaps anyone can trigger (RuleSplitter's buy and burn, RailShop.refill) now go through one library,
      bounties/core/src/PairPriceGuard.sol, with your fix as written: a nonzero minimum from the pair's reserves
      (room for a 10% buy tax, the pool fee and 1% slippage) and a cap of 5 bps of the pair's quote reserve per
      buy; and at most one buy per contract per minute, so that the cap cannot be passed by calling again. What is
      not bought stays owed and is bought in later calls; the other rules are paid in the same call.
      Its stated limit (the library's header; measured in bounties/core/proof): the minimum and the cap are read
      from the reserves in the buyer's own transaction, so a trade placed earlier in that transaction has already
      moved them. A reference such a trade cannot move, the pair's time-weighted price, is our next step and is
      not in this version.
  R3  Each vault factory stores its paired launcher factory immutably and newVault requires
      getLauncher(creator).launcherFactory to equal it; each launcher factory's constructor requires the pairing
      from its side; setRules takes only the paired factory; createLauncher is removed.
  R4  PileVault and RulesVault are implementations behind UpgradeableBeacons owned by their factories; every vault
      is a beacon proxy; upgradeVaultImplementation is Guardian-only, built as your SplitVaultFactory.
      FeeRules and RuleSplitter were split into a base with ordered storage and a gap, and a constructor wrapper.
  R5  Tests on a fork of BNB Chain's main network: bounties/flap/test/*Mainnet* (14 tests at block
      135830000; creation is paused there, so the tests act as the MANAGE_ROLE holder).
  N4  A creator part that could not be pushed within the gas allowance can be claimed: payOwedCreator(i).

WHERE WE DIFFER FROM YOUR REFERENCE (so that your checker does not have to find it)
  - The rules vault factory creates two upgradeable things, the vault and its pile, so it has a second beacon:
    upgradePileImplementation, pileBeaconImplementation, PileImplementationUpgraded. Guardian-only as the first.
  - Our names are pairedLauncherFactory and NotPaired (yours: launcherFactory, NotFromLauncherFactory).
  - The upgrade authority is the Guardian address your library selects per chain; it is not read from the Portal.
  - Anyone can point a beacon proxy of their own at our public beacons. Our factories never record such a proxy:
    a vault is ours only through the factory's vaultOf / predictVault.
  - RulesVault.pileOf(address token) returns the vault's pile: the resolver for the vault UI's resolvedContracts.

THREE QUESTIONS
  1. The anti-scam module is a constant in your launch facet, different per network, and the Portal has no getter
     for it. Can you add a getter, or confirm the two addresses above, so that a factory cannot be deployed with a
     stale module?
  2. Is the second Guardian-only function (upgradePileImplementation) acceptable to your checker?
  3. FlapVaultEx: what does it guarantee beyond the minimum its caller passes? Does it check a reference price the
     caller cannot move in the same transaction, and does it accept taxed tokens like ours?

WHAT IS INSIDE
  bounties/flap/src, test, script     the launchers, the vault factories, the vaults; unit and fork tests; the
                                      deployment and run scripts
  bounties/core/src, test, script     FeeRules (the pile), RuleSplitter (the rules), RailShop, RailStake,
                                      PairPriceGuard; unit, fuzz and invariant tests
  bounties/core/proof                 the swap guard's measurements (Python, integer math) and the controls
  bounties/flap/README.md, bounties/core/README-rail-shop.md   how it works, the stated limits, gas
Flap's own base contracts are not copied into this archive: bounties/flap/lib/flap-pool-launch is the repository
https://github.com/flap-sh/FlapPoolLaunchVaultExample at commit 29334f689774f6b3a39720b3fc802ab0d6a61718.

BUILD AND TEST (keep bounties/core and bounties/flap side by side: core takes forge-std from flap's lib)
  git clone https://github.com/flap-sh/FlapPoolLaunchVaultExample bounties/flap/lib/flap-pool-launch
  git -C bounties/flap/lib/flap-pool-launch checkout 29334f689774f6b3a39720b3fc802ab0d6a61718
  git -C bounties/flap/lib/flap-pool-launch submodule update --init --recursive
  cd bounties/core && forge build && forge test                        150 passed, 1 skipped
  cd bounties/flap && forge build && forge test                        67 passed (fork suites skip)
  test-network forks (a fork of chain 97 pinned at block 144964306):
    FORK_URL=<your fork or endpoint> forge test --match-path 'test/*.fork.t.sol'      29 passed
  main-network forks (an archive endpoint; one job, throttled, or the endpoint answers 429):
    BSC_RPC_URL=<archive endpoint> FOUNDRY_COMPUTE_UNITS_PER_SECOND=200 FOUNDRY_FORK_RETRIES=12 \
      FOUNDRY_FORK_RETRY_BACKOFF=3000 forge test -j 1 --match-path 'test/*Mainnet*'   14 passed

ADDRESSES ON CHAIN 97 (the corrected set, deployed from this commit on 26 November 2026)
  The first set stays on chain beside it; the site reads the first set.
  Launcher factory with rules, BNB          0xa0c6D7be020eD3699508745A4dbAC1A8a1B415C2
    its rules vault factory                 0x8C130C16A099e19B809FE726Cd0590CDD4B9F0D1
    its vault beacon                        0x744A0F81Ff3e9e866B05B80Da74AE168512dD88F
    its pile beacon                         0xfE118ff8ca2B43dDDa3aE9dfce1a529DCD5796eB
  Launcher factory with rules, test USDT    0x61873aD21f3E471910C976ef7993ED40b399eeC0
    its rules vault factory                 0x73aBa498C5415bb587E8f249314c619a5C3a55a2
    its vault beacon                        0x9b7c9ac2eDffed18Cf5204DfdE8285A70efD28f4
    its pile beacon                         0xEC1f793Da1FdFAB58D67f045a04B252e5Af1bBE8
  Launcher factory, BNB                     0xB577CDf809B68f22Ea87437C84e2415B5cCE1BC7
    its pile vault factory                  0x06871dC0A75bA96282A59021e66D894A6637FeF3
  Launcher factory, test USDT               0x83c86a911FdE0b0daF9b331d9358b7Dc326DD3dD
    its pile vault factory                  0xE76819C5761ceFE8c7C90e6401b77E9066f59d34
  Card shop factory                         0xe49fD8d811C6e8779b94C8c58bE2bB1e60c51cd2
  Stake factory                             0xDeC6ca89374bf47A5Fe6b347bfD1ab48d54e7450
  All four launcher factories are enabled on the Portal through your test helper (launcherFactoryMultiplier: true 0).
LAUNCHED ON THEM (each created through Portal.newLauncher)
  Proof Jar (PJAR), rules, BNB: run end to end
    token    0x6c3cf0DB5a825425cB13fDB0D35566dc75e37777
    launcher 0xeB9e112AA8e46fC1332Bc79c0F52EA2c5B1480eF
  Proof Jar Dollar (PJUSD), rules, test USDT
    token    0x9b98CA3e3a119Ab17E86f041c9a791AAf1d57777
    launcher 0xFCd915957bef993fD7a7BFe180f502b98FEC58Ed
  Proof Pile (PPILE), BNB
    token    0xd70b90722e39a073C6DFC927bDaa8BC7b1967777
    launcher 0xe1c1312A4e27722EA8ecab1a8C858Ff634DbeaD5
  Proof Pile Dollar (PPUSD), test USDT
    token    0x671C0ceA24b9C4dEC0E8FE6e9Cce5a91a0157777
    launcher 0x68f14EA7b1D2A23BD3B721C76Cc24A907Ea80D19
  Proof Jar: bought out and launched, three pool trades, two share-outs (each bought exactly one capped slice of
  5 bps of the pair's reserve and burned it, the rest owed), one redemption from its pile.

Labels in comments such as "SH-308" are our internal work labels.
