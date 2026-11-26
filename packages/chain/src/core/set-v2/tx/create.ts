import { encodeFunctionData, erc20Abi, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { setUint256Schema, encodeSetSpecV2, type SetSpecV2 } from '@squarehole/box-spec';
import { setFactoryV2Abi } from '../abi-set-v2';
import { findCreateSaltsV2, type CreateSaltInputsV2 } from '../../v2/create-salts';
import { estimateCreateGasV2, type CreateGasRequestV2 } from '../../v2/create-calls-v2';
import { EIP7825_TX_GAS_CAP } from '../../../write/chains';
import { NotSendableError } from '../../../write/calls';
import { setCall, type SetCallV2 } from './calls';
export interface SetCreatePlanV2 {
  readonly chainId: number; readonly factory: Address; readonly creator: Address;
  readonly spec: SetSpecV2; readonly cs: Hex; readonly hs: Hex;
  /** boxQParameters(listingId, raise).bootstrapQ at the same block as predictBox and the admitted listing. */
  readonly bootstrapQ: bigint;
}
export function setCreateCalls(plan: SetCreatePlanV2): readonly SetCallV2[] {
  encodeSetSpecV2(plan.spec);
  if (!Number.isSafeInteger(plan.chainId) || plan.chainId <= 0 || !isAddress(plan.creator) || plan.creator === zeroAddress
    || !isAddress(plan.factory) || plan.factory === zeroAddress || plan.factory.toLowerCase() === plan.spec.pricing.token.toLowerCase()
    || ![plan.cs,plan.hs].every(h=>/^0x[\da-f]{64}$/i.test(h))) throw new NotSendableError('invalid set creation plan');
  setUint256Schema.parse(plan.bootstrapQ);
  const payment = setUint256Schema.parse(plan.bootstrapQ + plan.spec.creatorBuy);
  const native = plan.spec.pricing.token.toLowerCase() === zeroAddress;
  return [...(native ? [] : [setCall(plan.spec.pricing.token,erc20Abi,'approve',[plan.factory,payment])]),
    {to:plan.factory,value:native?payment:0n,data:encodeFunctionData({abi:setFactoryV2Abi,functionName:'createBox',args:[plan.spec,plan.cs,plan.hs]})}];
}
export function assertSendableSetCreate(call: SetCallV2, plan: SetCreatePlanV2, from: Address): void {
  if (from.toLowerCase() !== plan.creator.toLowerCase() || !setCreateCalls(plan).some(c=>c.to.toLowerCase()===call.to.toLowerCase()
    && c.data.toLowerCase()===call.data.toLowerCase() && c.value===call.value)) throw new NotSendableError('not an exact set creation step');
}
export const findSetCreateSalts = (input: CreateSaltInputsV2) => findCreateSaltsV2(input);
export const estimateSetCreateGas = (estimate: (request: CreateGasRequestV2)=>Promise<bigint>, request: CreateGasRequestV2, blockGasLimit: bigint) =>
  estimateCreateGasV2(estimate,request,blockGasLimit,EIP7825_TX_GAS_CAP);
