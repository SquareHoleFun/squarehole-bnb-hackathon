/**
 * The one import of the chain package's v2 shapes (packages/chain/src/core/v2). `@squarehole/chain` does not export them
 * yet, since its index.ts is not M1-52's file; once the integrator adds `export * from './core/v2'` there
 * (SH-V2-M1-52.md, change request 1), this line becomes `export * from '@squarehole/chain'` and nothing else changes.
 */
export * from '../../../../chain/src/core/v2';
