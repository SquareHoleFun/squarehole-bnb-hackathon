# Atlas in Square Hole on BNB Chain

The CoinMarketCap x Atlas track's one-page write-up. Every address and number on this page is taken from
`packages/contracts/deployments/bnb-testnet/97-atlas.json` and `packages/chain/src/atlas/atlas-feeds.ts`; the test
network only (chain id 97), no money of value. Back to the [judges' guide](../../README.md).

## The problem and the audience

On most launch platforms the prices that matter are set by hand or shown from a website's own server: how much a new
token must raise, what its backing is worth in dollars. Creators and holders of tokens tied to real-world prices need
those numbers to come from a price feed, on chain, where anyone can check them. Here Atlas prices drive three things.
The amount a new box raises before it graduates stays at one US dollar's worth of its price coin, on chain: anyone can
call `poke` on our contract; it reads Atlas and resets that amount, in steps of at least 2%, at most once an hour, and
it refuses a stale price (a box keeps the amount set when it was created). Box pages show dollar figures for a box's
price coin and its pile only while the price is fresh: two endpoints must agree, and the browser never talks to a
price source. And the keeper, the service that does a box's upkeep, values a box's income in BNB at Atlas prices
(tPEPE, which has no feed, keeps a reviewed rate): no fresh price, no upkeep.

## The feeds we use, and why

We read Atlas's push feeds directly on chain (`latestRoundData()` and `decimals()`), with a gas cap and a maximum age
for each feed. BNB/USD sets the raise of a new box in BNB and is the keeper's measure of a box's income. NVDAB/USD and
XAU/USD price tNVDA and tGOLD, our test stand-ins for a stock and for gold. ETH/USD prices tETH. USDC/USD, read on BNB
main network, gives the dollar figures for tUSDC. A feed that goes stale stops only its own price: that coin's raise
stays where it was, and the others go on.

Atlas's feeds on BNB Chain's test network, read through Atlas's published interface (`latestRoundData()` and
`decimals()`; no key, any caller):

