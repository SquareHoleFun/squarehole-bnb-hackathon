#!/usr/bin/env bash
# Usage: script/export-abi.sh
# SH-288: builds and writes the ABI of the card shop and its factory (what a page talks to) into abi/<Name>.json.
cd "$(dirname "$0")/.." || exit 1
forge build > /dev/null || exit 1
mkdir -p abi
for n in RailShop RailShopFactory; do
  jq '.abi' "out/$n.sol/$n.json" > "abi/$n.json" || exit 1
done
echo "written: $(ls abi | tr '\n' ' ')"
