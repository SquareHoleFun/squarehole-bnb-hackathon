import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const unfinishedForget = 'a forget run is unfinished: run it again';
export const forgetManifest = receipts => join(receipts, 'forget-tester.json');
export function assertNoForget(receipts) {
  const path = forgetManifest(receipts);
  if (existsSync(path) || existsSync(`${path}.prepare`)) throw new Error(unfinishedForget);
}
