import { parseAbi } from 'viem';

/** F156: the deliberately small wire surface, pinned by the offline Solidity vectors. */
export const TRADE_ABI = parseAbi([
  'function buy(uint256 qIn,uint256 minTokensOut,address recipient,uint256 deadline) payable returns (uint256)',
  'function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,(bool takeClaims,bool settleUsingBurn) settings,bytes hookData) payable returns (int256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function token() view returns (address)', 'function q() view returns (address)',
  'function hook() view returns (address)', 'function launchRouter() view returns (address)',
  'function coordinator() view returns (address)', 'function poolManager() view returns (address)',
  'function manager() view returns (address)', 'function raise() view returns (uint256)',
  'function boxIdOf(address coordinator) view returns (bool recorded,uint256 boxId)',
  'function phase() view returns (uint8)',
  'function poolKey() view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))',
  'function extsload(bytes32) view returns (bytes32)',
  // The launch router's own split of a window buy's input at the current block (its step's tax, what it swaps): the
  // figure a window buy shows before its approval (SH-ONE-PRESS-TRADE). A view; never sent.
  'function quote(uint256 qIn) view returns (uint256 tax, uint256 swapIn)',
]);

export const TRADE_ERRORS = parseAbi([
  'error BuyThroughLaunchRouter(address router,uint256 windowEnd)',
  'error CurveIsClosed(uint256 closedAtBlock)', 'error CurveIsClosed()',
  'error TradingNotOpen(uint256 openAt)', 'error FailurePending(uint256 deadline)',
  'error BelowCurveFloor(uint160 sqrtPriceX96)', 'error UnknownPool()',
  'error NotOpen(uint256 openAt)', 'error WindowClosed(uint256 windowEnd)', 'error Expired(uint256 deadline)',
  'error WrongValue(uint256 sent,uint256 required)', 'error InsufficientOutput(uint256 tokensOut,uint256 minTokensOut)',
  'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96,uint160 sqrtPriceLimitX96)',
  'error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)',
  'error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)',
  'error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)',
  'error NotAdmitted()', 'error CooldownActive(uint256 nextDripAt)', 'error DailyCapReached()',
  'error NotAdmitter()', 'error InvalidAdmitterLimit()', 'error AdmitterDailyCapReached()',
  'error InsufficientAllowance(uint256 available,uint256 required)', 'error InsufficientBalance(uint256 available,uint256 required)',
  'error AmountTooSmall()', 'error RecipientRefused(address recipient)',
  'error WrappedError(address target,bytes4 selector,bytes reason,bytes details)',
]);

export const COIN_ABI = parseAbi([
  'function open() view returns (bool)', 'function admitted(address) view returns (bool)',
  'function nextDripAt(address) view returns (uint256)', 'function dailyRemaining() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function drip()',
]);
