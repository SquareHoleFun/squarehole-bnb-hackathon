#!/usr/bin/env python3
"""Differential golden for feed selection (SH-002).

Runs the handoff's Python reference `square-hole-handoff/reference/feed_model.py` (imported in place, never copied)
over a query matrix on `square-hole-handoff/fixtures/feed.json` and writes the platform pairId plus the ordered
organic pairIds per case to `packages/domain/src/__golden__/feed-select.json`. The TypeScript `selectFeed` must
reproduce every case exactly (packages/domain/src/feed-golden.test.ts).

Usage:
  python3 scripts/feed-golden.py            # (re)write the golden file
  python3 scripts/feed-golden.py --stdout   # print it (used by the up-to-date test)
  python3 scripts/feed-golden.py --check    # exit 1 when the committed golden is stale

Output is deterministic: fixed matrix order, sorted keys, one compact JSON object per case.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_DIR = ROOT / 'square-hole-handoff' / 'reference'
FIXTURE = ROOT / 'square-hole-handoff' / 'fixtures' / 'feed.json'
OUTPUT = ROOT / 'packages' / 'domain' / 'src' / '__golden__' / 'feed-select.json'

sys.dont_write_bytecode = True  # never write __pycache__ into the immutable handoff folder
sys.path.insert(0, str(REFERENCE_DIR))
from feed_model import select  # noqa: E402  (reference module, imported after the path insert)

SORTS = ('market_cap', 'new', 'turnover')
KINDS = ('all', 'token', 'nft_collection')


def by_slug(items: list[dict], slug: str) -> dict:
    return next(p for p in items if p.get('slug') == slug)


def search_matrix(items: list[dict]) -> list[tuple[str, str]]:
    orchard = by_slug(items, 'orchard')
    misfit = by_slug(items, 'misfit-studio')
    round_trip = by_slug(items, 'round-trip')
    usdc_mixed_case = '0x' + misfit['quote']['address'][2:].upper()
    return [
        ('empty', ''),
        ('orch', 'orch'),
        ('ORCHARD', 'ORCHARD'),
        ('shape', 'shape'),
        ('token-address', orchard['token']['address']),
        ('quote-address-mixed-case', usdc_mixed_case),
        ('pair-address', round_trip['pairId'].split(':', 1)[1]),
        ('zzz', 'zzz'),
        # Additions beyond the required matrix: mirror address and trim + case folding.
        ('mirror-address', orchard['mirrorAddress']),
        ('padded-mixed-case', '  Orch  '),
    ]


def reward_addresses(items: list[dict]) -> list[str]:
    selected = {
        (p['token']['address'] if p['rewardSide'] == 'T' else p['quote']['address']).lower()
        for p in items
    }
    return sorted(selected)


def build() -> dict:
    fixture_bytes = FIXTURE.read_bytes()
    reference_bytes = (REFERENCE_DIR / 'feed_model.py').read_bytes()
    items = json.loads(fixture_bytes)['items']
    cases = []
    for sort in SORTS:
        for label, search in search_matrix(items):
            for kind in KINDS:
                for reward in [None, *reward_addresses(items)]:
                    platform, rows = select(items, sort=sort, search=search, kind=kind, reward_address=reward)
                    cases.append({
                        'id': f"{sort}|{label}|{kind}|{reward or 'any-reward'}",
                        'sort': sort,
                        'search': search,
                        'kind': kind,
                        'rewardAddress': reward,
                        'platform': platform['pairId'] if platform else None,
                        'rows': [p['pairId'] for p in rows],
                    })
    return {
        'caseCount': len(cases),
        'cases': cases,
        'fixture': 'square-hole-handoff/fixtures/feed.json',
        'fixtureSha256': hashlib.sha256(fixture_bytes).hexdigest(),
        'generator': 'scripts/feed-golden.py',
        'reference': 'square-hole-handoff/reference/feed_model.py',
        'referenceSha256': hashlib.sha256(reference_bytes).hexdigest(),
    }


def render(document: dict) -> str:
    lines = ['{']
    keys = sorted(document)
    for index, key in enumerate(keys):
        comma = ',' if index < len(keys) - 1 else ''
        if key == 'cases':
            lines.append('  "cases": [')
            cases = [json.dumps(case, sort_keys=True, ensure_ascii=True) for case in document['cases']]
            lines.extend(f"    {case}{',' if i < len(cases) - 1 else ''}" for i, case in enumerate(cases))
            lines.append(f'  ]{comma}')
        else:
            lines.append(f'  {json.dumps(key)}: {json.dumps(document[key], sort_keys=True)}{comma}')
    lines.append('}')
    return '\n'.join(lines) + '\n'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--stdout', action='store_true', help='print the golden instead of writing it')
    mode.add_argument('--check', action='store_true', help='exit 1 if the committed golden is stale')
    args = parser.parse_args()
    text = render(build())
    if args.stdout:
        sys.stdout.write(text)
        return 0
    if args.check:
        current = OUTPUT.read_text(encoding='utf-8') if OUTPUT.exists() else ''
        if current != text:
            sys.stderr.write(f'{OUTPUT.relative_to(ROOT)} is stale; run python3 scripts/feed-golden.py\n')
            return 1
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding='utf-8')
    sys.stdout.write(f'wrote {OUTPUT.relative_to(ROOT)} ({json.loads(text)["caseCount"]} cases)\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
