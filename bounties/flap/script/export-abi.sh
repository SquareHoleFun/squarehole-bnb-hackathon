#!/usr/bin/env bash
# Usage: script/export-abi.sh
# Builds and writes the ABI of every contract a launch page talks to into abi/<Name>.json.
cd "$(dirname "$0")/.." || exit 1
forge build > /dev/null || exit 1
mkdir -p abi
for n in CurveLauncherFactory CurveLauncher PileVaultFactory PileVault TokenCurveLauncherFactory TokenCurveLauncher TokenPileVaultFactory RulesVaultFactory RulesVault RulesCurveLauncherFactory RulesCurveLauncher RulesTokenCurveLauncherFactory RulesTokenCurveLauncher; do
  jq '.abi' "out/$n.sol/$n.json" > "abi/$n.json" || exit 1
done
jq '.abi' out/IPortal.sol/IPortal.json > abi/FlapPortal.json || exit 1
echo "written: $(ls abi | tr '\n' ' ')"
