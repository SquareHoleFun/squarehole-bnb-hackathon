#!/usr/bin/env python3
"""Controls for the swap guards (Flap's pre-audit finding R2): each check is removed in turn and the tests that name
it must fail; the source is restored after each run (also on an error or Ctrl-C).

  cd bounties/core && python3 proof/guard_controls.py [group]     # group: g (the guard), n4 or all

Prints one line per control: the check removed, the tests run, and FAILS (the control holds) or PASSES (the check is
not covered). Exits 1 when any control passes.
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.dirname(HERE)

# (layer, name, file, old text, new text, test regex); old may be a list of (old, new) pairs, with new None
CONTROLS = [
    ("g", "cap: 5 bps of the quote reserve", "src/PairPriceGuard.sol",
     "uint256 cap = p.quoteReserve * CAP_BPS / 10_000;", "uint256 cap = type(uint256).max;",
     "test_L1_splitter_native_slices|test_L1_shop_refillClamps"),
    ("g", "pace: one buy per 60 seconds", "src/PairPriceGuard.sol",
     "if (s.lastBuyAt != 0 && block.timestamp < uint256(s.lastBuyAt) + MIN_GAP) return (Wait.TOO_SOON, 0, 0);", "",
     "test_L1_splitter_native_slices|test_L1_shop_refillClamps|test_pace_"),
    ("g", "splitter: the last buy's time is written", "src/RuleSplitter.sol",
     "        PairPriceGuard.markBought(_buyGuard);\n", "",
     "test_pace_|test_L1_splitter_native_slices"),
    ("g", "splitter: the time is written only after a buy that spent", "src/RuleSplitter.sol",
     [("        spent = _swap(router, path, amountIn, minOut);\n",
       "        PairPriceGuard.markBought(_buyGuard);\n        spent = _swap(router, path, amountIn, minOut);\n"),
      ("        PairPriceGuard.markBought(_buyGuard);\n        uint256 deadAfter", "        uint256 deadAfter")], None,
     "test_failedSwap_costsNoMinute_splitter"),
    ("g", "shop: the last refill's time is written", "src/RailShop.sol",
     "        PairPriceGuard.markBought(_refillGuard);\n", "",
     "test_L1_shop_refillClamps"),
    ("g", "splitter: the minimum passed to the router", "src/RuleSplitter.sol",
     "(minOut, path, DEAD, block.timestamp)", "(0, path, DEAD, block.timestamp)",
     "test_L1_splitter_native_slices"),
    ("g", "shop: the minimum passed to the router (both paths)", "src/RailShop.sol",
     "minOut, path, address(this), block.timestamp", "0, path, address(this), block.timestamp",
     "test_L1_shop_refillClamps"),
    ("g", "a slice whose minimum is zero is refused", "src/PairPriceGuard.sol",
     "        if (amountIn == 0 || minOut == 0) return (Wait.NO_POOL, 0, 0);\n", "",
     "test_sliceTooSmall"),
    ("g", "shop: the amount bought is the slice", "src/RailShop.sol",
     "{value: amountIn}(", "{value: amount}(",
     "test_L1_shop_refillClamps"),
    ("g", "shop: a refill too soon reverts as such", "src/RailShop.sol",
     "if (wait == PairPriceGuard.Wait.TOO_SOON) revert RefillTooSoon();", "",
     "test_L1_shop_refillClamps"),
    ("g", "shop: a refill buys the whole slice or nothing", "src/RailShop.sol",
     "if (amount < amountIn) revert AmountBelowSlice();", "",
     "test_shop_refillBelowTheSlice"),
    ("g", "shop: the settlement's debit equals the slice", "src/RailShop.sol",
     "if (debit != amountIn || tokensOut < minOut) revert RefillShort();", "if (tokensOut < minOut) revert RefillShort();",
     "test_refill_routerDrawsLessOrNothing"),
    ("g", "shop: the settlement's arrival meets the minimum", "src/RailShop.sol",
     "if (debit != amountIn || tokensOut < minOut) revert RefillShort();", "if (debit != amountIn) revert RefillShort();",
     "test_refill_exactDebit_arrivalBelowTheMinimum"),
    ("g", "the pair's sides by address order", "src/PairPriceGuard.sol",
     "token < quote ? (r1, r0) : (r0, r1)", "token < quote ? (r0, r1) : (r1, r0)",
     "test_L1_splitter_erc20Quote6Decimals_bothSides|test_L1_shop_erc20Quote6Decimals_bothSides"),
    ("g", "at most one burn rule", "src/RuleSplitter.sol",
     "if (burnSeen) revert InvalidRules();", "",
     "test_twoBurnRules"),
    ("n4", "claim: reverts when the payment fails", "src/RuleSplitter.sol",
     "if (!ok) revert PaymentFailed();", "",
     "test_N4_hungryPayee"),
    ("n4", "claim: the owed part is cleared before paying", "src/RuleSplitter.sol",
     "        _owed[i] = 0;\n        totalOwed -= paid;\n", "        totalOwed -= paid;\n",
     "test_N4_hungryPayee"),
    ("n4", "claim: CREATOR rules only", "src/RuleSplitter.sol",
     "if (r.kind != Kind.CREATOR) revert NotCreatorRule();", "",
     "test_N4_hungryPayee"),
]


def run(regex):
    r = subprocess.run(["forge", "test", "--match-test", regex], cwd=CORE, capture_output=True, text=True)
    out = r.stdout + r.stderr
    if "Compiler run failed" in out or "Error (" in out:
        return "COMPILE ERROR"
    return "FAILS" if r.returncode != 0 else "PASSES"


def main():
    want = sys.argv[1] if len(sys.argv) > 1 else "all"
    bad = 0
    for layer, name, rel, old, new, regex in CONTROLS:
        if want != "all" and want != layer:
            continue
        path = os.path.join(CORE, rel)
        backup = path + ".control-backup"
        src = open(path).read()
        pairs = old if isinstance(old, list) else [(old, new)]
        missing = [o for o, _ in pairs if src.count(o) < 1]
        if missing:
            print(f"[{layer}] {name}: the text to remove is not found in {rel}: {missing[0]}")
            bad += 1
            continue
        shutil.copyfile(path, backup)
        try:
            mutated = src
            for o, n in pairs:
                mutated = mutated.replace(o, n)  # every occurrence
            open(path, "w").write(mutated)
            verdict = run(regex)
        finally:
            shutil.copyfile(backup, path)
            os.remove(backup)
        if verdict != "FAILS":
            bad += 1
        print(f"[{layer}] {name}: removed -> {regex}: {verdict}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
