/** Run the existing app/package TypeScript with Node's own transformer; no generated copy of the format. */
import '../../packages/chain/scripts/register-ts.mjs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    return loaded.format === 'module-typescript'
      ? { ...loaded, format: 'module', source: stripTypeScriptTypes(String(loaded.source), { mode: 'transform' }) }
      : loaded;
  },
});

export const specV2 = await import('../../packages/box-spec/src/generated/box-spec.v2.ts');
export const artwork = await import('../../packages/artwork/src/index.ts');
export const model = await import('../../apps/web/src/features/create/create-model.ts');
export const checks = await import('../../apps/web/src/features/create/create-checks.ts');
export const artFiles = await import('../../apps/web/src/features/create/art-files.ts');
export const itemFiles = await import('../../apps/web/src/features/create/item-files.ts');
export const modelV2 = await import('../../apps/web/src/features/create/v2/model.ts');
export const picturesV2 = await import('../../apps/web/src/features/create/v2/pictures.ts');
export const recipes = await import('../../apps/web/src/features/create/v2/recipes.ts');
export const listingsV2 = await import('../../apps/web/src/features/create/v2/listings.ts');

export const shrink = await import('../../apps/web/src/features/pictures/shrink.ts');
export const arweave = await import('../../apps/web/src/features/pictures/arweave-publish.ts');
export const pictureTypes = await import('../../apps/web/src/features/pictures/picture-type.ts');
export const artPlan = await import('../../apps/web/src/features/create/art-plan.ts');
