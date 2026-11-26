import { STARTER } from './chain.mjs';

export const FLOAT_REASON = 'insufficient float for starter and gas';
// Default: five starters of the chain (SH-275: chain 97 passes its own; Sepolia's is STARTER).
export function floatThreshold(env = process.env, starter = STARTER) {
  return validateFloatThreshold(env.SH_ALPHA_LOW_FLOAT_WEI ?? String(5n * starter));
}
export function validateFloatThreshold(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value)) throw new Error('invalid float threshold');
  return value;
}
