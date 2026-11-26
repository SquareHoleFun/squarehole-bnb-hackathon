"""M1-23: listing-figures.sepolia.json from integers only (the hand check of SepoliaFigures.t.sol's derivation).

    python3 packages/contracts/test/box-v2/m1-23/listing_figures.py            # check the file, exit 1 if it differs
    python3 packages/contracts/test/box-v2/m1-23/listing_figures.py --write    # write it

The formulas are M123Figures' (M123Kit.sol) with Uniswap's TickMath.getSqrtPriceAtTick ported; amounts are raw units.
"""
import json
import pathlib
import sys

FILE = pathlib.Path(__file__).resolve().parents[3] / "listing-figures.sepolia.json"
Q96 = 1 << 96
R = 420_698_008_500_000_000  # the rehearsal build's raise (src/box/build/rehearsal/BoxBuildV1.sol:24)
PPM = 10**6
F_V3, F_V2, F_BOX, F_FIXED = 1_000_000, 500_000, 4_000, 10_000_000  # M123Proposed (F_FIXED: k = 10)
MARGIN = 200
USDC_PER_ETH = 2_700 * 10**6
MULTIPLIERS = [
    (0x2, 0xFFF97272373D413259A46990580E213A), (0x4, 0xFFF2E50F5F656932EF12357CF3C7FDCC),
    (0x8, 0xFFE5CACA7E10E4E61C3624EAA0941CD0), (0x10, 0xFFCB9843D60F6159C9DB58835C926644),
    (0x20, 0xFF973B41FA98C081472E6896DFB254C0), (0x40, 0xFF2EA16466C96A3843EC78B326B52861),
    (0x80, 0xFE5DEE046A99A2A811C461F1969C3053), (0x100, 0xFCBE86C7900A88AEDCFFC83B479AA3A4),
    (0x200, 0xF987A7253AC413176F2B074CF7815E54), (0x400, 0xF3392B0822B70005940C7A398E4B70F3),
    (0x800, 0xE7159475A2C29B7443B29C7FA6E889D9), (0x1000, 0xD097F3BDFD2022B8845AD8F792AA5825),
    (0x2000, 0xA9F746462D870FDF8A65DC1F90E061E5), (0x4000, 0x70D869A156D2A1B890BB3DF62BAF32F7),
    (0x8000, 0x31BE135F97D08FD981231505542FCFA6), (0x10000, 0x9AA508B5B7A84E1C677DE54F3E99BC9),
    (0x20000, 0x5D6AF8DEDB81196699C329225EE604), (0x40000, 0x2216E584F5FA1EA926041BEDFE98),
    (0x80000, 0x48A170391F7DC42444E8FA2),
]


def sqrt_at_tick(tick):
    a = abs(tick)
    r = 0xFFFCB933BD6FAD37AA2D162D1A594001 if a & 1 else 1 << 128
    for bit, c in MULTIPLIERS:
        if a & bit:
            r = (r * c) >> 128
    if tick > 0:
        r = ((1 << 256) - 1) // r
    return (r >> 32) + (0 if r % (1 << 32) == 0 else 1)


