import { isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

const address = z.string().refine(s => isAddress(s, { strict: false }), 'invalid Safe address')
  .transform(s => s.toLowerCase() as Address);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s => s.toLowerCase() as Hex);
const nonzeroHash = hash.refine(s => BigInt(s) !== 0n, 'missing reviewed runtime hash');

/** Identity recorded by DeployCoreV2 before deployment; each role has its own reviewed configuration. */
export const safeConfigV2Schema = z.strictObject({
  version: z.enum(['1.4.1', '1.5.0']), codeHash: nonzeroHash,
  singleton: address.refine(a => a !== zeroAddress), singletonCodeHash: nonzeroHash,
  guard: address, guardCodeHash: hash, handler: address, handlerCodeHash: hash,
}).superRefine((s, ctx) => {
  for (const name of ['guard', 'handler'] as const) {
    if ((s[name] === zeroAddress) !== (BigInt(s[`${name}CodeHash`]) === 0n)) {
      ctx.addIssue({ code: 'custom', path: [`${name}CodeHash`], message: 'code hash must match presence of reviewed contract' });
    }
  }
});

export const safePinV2Schema = safeConfigV2Schema.safeExtend({
  address: address.refine(a => a !== zeroAddress), owners: z.array(address.refine(a => BigInt(a) > 1n)).min(1),
  threshold: z.string().regex(/^[1-9][0-9]*$/), modulesEnabled: z.literal(false),
  controlTransferProof: z.string().min(1).optional(),
});
