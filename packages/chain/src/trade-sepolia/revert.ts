import { decodeErrorResult, type Hex } from 'viem';
import { RpcShapeError } from '../write/eip1193';
import { revertDataOf } from '../write/revert';
import { RpcRequestError } from '../write/rpc';
import { TRADE_ERRORS } from './abi';

const reasons = {
  BuyThroughLaunchRouter: 'buy_through_launch_router', CurveIsClosed: 'curve_closed',
  TradingNotOpen: 'trading_not_open', FailurePending: 'failure_pending', BelowCurveFloor: 'below_curve_floor',
  UnknownPool: 'unknown_pool', NotOpen: 'not_open', WindowClosed: 'window_closed', Expired: 'expired',
  WrongValue: 'wrong_value', InsufficientOutput: 'insufficient_output', AmountTooSmall: 'amount_too_small',
  RecipientRefused: 'recipient_refused', PriceLimitAlreadyExceeded: 'price_limit_already_exceeded',
  PriceLimitOutOfBounds: 'price_limit_out_of_bounds',
  NotAdmitted: 'not_admitted', CooldownActive: 'cooldown_active', DailyCapReached: 'daily_cap_reached',
  NotAdmitter: 'not_admitter', InvalidAdmitterLimit: 'invalid_admitter_limit', AdmitterDailyCapReached: 'admitter_daily_cap_reached',
  ERC20InsufficientAllowance: 'insufficient_allowance', ERC20InsufficientBalance: 'insufficient_balance',
  InsufficientAllowance: 'insufficient_allowance', InsufficientBalance: 'insufficient_balance',
} as const;
export type TradeRevertReason = typeof reasons[keyof typeof reasons] | 'unknown_revert';

/** Accepts encoded revert bytes or the nested RPC/viem error. Never infers a contract reason from message text. */
export function decodeTradeRevert(error: unknown): TradeRevertReason {
  let data = typeof error === 'string' ? error as Hex : revertDataOf(error);
  for (let depth = 0; data && depth < 8; depth++) {
    try {
      const decoded = decodeErrorResult({ abi: TRADE_ERRORS, data });
      if (decoded.errorName !== 'WrappedError') return reasons[decoded.errorName] ?? 'unknown_revert';
      data = decoded.args[2];
    } catch { return 'unknown_revert'; }
  }
  return 'unknown_revert';
}

/**
 * JSON-RPC codes for a request the node did not answer, as opposed to a call it ran: a block it does not have yet
 * (publicnode's -32001 "block not found" for the block another of its nodes just named), a resource unavailable or
 * limited (-32002, -32005), an internal error (-32603: a fork's upstream read reset), or the HTTP 429 of a rate limit.
 */
const READ_FAILURE_CODES: ReadonlySet<number> = new Set([-32001, -32002, -32005, -32603, 429]);

/**
 * SH-ONE-PRESS-TRADE: whether a failed plan is a read the site's RPC did not answer (no revert data; a transport failure,
 * a malformed answer, or one of the codes above), so a plan says `rpc_failed` and the page tries again quietly, instead
 * of `read_or_simulation_failed`. Anything carrying revert data, and the codes a node uses for a revert (3, -32000),
 * stay the contract's answer.
 */
export function isReadFailure(error: unknown): boolean {
  if (revertDataOf(error) !== null) return false;
  if (error instanceof RpcShapeError) return true;
  return error instanceof RpcRequestError && (error.code === null || READ_FAILURE_CODES.has(error.code));
}
