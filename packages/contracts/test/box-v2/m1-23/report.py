"""Rebuild/check CQ11-F evidence from a verbose, fork-free Foundry log; integer arithmetic only.

python3 packages/contracts/test/box-v2/m1-23/report.py .cache/m1-23/default.log --write
python3 packages/contracts/test/box-v2/m1-23/report.py .cache/m1-23/amsterdam.log
"""
import argparse
import json
from pathlib import Path

FIELDS = (
    "inputP outputP nominalRoundTripFeeP creatorRecoveryP traderNetP creatorNetP "
    "noStepTraderNetP noStepCreatorNetP stepMovedP stepTipP stepTicks beforeSqrtX96 afterSqrtX96"
).split()
BASE_FIELDS = "budgetP giftT stepOnlyTipP stepOnlyRecoveryP".split()
RESULT = Path(__file__).with_name("results.json")


def build(log):
    cells, bases, other = {}, {}, []
    for line in log.splitlines():
        row = line.strip().split("|")
        tag = row.pop(0)
        if tag == "CELL":
            key, *values = row
            assert key not in cells, f"duplicate cell {key}"
            assert len(values) == len(FIELDS)
            cells[key] = dict(zip(FIELDS, values))
        elif tag == "BASE":
            key, *values = row
            value = dict(zip(BASE_FIELDS, values))
            assert key not in bases or bases[key] == value
            bases[key] = value
        elif tag in ("FEE", "PATH", "PARTIAL", "TIPS", "SELF_GIFT", "DRAIN"):
            other.append({"kind": tag, "values": row})
    assert len(cells) == 80 and len(bases) == 4, "incomplete grid"
    result = []
    for key, row in sorted(cells.items()):
        step, side, budget, _, gift = key.split("/")
        base = bases[f"{step}/{budget}"]
        before, after = int(row["beforeSqrtX96"]), int(row["afterSqrtX96"])
        net, creator = int(row["traderNetP"]), int(row["creatorNetP"])
        tip, alone = int(row["stepTipP"]), int(base["stepOnlyTipP"])
        recovery = int(base["stepOnlyRecoveryP"])
        derived = {
            "traderWithTipP": net + tip,
            "creatorWithTipP": creator + tip,
            "traderVersusStepOnlyP": net + tip - alone,
            "creatorVersusStepOnlyP": creator + tip - alone - recovery,
            "stepBenefitP": net - int(row["noStepTraderNetP"]),
            "priceMovePpm": (before * before - after * after) * 1000000 // (after * after),
            "nominalFeePpmOfInput": int(row["nominalRoundTripFeeP"]) * 1000000 // int(row["inputP"]),
        }
        result.append({
            "id": key,
            "creatorMode": "hypothetical keep-both credit" if step == "buyBack" else "actual keep-both payout",
            **row, **base, "giftT": base["giftT"] if gift == "g1" else "0",
            **{name: str(value) for name, value in derived.items()},
            "positive": [name for name in ("traderNetP", "creatorNetP", "traderWithTipP", "creatorWithTipP",
                         "traderVersusStepOnlyP", "creatorVersusStepOnlyP")
                         if int(row.get(name, derived.get(name, 0))) > 0],
        })
    # Different test-thread order must not change the artifact.
    return {"base": "4a608a3ad17ca5930538e073849bed04eb4b9627", "rawUnit": "P raw units; fixture P has 18 decimals",
            "stepLimitTicks": "49", "buyFeePpm": "10000", "saleFeePpm": "10000",
            "cells": result, "measurements": sorted(other, key=lambda x: (x["kind"], x["values"]))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    data = build(args.log.read_text())
    if args.write:
        RESULT.write_text(json.dumps(data, indent=2) + "\n")
    else:
        assert json.loads(RESULT.read_text()) == data, "measured results differ from pinned results.json"
    print(f"80 cells, {len(data['measurements'])} supporting measurements: {'written' if args.write else 'match'}")
    for field in ("traderNetP", "creatorNetP", "traderWithTipP", "creatorWithTipP",
                  "traderVersusStepOnlyP", "creatorVersusStepOnlyP"):
        gains = [c for c in data["cells"] if int(c[field]) > 0]
        print(f"{field}: {len(gains)} positive cells")


if __name__ == "__main__":
    main()