| Feed | Atlas id | Feed contract on chain 97 | Freshness limit | What depends on it |
|---|---|---|---|---|
| BNB/USD | `0x00000279` | [`0x3957d289ee9C38272377786787ea34F9dd29788D`](https://testnet.bscscan.com/address/0x3957d289ee9C38272377786787ea34F9dd29788D) | 190 s | BNB: the raise of a new box priced in BNB (listing row 0); dollar figures; the keeper values income in BNB |
| NVDAB/USD | `0x000003a6` | [`0x3eF39d6361EfA1E8Ca066751f438077dA81082A6`](https://testnet.bscscan.com/address/0x3eF39d6361EfA1E8Ca066751f438077dA81082A6) | 910 s | tNVDA (a test coin priced by this feed): the raise of a new box (listing row 2); dollar figures on box pages |
| XAU/USD | `0x58415500` | [`0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764`](https://testnet.bscscan.com/address/0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764) | 910 s | tGOLD (a test coin priced by this feed): the raise of a new box (listing row 3); dollar figures |
| ETH/USD | `0x00000278` | [`0x35369dEcD8c662954B3D24acc2A862C708A34fD2`](https://testnet.bscscan.com/address/0x35369dEcD8c662954B3D24acc2A862C708A34fD2) | 190 s | tETH: the raise of a new box (listing row 5); dollar figures |
| USDC/USD | 650 | on BNB Chain's main network only: [`0x2fd873e39e65b5f7f0e03e5079ecd4da7fc4067b`](https://bscscan.com/address/0x2fd873e39e65b5f7f0e03e5079ecd4da7fc4067b) | a day and an hour | tUSDC: dollar figures on box pages |

Where each feed is read:

- **On chain:** our AtlasSource reads the feed; anyone's `poke(listingId)` on our AtlasRaiseSetter then sets that
  listing's raise (the amount a new box raises in that coin) to one US dollar's worth from a fresh price
  (`packages/contracts/script/bnb/AtlasRaise.sol`).
- **The index:** the dollar figures on box pages, only while the price is fresh; the browser never reads a price
  itself (`packages/indexer/src/core/atlas-prices.ts`).
- **The keeper:** a box's income valued at Atlas prices; without a fresh price, no upkeep (`packages/keeper/src/atlas-rates.ts`).

## The BNB Chain contracts and data

Our contracts on chain 97:

| Contract | On the explorer |
|---|---|
| AtlasSource: reads each feed on chain (`decimals()`, `latestRoundData()`) | [`0x08857eEd51dEA7813c834d20eA6bA2fF06BcD7Eb`](https://testnet.bscscan.com/address/0x08857eEd51dEA7813c834d20eA6bA2fF06BcD7Eb) |
| AtlasRaiseSetter: `poke(listingId)` sets a listing's raise to one US dollar's worth from a fresh price | [`0x34A364Bd2E4129E92e1102245e582fe22aa266A8`](https://testnet.bscscan.com/address/0x34A364Bd2E4129E92e1102245e582fe22aa266A8) |
| Listing registry: the listings whose raise the setter moves | [`0xcCf0B8CC9257DB834d77F29EA9eB8e5554ba0170`](https://testnet.bscscan.com/address/0xcCf0B8CC9257DB834d77F29EA9eB8e5554ba0170) |
| AtlasMirror: the relay copy of the first deployment, no longer written | [`0xE1F83eE5a2ba0f5Bf4Ff7737D9C879f716d2e912`](https://testnet.bscscan.com/address/0xE1F83eE5a2ba0f5Bf4Ff7737D9C879f716d2e912) |

The test coins the feeds price (test coins of this network, not the assets themselves):

| Coin | On the explorer | Priced by |
|---|---|---|
| tNVDA | [`0x2f8029a6447663e0881b0e21f5e4ad0f1717627e`](https://testnet.bscscan.com/address/0x2f8029a6447663e0881b0e21f5e4ad0f1717627e) | NVDAB/USD |
| tGOLD | [`0x4ba04db6044a6f442bdb29b032cb019f663ab164`](https://testnet.bscscan.com/address/0x4ba04db6044a6f442bdb29b032cb019f663ab164) | XAU/USD |
| tETH | [`0x860822580d4eb2529de0c74c3e2b1d6d7c183302`](https://testnet.bscscan.com/address/0x860822580d4eb2529de0c74c3e2b1d6d7c183302) | ETH/USD |
| tUSDC | [`0x25c5789b269d8f76309ce961759d643dce291347`](https://testnet.bscscan.com/address/0x25c5789b269d8f76309ce961759d643dce291347) | USDC/USD |

The setter's first three raises, read back from the chain:

| Listing row | Price read | Raise before (raw) | After (raw) | Transaction |
|---|---|---|---|---|
| 2 | 143.65 USD | 6780224385222610 | 6961261242557455 | [`0x73dcdd57…`](https://testnet.bscscan.com/tx/0x73dcdd573f275f47e7b5f56186d526f145ff5c6e7d0fd00823e96e87146cb844) |
| 3 | 3,439.55 USD | 284958949859477 | 290735983734038 | [`0x467cd12c…`](https://testnet.bscscan.com/tx/0x467cd12c432735071f92e9678f7599fba9a9f5fa22a27ef9d9ceab67d81b387c) |
| 5 | 1,643.33 USD | 100000000000000000 | 608520608251760 | [`0x9475936e…`](https://testnet.bscscan.com/tx/0x9475936e7c85e09f69baebba3ccd6b0e8270a52a9265e1914665f4c784760b11) |

Check it yourself (read only, no key):

```sh
cast call 0x34A364Bd2E4129E92e1102245e582fe22aa266A8 "quote(uint32)(uint256,uint256,uint256,uint256,bool)" 2 --rpc-url https://bsc-testnet-rpc.publicnode.com
cast call 0x3eF39d6361EfA1E8Ca066751f438077dA81082A6 "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url https://bsc-testnet-rpc.publicnode.com
```

The first prints the raise listing row 2 would get now, the price it read, its two times and whether the price
came straight from Atlas's feed; the second is Atlas's NVDAB/USD feed itself.

## What we would build next

Point the same code at real tokenized stocks: Atlas's registry of 105 of them is on BNB main network. Boxes whose
holders are paid in a stock, priced by its feed. A second data source as a cross-check before any price is used.
