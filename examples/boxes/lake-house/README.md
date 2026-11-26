# Lake House (HOUSE)

**Test coins. Mock house, not legal title. Payments go into the pile; hand in HOUSE for a share.**

![Lake House. A small wooden house on posts at the edge of a lake at night, under a moon, with pines behind it. Its square window glows like a square hole and shines on the water.](art/logo.png)

The example box for a house run by a company Safe and an AI manager, on Sepolia. The house, the guests and the
title are made up. The coins are test coins. What is real: a box nobody can change, a spending limit the chain
enforces, and a pile that only HOUSE holders can take out.

## The box in numbers

| | |
|---|---|
| Name, ticker | Lake House, HOUSE |
| Priced in | tUSDC (Sepolia listing 2), raise 100 tUSDC |
| Contents | A coin pile of tUSDC, **empty at the start** |
| Fees, buyers and sellers | Both **To the pile** (after graduation) |
| Left behind on a hand-in | 0% |
| Deadline | 30 days |
| Creator | The Safe "Lake House Co. (mock company)": a Safe app label, owned by one person |
| About line | The line in bold above. It is set at creation and stays public for good |

A hand-in pays the pile times the HOUSE handed in, divided by all the HOUSE there is (the pool's included). The pile
has no other way out: once tUSDC is in, only HOUSE holders take it out (`PileVaultV2.sol`, `redeem`).

## Who does what

- **The Safe** holds the guests' payments, pays the costs and sends what is left into the box's inbox. One person
  holds its only key today. The company does not exist.
- **The manager** (an AI agent) answers the simulated guests, books the cleaner and pays the costs. Its first
  message says it is an AI. It pays through the Safe's spending limit: at most **300 tUSDC a week, to any address**.
  One owner transaction removes it.
- **The bookkeeper** (an AI agent) writes the monthly statement and the Safe transaction that sends what is left
  into the box. The owner signs it.
- **The guests** are simulated. One wallet funds the whole simulation, and the video says so.
- **Anyone** presses the box's public steps: graduation, the inbox's sweep, moving fees into the pile.

## Where a payment goes

A payment sent to the box's inbox splits in 15 parts: **10 to the pile**, 2 to the box's pool, 2 to FIT and 1 to
Square Hole. A trade's fee splits the same way. Coins sent straight to the pile join it whole.

## Words

- Say: test coins, mock house, made-up guests, the pile, hand in HOUSE for a share, a cap the chain enforces.
- Never, in anything public: earn, yield, APY, rent income, returns (F158: they wait for counsel). No "LLC": the
  company is "Co. (mock company)".
- Every live page shows the chain and the full contract address.

## Files

| File | What it is |
|---|---|
| [README.md](README.md) | This page |
| [storybook.md](storybook.md) | The story in seven scenes, with the words for each. Edit the words there |
| [art-notes.md](art-notes.md) | How the logo is drawn and where each colour comes from |
| `art/logo.svg`, `art/logo.png` | The mark, 1024 x 1024 |
| `art/logo-48.png` | The same mark at 48 x 48, to show it still reads |
| `art/palette.json` | Every colour's source: reference picture, approved crop, pixel patch |
| [build-art.mjs](build-art.mjs) | Builds every file in `art/` from `src/` |
| [check.mjs](check.mjs) | Checks the files, their freshness, the palette's source, the registry row and the words |
| `settings/lake-house-boxspec-v2.json` | Create's download, unbound (ETH listing 0). Bind tUSDC before use |

## Build and check

From the repository root, with Node 24.22.1 and the workspace installed:

```sh
node examples/boxes/lake-house/build-art.mjs
node examples/boxes/lake-house/check.mjs
node scripts/kits/settings.mjs lake-house
```

## Status

The registry row waits on `EXAMPLE-LIFE`: its local contract and browser lives are not written yet. The Sepolia
launch pack is `packages/chain/scripts/sepolia-launch-packs/lake-house/`. This kit is pitch material: kits go public
only at the mainnet launch (F151 R68-PUBLISH). The kit grants no license yet.
