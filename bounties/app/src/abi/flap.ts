// The Flap entry's own exported ABIs (bounties/flap/abi), used as they are; plus the two PancakeSwap V2 calls the
// trade box makes and the tax token's two calls for the tax waiting to be dispatched.
import type { Abi } from 'viem';
import curveLauncherJson from '../../../flap/abi/CurveLauncher.json';
import factoryJson from '../../../flap/abi/CurveLauncherFactory.json';
import portalJson from '../../../flap/abi/FlapPortal.json';
import pileVaultJson from '../../../flap/abi/PileVault.json';
import tokenLauncherJson from '../../../flap/abi/TokenCurveLauncher.json';
import tokenFactoryJson from '../../../flap/abi/TokenCurveLauncherFactory.json';
import rulesVaultFactoryJson from '../../../flap/abi/RulesVaultFactory.json';
import rulesVaultJson from '../../../flap/abi/RulesVault.json';

export const curveLauncherAbi = curveLauncherJson as Abi;
export const curveFactoryAbi = factoryJson as Abi;
export const flapPortalAbi = portalJson as Abi;
export const pileVaultAbi = pileVaultJson as Abi;
export const tokenCurveLauncherAbi = tokenLauncherJson as Abi;
export const tokenCurveFactoryAbi = tokenFactoryJson as Abi;
/** SH-287: the rules vault factory (setRules before a sale, rulesOf, vaultOf, pileOf) and its splitter (RulesVault). */
export const rulesVaultFactoryAbi = rulesVaultFactoryJson as Abi;
export const rulesVaultAbi = rulesVaultJson as Abi;

/** Flap's test USDT (and any test coin like it): anyone may mint. */
export const publicMintAbi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** The tuple `CurveConfig` takes in `abi.encode` for `Portal.newLauncher`. */
export const curveConfigParam = [
  {
    type: 'tuple',
    components: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'meta', type: 'string' },
      { name: 'salt', type: 'bytes32' },
      { name: 'saleTokens', type: 'uint256' },
      { name: 'targetRaise', type: 'uint256' },
      { name: 'virtualBnb', type: 'uint256' },
      { name: 'duration', type: 'uint64' },
      { name: 'tradeFeeBps', type: 'uint16' },
      { name: 'buyTaxBps', type: 'uint16' },
      { name: 'sellTaxBps', type: 'uint16' },
      { name: 'burnShareBps', type: 'uint16' },
      { name: 'taxDuration', type: 'uint32' },
    ],
  },
] as const;

export const routerAbi = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export const taxTokenAbi = [
  { type: 'function', name: 'taxProcessor', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

export const taxProcessorAbi = [
  { type: 'function', name: 'dispatch', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'marketQuoteBalance',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** PancakeSwap V2 on BSC Testnet, as the Flap entry's scripts trade (bounties/flap/script/Sale.s.sol). */
export const ROUTER_97 = '0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3' as const;
export const WBNB_97 = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd' as const;
