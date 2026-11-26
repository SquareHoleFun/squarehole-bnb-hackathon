# The real run's steps, in order: scripts/real-run.sh runs them on BSC Testnet, scripts/rehearse-local.sh runs the
# same list on a local fork. Each entry: "<the exact last line the command must print>|<command>".
# `kit` and `pile` are the wrappers of scripts/kit.js and scripts/pile.js (with the preload and --expect-signer);
# $WBNB and $TETH are the two quote coins (the rehearsal puts its own coin in place of tETH).
# The tax launch trades in WBNB (judges hold tBNB, and a page can wrap it) with the smallest raise the copy allows
# (0.1; the bonding validator refuses less); the preset launch in tETH. Test BNB is scarce: see NEED_* below.
# Measured in the rehearsal: the tax launch spent 0.095 of the 0.15 WBNB wrapped; the whole run about 64M gas (kit
# 33.6M, both launches' creation and registration about 10M, every other step 20M), at 0.1 gwei 0.0064 tBNB, 0.008
# with a quarter of headroom. The preset launch spent at most 0.997 tETH.
NEED_TBNB=0.16   # 0.15 wrapped + 0.008 gas, rounded up
NEED_TETH=1.1    # the preset launch's raise of 1, its fees and trades
STEPS=(
  "OK fork|kit fork"
  "OK wrap.tax-wrap-1|pile wrap 0.15 --action tax-wrap-1"
  "OK tax-template|pile tax-template"
  "REHEARSAL-DECIMALS-PROOF|"
  "REHEARSAL-CREATE-CRASH|"
  "OK create-tax|QUOTE=\$WBNB RAISE_AMOUNT=0.1 pile create-tax"
  "OK tax.tax-buy-1|pile buy 50000000 --launch tax --action tax-buy-1"
  "REHEARSAL-FOREIGN-PROOFS|"
  "OK status tax|pile status --launch tax"
  "OK tax.tax-sell-1|pile sell 5000000 --launch tax --action tax-sell-1"
  "OK tax.tax-settle-1|pile settle --launch tax --action tax-settle-1"
  "OK tax.tax-redeem-1|pile redeem 10000000 --launch tax --action tax-redeem-1"
  "OK tax.tax-grad-1|pile graduate 0.04 --launch tax --action tax-grad-1"
  "OK tax.tax-dex-sell-1|pile dex-sell 10000000 --launch tax --action tax-dex-sell-1"
  "OK tax.tax-dex-buy-1|pile dex-buy 0.005 --launch tax --action tax-dex-buy-1"
  "OK tax.tax-redeem-2|pile redeem 100000000 --launch tax --action tax-redeem-2"
  "OK tax.tax-dex-sell-2|pile dex-sell 10000000 --launch tax --action tax-dex-sell-2"
  "OK tax.tax-settle-2|pile settle --launch tax --action tax-settle-2"
  "OK tax.tax-redeem-3|pile redeem all --launch tax --action tax-redeem-3"
  "OK status tax|pile status --launch tax"
  "REHEARSAL-SETUP-PROOF|"
  "OK register|pile register"
  "OK create|QUOTE=\$TETH RAISE_AMOUNT=1 pile create"
  "OK preset.preset-buy-1|pile buy 50000000 --launch preset --action preset-buy-1"
  "OK preset.preset-sell-1|pile sell 5000000 --launch preset --action preset-sell-1"
  "OK preset.preset-redeem-1|pile redeem 10000000 --launch preset --action preset-redeem-1"
  "REHEARSAL-CRASH-PROOFS|"
  "OK preset.preset-grad-1|pile graduate 0.3 --launch preset --action preset-grad-1"
  "OK preset.preset-dex-buy-1|pile dex-buy 0.01 --launch preset --action preset-dex-buy-1"
  "OK preset.preset-redeem-2|pile redeem all --launch preset --action preset-redeem-2"
  "OK status preset|pile status --launch preset"
  "REHEARSAL-SERVICE-PROOF|"
)

# run_step <expect> <command>: runs one step, its output shown as it comes and kept in $STEP_LOG; stops the whole run
# (exit with the command's code, or 1) unless the command exits 0, the log was written, AND its last line is exactly
# <expect>.
run_step() {
  local expect=$1 cmd=$2 code tcode last
  echo "== $cmd"
  set +e
  eval "$cmd" 2>&1 | tee "$STEP_LOG"
  code=${PIPESTATUS[0]} tcode=${PIPESTATUS[1]}
  set -e
  last=$(tail -n 1 "$STEP_LOG")
  if [ "$code" != 0 ] || [ "$tcode" != 0 ] || [ "$last" != "$expect" ]; then
    echo "== STOP: \"$cmd\" ended with exit $code and its last line was not \"$expect\". Do not go on: see the checklist in README.md."
    if [ "$code" != 0 ]; then exit "$code"; fi
    exit 1
  fi
}
