# SH-287, the rules launch's steps, in order, after the real run (its out/ and Core's signer handed to the signing
# service): scripts/rules-run.sh runs them on BSC Testnet, scripts/rehearse-local.sh runs them after its own run on a
# local fork. Same format as scripts/steps.sh: "<the exact last line the command must print>|<command>". `pile`,
# $WBNB, $SERVICE_KEYSTORE and $SERVICE_PASSWORD_FILE come from the caller.
# The three steps marked DARK are the handover window: Core's signer is the run wallet from the first to the third,
# so the signing service's signatures are refused by Core meanwhile. They run back to back.
# Test BNB: wrap 0.15 tBNB (the 0.1 raise and the graduation rounds, as the tax launch spent 0.095 of 0.15), plus
# gas for about 30 transactions.
NEED_RULES_TBNB=0.17   # 0.15 wrapped + gas, rounded up
# ROUND: the signer handover's round (2 the first time; a retry after a stopped window takes the next number).
ROUND=${ROUND:-2}
# The rules launch's name, symbol and picture link (Core's tokenUri; empty for none). The defaults are the ones
# create-tax-rules uses when they are not set, so leaving them unset reproduces the earlier call exactly.
RULES_NAME=${RULES_NAME:-Rules Tax Demo}
RULES_SYMBOL=${RULES_SYMBOL:-RTAX}
RULES_TOKEN_URI=${RULES_TOKEN_URI:-}
STEPS_RULES=(
  "OK tax-rules-template|pile tax-rules-template"
  "OK wrap.rules-wrap-1|pile wrap 0.15 --action rules-wrap-1"
  "OK set-signer|pile set-signer --back-to-wallet --round \$ROUND"                                                   # DARK 1/3
  "OK create-tax-rules|QUOTE=\$WBNB RAISE_AMOUNT=0.1 RULES=2000,5000,3000 NAME=\"\$RULES_NAME\" SYMBOL=\"\$RULES_SYMBOL\" TOKEN_URI=\"\$RULES_TOKEN_URI\" pile create-tax-rules" # DARK 2/3
  "OK set-signer|pile set-signer --keystore \"\$SERVICE_KEYSTORE\" --password-file \"\$SERVICE_PASSWORD_FILE\" --round \$ROUND" # DARK 3/3
  "OK tax-rules.rules-buy-1|pile buy 50000000 --launch tax-rules --action rules-buy-1"
  "OK tax-rules.rules-settle-1|pile settle --launch tax-rules --action rules-settle-1"
  "OK tax-rules.rules-distribute-1|pile distribute --launch tax-rules --action rules-distribute-1"
  "OK tax-rules.rules-grad-1|pile graduate 0.04 --launch tax-rules --action rules-grad-1"
  "OK tax-rules.rules-dex-sell-1|pile dex-sell 10000000 --launch tax-rules --action rules-dex-sell-1"
  "OK tax-rules.rules-settle-2|pile settle --launch tax-rules --action rules-settle-2"
  "OK tax-rules.rules-distribute-2|pile distribute --launch tax-rules --action rules-distribute-2"
  "OK tax-rules.rules-redeem-1|pile redeem 10000000 --launch tax-rules --action rules-redeem-1"
  "OK status tax-rules|pile status --launch tax-rules"
)

# rules_restore: Core's signer back to the service's key after a stop inside the window (the first try may first
# finish an operation the stopped step left open, and then stops with exit 4: the second try sets the key). Returns 0
# when the key is set; otherwise prints the one command to run by hand.
rules_restore() {
  local back="pile set-signer --keystore \"\$SERVICE_KEYSTORE\" --password-file \"\$SERVICE_PASSWORD_FILE\" --round $ROUND"
  echo "== a window step stopped: giving Core's signer back to the service's key"
  if ( run_step "OK set-signer" "$back" ) || ( run_step "OK set-signer" "$back" ); then
    echo "== Core's signer is the service's key again. Look at the stop above; a retry takes ROUND=$((ROUND + 1))."
    return 0
  fi
  echo "RESTORE BY HAND NOW: node -r ./scripts/signer-preload.js scripts/pile.js set-signer --keystore \"$SERVICE_KEYSTORE\" --password-file \"$SERVICE_PASSWORD_FILE\" --round $ROUND --expect-signer <run wallet>"
  return 1
}

# run_rules <check function>: the steps in order. The function is called with "window" after the handback and
# "after" when the service's key is set again; a step that stops inside the window runs rules_restore, then the run
# stops.
run_rules() {
  local check=$1 dark=0 entry cmd
  for entry in "${STEPS_RULES[@]}"; do
    cmd=${entry#*|}
    case "$cmd" in *--back-to-wallet*) dark=$(date +%s) ;; esac
    if [ "$dark" != 0 ] && [[ "$cmd" != *--keystore* ]] && [[ "$cmd" != *--back-to-wallet* ]]; then
      ( run_step "${entry%%|*}" "$cmd" ) || { rules_restore; "$check" after; exit 1; }
    else
      run_step "${entry%%|*}" "$cmd"
    fi
    case "$cmd" in
      *--back-to-wallet*) "$check" window ;;
      *--keystore*) echo "== the handover window lasted $(( $(date +%s) - dark )) s"; dark=0; "$check" after ;;
    esac
  done
}
