"""Record independent oracle queries and assemble the default, non-FFI corpus.

From packages/contracts, run the live Foundry campaign with CQ11_RECORD_VECTORS=1
and CQ11_LIVE_FFI=true, then run this file with `assemble`. Scratch records live
under the repository's .cache; committed amounts are decimal strings. `check`
recomputes every expected answer using cq11.py, without Forge or any artifacts.

The contracts supply *inputs*, including the gross output of a real v4 swap. Only
the independent Python oracle supplies expected answers. Replay checks the query's
inputs as well as its outputs, so changed contract state cannot select a new answer.
"""
import hashlib
import json
import os
from pathlib import Path
import sys

from cq11 import evaluate

ROOT = Path(__file__).resolve().parents[4]
RECORDS = ROOT / ".cache/cq11-reference-records"
VECTORS = ROOT / "packages/contracts/test/vectors/cq11-reference"
# Expected queries per scenario: fail closed on missing or extra comparisons.
SCENARIOS = {
    "saleIn": ["sale"], "saleOut": ["sale"], "step": ["step"],
    "split": ["split", "split"], "clipped": ["split"], "dust": ["split", "split"],
    "claim": ["claim"], "reserve": ["failure"], "hatch": ["hatch"],
    "late": ["late", "late"], "noBuyer": ["late"], "raise": ["raise"],
}


def decimal_values(values):
    if not isinstance(values, list) or any(
        not isinstance(value, str) or not value.isascii() or not value.isdecimal()
        or str(int(value)) != value or int(value) >= 2**256 for value in values
    ):
        raise ValueError("canonical uint256 decimal strings required")
    return [int(value) for value in values]


def validate(name, corpus):
    cases = corpus["cases"]
    if corpus["queryCount"] != str(len(SCENARIOS[name])):
        raise ValueError(f"{name}: incorrect query count")
    if corpus["count"] != str(len(cases)) or not cases:
        raise ValueError(f"{name}: empty or incorrectly counted corpus")
    for case in cases:
        decimal_values(case["inputs"])
        if [query["operation"] for query in case["queries"]] != SCENARIOS[name]:
            raise ValueError(f"{name}: missing or extra model comparisons")
        for query in case["queries"]:
            expected = evaluate(query["operation"], decimal_values(query["inputs"]))
            if decimal_values(query["outputs"]) != expected:
                raise ValueError(f"{name}: stale or incorrect oracle answer")


def query(arguments):
    name, encoded, index, operation, *raw = arguments
    index = int(index)
    if SCENARIOS[name][index] != operation:
        raise ValueError("unexpected scenario query")
    result = evaluate(operation, decimal_values(raw))
    if os.environ.get("CQ11_RECORD_VECTORS") == "1":
        words = bytes.fromhex(encoded.removeprefix("0x"))
        if len(words) % 32:
            raise ValueError("static ABI arguments required")
        record = {
            "scenario": name,
            "inputs": [str(int.from_bytes(words[i:i + 32], "big")) for i in range(0, len(words), 32)],
            "index": index,
            "query": {"inputs": raw, "operation": operation, "outputs": list(map(str, result))},
        }
        RECORDS.mkdir(parents=True, exist_ok=True)
        identity = hashlib.sha256(words).hexdigest()
        target = RECORDS / f"{name}-{identity}-{index}.json"
        payload = json.dumps(record, sort_keys=True)
        if target.exists() and target.read_text() != payload:
            raise ValueError("non-reproducible query for the same scenario inputs")
        target.write_text(payload)
    print("0x" + "".join(value.to_bytes(32, "big").hex() for value in [32, len(result), *result]))


def assemble():
    groups = {name: {} for name in SCENARIOS}
    for path in sorted(RECORDS.glob("*.json")):
        record = json.loads(path.read_text())
        queries = groups[record["scenario"]].setdefault(tuple(record["inputs"]), {})
        queries[record["index"]] = record["query"]
    VECTORS.mkdir(parents=True, exist_ok=True)
    for name, group in groups.items():
        cases = []
        for inputs, queries in sorted(group.items()):
            if sorted(queries) != list(range(len(SCENARIOS[name]))):
                raise ValueError(f"{name}: incomplete recording; rerun the passing live campaign")
            cases.append({"inputs": list(inputs), "queries": [queries[i] for i in sorted(queries)]})
        corpus = {"count": str(len(cases)), "queryCount": str(len(SCENARIOS[name])), "cases": cases}
        validate(name, corpus)
        # One complete case per line keeps reviews compact while amounts remain readable.
        body = ',\n'.join(json.dumps(case, separators=(',', ':')) for case in cases)
        header = json.dumps({key: value for key, value in corpus.items() if key != "cases"})
        (VECTORS / f"{name}.json").write_text(header[:-1] + ',"cases":[\n' + body + '\n]}\n')
        print(f"{name}: {len(cases)} cases")


def check():
    for name in SCENARIOS:
        validate(name, json.loads((VECTORS / f"{name}.json").read_text()))
    print("CQ11 corpus: every recorded comparison matches the independent oracle")


if __name__ == "__main__":
    if sys.argv[1:] == ["assemble"]:
        assemble()
    elif sys.argv[1:] == ["check"]:
        check()
    elif sys.argv[1:2] == ["query"]:
        query(sys.argv[2:])
    else:
        raise SystemExit("usage: cq11_vectors.py {assemble|check|query ...}")