def floor(ppm):
    return -(-R * ppm // PPM)  # RouteChecks.floorOf: rounded up


def raise_raw(token_per_eth):
    return R * token_per_eth // 10**18


def band(raw):
    return [str(-(-raw * 9_500 // 10_000)), str(raw * 10_500 // 10_000)]


def seed(v2, fee, half, floor_ppm):
    d = floor(floor_ppm) * MARGIN // 100
    virt = 2 * d * PPM // fee
    return d, virt if v2 else virt * (Q96 - sqrt_at_tick(-half)) // Q96


def v3_pool(pair, token_per_eth, quote_per_eth=None):
    d, side = seed(False, 10_000, 500, F_V3)
    p = {"pair": pair, "kind": "V3_POOL", "feeTier": 10_000, "halfRangeTicks": 500,
         "depthFloorWei": str(floor(F_V3)), "depthTargetWei": str(d), "quoteSideWei": str(side),
         "tokenSideRaw": str(side * token_per_eth // 10**18),
         "oracleBufferSlots": 2}
    if quote_per_eth is None:
        p["sepEthWei"] = str(side)
    else:
        p["quoteSideRaw"] = str(side * quote_per_eth // 10**18)
        p["sepEthWei"] = "0"
    return p


def build():
    d2, side2 = seed(True, 3_000, 0, F_V2)
    paxg = {"pair": "PAXG/WETH", "kind": "V2_PAIR", "feeTier": 3_000, "depthFloorWei": str(floor(F_V2)),
            "depthTargetWei": str(d2), "quoteSideWei": str(side2), "tokenSideRaw": str(side2 * 65 * 10**16 // 10**18),
            "sepEthWei": str(side2), "reading": "reserves untouched in the listing block"}
    eth_per_usdc_x18 = 10**36 // USDC_PER_ETH  # the USDC/WETH hop's average at the seed price
    d_fixed = floor(F_FIXED) * MARGIN // 100
    pocket = -(-d_fixed * 10**18 // eth_per_usdc_x18)
    assert pocket * eth_per_usdc_x18 // 10**18 >= d_fixed, "the pocket's depth (HopFixedRate.depth) holds the target"
    susds = {"pair": "sUSDS -> USDC (test vault, test PSM)", "kind": "FIXED_RATE", "psmFees": "0 both ways",
             "depthFloorWei": str(floor(F_FIXED)), "depthTargetWei": str(d_fixed),
             "ethPerUsdcRawX18": str(eth_per_usdc_x18),
             "pocketUsdcRaw": str(pocket),
             "pocketNote": "twice k x R's worth of test USDC at the seed price, k = 10 (DEPTH_FLOOR_FIXED_RATE_PPM, "
             "proposed) [P]; HopFixedRate.depth values the pocket at the USDC/WETH hop's average; test USDC is minted",
             "sepEthWei": "0"}
    rows = [
        ("test LINK", 18, 200 * 10**18, "STANDARD", ["LINK/WETH v3 1%"], [v3_pool("LINK/WETH", 200 * 10**18)]),
        ("test USDC", 6, USDC_PER_ETH, "STABLE", ["USDC/WETH v3 1%"], [v3_pool("USDC/WETH", USDC_PER_ETH)]),
        ("test WBTC", 8, 3_330_000, "STANDARD", ["WBTC/WETH v3 1%"], [v3_pool("WBTC/WETH", 3_330_000)]),
        ("test PAXG", 18, 65 * 10**16, "STANDARD", ["PAXG/WETH v2"], [paxg]),
        ("test stock", 18, 112 * 10**17, "STOCK", ["STOCK/USDC v3 1%", "USDC/WETH v3 1% (test USDC's pool)"],
         [v3_pool("STOCK/USDC", 112 * 10**17, USDC_PER_ETH)]),
        ("test sUSDS", 18, 2_560 * 10**18, "OTHER", ["sUSDS/USDC FIXED_RATE", "USDC/WETH v3 1% (test USDC's pool)"],
         [susds]),
    ]
    listings, total = [], 0
    for name, dec, tpe, cls, route, pools in rows:
        sep = sum(int(p["sepEthWei"]) for p in pools)
        total += sep
        listings.append({"name": name, "class": cls, "decimals": dec, "seedTokenPerEthRaw": str(tpe), "route": route,
                         "raiseRaw": str(raise_raw(tpe)), "raiseBandRaw": band(raise_raw(tpe)), "pools": pools,
                         "sepEthWei": str(sep)})
    return {
        "description": "M1-23's Sepolia listing figures for M1-64 (core v2 M1): each lister listing's raise at its "
        "seeded pool's price, and the depth and quote side each seeded pool needs to pass the proposed "
        "depth floors twice over, in the rehearsal build (1/10). Amounts are decimal strings of raw units (wei for "
        "ETH). Not the checker's listings.sepolia.json (M1-11).",
        "source": "packages/contracts/test/box-v2/m1-23/SepoliaFigures.t.sol (derivation pinned), "
        "docs/evidence/SH-V2-CQ8-COMPILE.md (CQ8 migration)",
        "status": "RETIRED (2026-10-20, SH-V21-RC7-INT part 4): history only, not an input. These are rehearsal-build "
        "figures (the 1/10 raise); the rc7 Sepolia v2 run deploys the release build only (DeployCoreV2 refuses any "
        "other with NotReleaseBuild, F140) and lists coins by docs/runbooks/listing-coins.md. Was: proposal [P]: seed prices, fee tiers and ranges are M1-23's defaults for M1-64; floors are M1-23's "
        "proposed values, applied by the integrator. CQ8-F26: v3 oracles need 2 slots; v2 readings use reserves "
        "untouched in this block. sepEthWei counts seed liquidity only: all transaction gas is excluded. The old "
        "600-slot growth gas measurements no longer apply. The integrator must measure current deployment and "
        "one-slot growth costs before funding the Sepolia run.",
        "buildProfile": "rehearsal",
        "raiseWei": str(R),
        "floorsPpmOfRaise": {"v3Pool": str(F_V3), "v2Pair": str(F_V2), "boxPool": str(F_BOX),
                             "fixedRate": str(F_FIXED)},
        "seedMarginPercent": MARGIN,
        "listings": listings,
        "byRule": [
            {"name": "FIT", "route": ["box 0's pool (FIT/ETH)"], "seed": "none: box 0's pool"},
            {"name": "an ETH-priced test box's token", "route": ["its box pool (T/ETH)"],
             "seed": "none: graduation depth, about 0.48% of R's worth within the band, above the 0.4% floor at "
             "either build"},
            {"name": "a USDC-priced test box's token",
             "route": ["its box pool (T/USDC)", "USDC/WETH v3 1% (test USDC's pool)"],
             "seed": "none: as above, valued through test USDC's pool"},
        ],
        "sepEthTotalWei": str(total),
    }


if __name__ == "__main__":
    doc = build()
    if "--write" in sys.argv:
        FILE.write_text(json.dumps(doc, indent=2) + "\n")
        sys.exit(0)
    same = json.loads(FILE.read_text()) == doc
    print("listing-figures.sepolia.json", "matches" if same else "DIFFERS from", "the integer recomputation")
    sys.exit(0 if same else 1)
