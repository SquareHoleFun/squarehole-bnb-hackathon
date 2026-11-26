#!/usr/bin/env python3
"""Makes, and checks, the text-only copies of the four launcher sources used by the rules pair.

  python3 script/rules-launchers.py write   # (re)writes src/Rules*CurveLauncher*.sol from the deployed sources
  python3 script/rules-launchers.py check   # proves the copies differ from the originals only in names, string
                                            # literals and comments (exit 1 otherwise)

The rules pair needs the launchers' on-chain texts (the Launcher's description() and the factory's
launcherDataSchema()) to say that the income is shared by the creator's rules; everything else stays the code that is
deployed. Names change only so both families can live in one build.
"""
import re
import sys

RENAMES = [  # (original identifier, copy identifier), longest first
    ("TokenCurveLauncherFactory", "RulesTokenCurveLauncherFactory"),
    ("CurveLauncherFactory", "RulesCurveLauncherFactory"),
    ("TokenCurveLauncher", "RulesTokenCurveLauncher"),
    ("CurveLauncher", "RulesCurveLauncher"),
]
FILES = ["CurveLauncher", "CurveLauncherFactory", "TokenCurveLauncher", "TokenCurveLauncherFactory"]

RULES_SUMMARY = (
    "Curve fees and part of every later trade's tax are shared by the creator's rules (creator, pile, buy and "
    "burn), fixed before the sale opened: read them at the RulesVaultFactory with rulesOf(this launcher); without "
    "rules, all of it fills a pile any holder can redeem."
)
TEXT = {  # exact string-literal replacements, per original file
    "CurveLauncher": [
        ('"Curve sale with a pile"', '"Curve sale with the creator\'s rules"'),
        ('"share of the BNB. Curve fees and part of every later trade\'s tax fill a pile any holder can redeem."',
         '"share of the BNB. " "' + RULES_SUMMARY.replace('"', '\\"') + '"'),
    ],
    "TokenCurveLauncher": [
        ('"Curve sale with a pile"', '"Curve sale with the creator\'s rules"'),
        ('"share. Curve fees and part of every later trade\'s tax fill a pile any holder can redeem."',
         '"share. " "' + RULES_SUMMARY.replace('"', '\\"') + '"'),
    ],
    "CurveLauncherFactory": [
        ('"Curve sale with a pile: buy', '"Curve sale with the creator\'s rules: buy'),
        ('"a missed deadline unwinds the sale. Curve fees and part of every later trade\'s tax fill a pile any holder "\n            "redeems.',
         '"a missed deadline unwinds the sale. Curve fees and part of every later trade\'s tax are shared by the "\n'
         '            "creator\'s rules (creator, pile, buy and burn), set at the RulesVaultFactory before the sale is created "\n'
         '            "(rulesOf); without rules, all of it fills a pile any holder redeems.'),
    ],
    "TokenCurveLauncherFactory": [
        ('"Curve sale with a pile: buy', '"Curve sale with the creator\'s rules: buy'),
        ('"a missed deadline unwinds the sale. Curve fees and part of every later trade\'s tax fill a pile any holder "\n            "redeems.',
         '"a missed deadline unwinds the sale. Curve fees and part of every later trade\'s tax are shared by the "\n'
         '            "creator\'s rules (creator, pile, buy and burn), set at the RulesVaultFactory before the sale is created "\n'
         '            "(rulesOf); without rules, all of it fills a pile any holder redeems.'),
    ],
}
HEADER = ("// Text-only copy of src/{orig}.sol for the rules pair (script/rules-launchers.py): only names, string\n"
          "// literals and comments differ.\n")


def rename(src, forward=True):
    pairs = RENAMES if forward else [(b, a) for a, b in RENAMES]
    for a, b in pairs:
        src = re.sub(r"\b" + a + r"\b", b, src)
        src = src.replace('"./' + a + '.sol"', '"./' + b + '.sol"')
    return src


def write():
    for f in FILES:
        src = open(f"src/{f}.sol").read()
        for old, new in TEXT[f]:
            if old not in src:
                sys.exit(f"text not found in {f}: {old[:60]}")
            src = src.replace(old, new)
        src = rename(src)
        src = src.replace("pragma solidity", HEADER.format(orig=f) + "pragma solidity", 1)
        open(f"src/Rules{f}.sol", "w").write(src)
    print("written")


def strip(src):
    """Drops comments and the contents of string literals; joins adjacent literals."""
    out, i, n = [], 0, len(src)
    while i < n:
        if src.startswith("//", i):
            i = src.find("\n", i)
            i = n if i < 0 else i
        elif src.startswith("/*", i):
            i = src.find("*/", i) + 2
        elif src[i] == '"':
            j = i + 1
            while src[j] != '"':
                j += 2 if src[j] == "\\" else 1
            out.append('""')
            i = j + 1
        else:
            out.append(src[i])
            i += 1
    text = "".join(out)
    text = re.sub(r'""(\s*"")+', '""', text)  # adjacent literals are one literal
    text = text.replace('unicode""', '""')
    return re.sub(r"\s+", " ", text).strip()


def check():
    ok = True
    for f in FILES:
        orig = strip(open(f"src/{f}.sol").read())
        copy = strip(rename(open(f"src/Rules{f}.sol").read(), forward=False))
        same = orig == copy
        ok = ok and same
        print(f"{f}: {'only names, strings and comments differ' if same else 'CODE DIFFERS'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    {"write": write, "check": check}[sys.argv[1]]()
