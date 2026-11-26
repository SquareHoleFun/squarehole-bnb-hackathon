/**
 * @squarehole/box-spec: BoxSpecV1 (launch pipeline v1 § 1, slice S1).
 *
 * - box-spec.v1.json: the single source of every box parameter (fields, types, ranges, fixed values, rules).
 * - add-ons.v1.json: the add-on catalog (F55): id, parameters, the core hook points each uses.
 * - ./generated/box-spec.v1: types, the zod schema, validateBoxSpecV1() and specHash() (twin of BoxSpecV1.sol).
 * - ./generated/fixtures.v1: box 0 (the Misfits, template 0) and three demo third-party boxes (one token-only), in wire form.
 * - ./layout: the layout library's mirror (twin of BoxLayoutV1.sol).
 * - ./creator-buy: the T a creator buy receives at creation (an estimate for display, F61 O2).
 * - checkString: the per-string check validate() runs, for per-field checks in forms.
 * - ./generated/build-profiles.v1, ./build-profile: the build profiles of core v1 (F78: mainnet, and the rehearsal at
 *   1/10 of the raise and of the fixed ETH amounts) and a version context as a given build checks it.
 */
export * from './generated/box-spec.v1';
export * from './generated/fixtures.v1';
export * from './layout';
export * from './creator-buy';
export * from './generated/build-profiles.v1';
export * from './build-profile';
export { checkString, type Verdict } from './runtime';
export * from './set-v2';
