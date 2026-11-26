#!/usr/bin/env bash
# Source from the founder's shell. Each call previews and signs exactly one transaction.
# First argument is the reviewed envelope including intrinsic gas, never a gas estimate.
#
# Fees (SH-SEP-DEPLOY-GUARD): every send carries an explicit EIP-1559 maximum fee and tip, never the RPC's suggestion
# (public Sepolia RPCs answer eth_maxPriorityFeePerGas = 1 wei, which may never be included). Sepolia defaults are v1's
# (docs/runbooks/sepolia-core-v1.md: --with-gas-price 10gwei --priority-gas-price 2gwei); export SEND_MAX_FEE and
# SEND_PRIORITY_FEE (N, Nwei or Ngwei) to change them. Sourcing exports both, so the runbook's forge commands use the
# same values. Sepolia only: send refuses any other chain, so these defaults never price a mainnet transaction
# (mainnet takes founder-approved MAX_FEE_WEI/PRIORITY_FEE_WEI per row: docs/runbooks/mainnet-core-v2.md, Manual send).
export SEND_MAX_FEE="${SEND_MAX_FEE:-10gwei}"
export SEND_PRIORITY_FEE="${SEND_PRIORITY_FEE:-2gwei}"

# Prints a fee in wei: N or Nwei (at most 15 digits) or Ngwei (at most 6 digits); refuses anything else.
send_fee_wei() {
  local value="${1:-}" digits scale
  case "$value" in
    *gwei) digits="${value%gwei}"; scale=1000000000 ;;
    *wei) digits="${value%wei}"; scale=1 ;;
    *) digits="$value"; scale=1 ;;
  esac
  case "$digits" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$scale" -eq 1 ] && [ "${#digits}" -gt 15 ]; then return 1; fi
  if [ "$scale" -ne 1 ] && [ "${#digits}" -gt 6 ]; then return 1; fi
  printf '%s\n' "$((10#$digits * scale))"
}

send() {
  local envelope="${1:-}"
  case "$envelope" in
    ''|*[!0-9]*) printf '%s\n' 'A decimal gas envelope is required' >&2; return 1 ;;
  esac
  if [ "${#envelope}" -gt 8 ] || [ "$envelope" -lt 21000 ] || [ "$envelope" -gt 16777216 ]; then
    printf '%s\n' 'Gas envelope must be within 21000..16777216' >&2
    return 1
  fi
  shift
  local arg
  for arg in "$@"; do
    case "$arg" in
      --gas-limit|--gas-limit=*|--gas|--gas=*)
        printf '%s\n' 'Do not override the reviewed envelope' >&2; return 1 ;;
      --gas-price|--gas-price=*|--priority-gas-price|--priority-gas-price=*|--legacy|--blob-gas-price|--blob-gas-price=*)
        printf '%s\n' 'Set SEND_MAX_FEE and SEND_PRIORITY_FEE instead of a fee flag' >&2; return 1 ;;
    esac
  done
  local max_fee tip
  max_fee="$(send_fee_wei "$SEND_MAX_FEE")" && tip="$(send_fee_wei "$SEND_PRIORITY_FEE")" || {
    printf '%s\n' 'SEND_MAX_FEE and SEND_PRIORITY_FEE must be N, Nwei or Ngwei' >&2; return 1
  }
  if [ "$tip" -lt 1000000 ] || [ "$tip" -gt "$max_fee" ]; then
    printf '%s\n' 'SEND_PRIORITY_FEE must be at least 0.001 gwei and at most SEND_MAX_FEE' >&2
    return 1
  fi
  local chain
  chain="$(cast chain-id --rpc-url "$RPC")" || return
  if [ "$chain" != 11155111 ]; then
    printf '%s\n' "This helper sends on Sepolia (11155111) only, not chain $chain" >&2
    return 1
  fi
  cast call "$@" --gas-limit "$envelope" --from "$WALLET" --rpc-url "$RPC" || return
  cast send "$@" --gas-limit "$envelope" --gas-price "$max_fee" --priority-gas-price "$tip" --ledger --from "$WALLET" --rpc-url "$RPC"
}
