import { z } from 'zod';
import { SET_FORMAT, SET_SCHEMA, SET_RELEASE, SET_TEMPLATE, setAddressSchema, setSpecV2Schema } from '@squarehole/box-spec';

/** Wire schemas preserve decimal strings. Consumers explicitly use BigInt at their arithmetic boundary. */
export const setDecimalStringSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
  .pipe(z.string().refine(s => BigInt(s) < (1n << 256n)));
const decimal = setDecimalStringSchema;
const address = setAddressSchema;
const hash = z.templateLiteral(['0x', z.string()]).refine(s => /^0x[0-9a-fA-F]{64}$/.test(s));
const bytes = z.templateLiteral(['0x', z.string()]).refine(s => /^0x(?:[0-9a-fA-F]{2})+$/.test(s));
const domain = (value: string) => hash.refine(s => s.toLowerCase() === value);
export const setMemberStateSchema = z.enum(['Inside', 'Outside', 'Released', 'Deferred']);
export type SetMemberState = z.infer<typeof setMemberStateSchema>;
const asOf = z.strictObject({ block: decimal, hash, tier: z.enum(['latest', 'confirmed', 'finalized']) });
const envelope = { chainId: z.number().int().positive().max(0xffffffff), asOf };
const spec = z.strictObject({
  ...setSpecV2Schema.shape, format: z.literal(SET_FORMAT), schema: domain(SET_SCHEMA), release: domain(SET_RELEASE),
  raise: decimal, creatorBuy: decimal,
});
export const setBoxDataSchema = z.strictObject({
  registry: address, boxId: decimal, coordinator: address, token: address, vault: address, loader: address,
  creator: address, collection: address, templateId: domain(SET_TEMPLATE), specHash: hash, encodedSpec: bytes, spec,
  state: z.strictObject({
    loaded: decimal, inside: decimal, totalSupply: decimal, escrowPrincipal: decimal,
    gateOpen: z.boolean(), failed: z.boolean(), seedReady: z.boolean(), remainingHash: hash,
  }),
});
export const setFeedSchema = z.strictObject({ schema: z.literal('sh.core-set-feed.v1'), ...envelope, boxes: z.array(setBoxDataSchema) });
export const setBoxSchema = z.strictObject({ schema: z.literal('sh.core-set-box.v1'), ...envelope, box: setBoxDataSchema });
export const setMembersSchema = z.strictObject({
  schema: z.literal('sh.core-set-members.v1'), ...envelope,
  registry: address, boxId: decimal, collection: address, setHash: hash,
  offset: decimal, nextOffset: decimal.nullable(),
  members: z.array(z.strictObject({ index: decimal, id: decimal, state: setMemberStateSchema })).max(10000),
});
export type SetBoxData = z.infer<typeof setBoxDataSchema>;
export type SetFeedWire = z.infer<typeof setFeedSchema>;
export type SetBoxWire = z.infer<typeof setBoxSchema>;
export type SetMembersWire = z.infer<typeof setMembersSchema>;
