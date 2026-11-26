import { shLimit } from '../../../vitest.timeouts.mjs';
import { nodeCardEngine, type EngineKind } from './engine';
import { WEBP_LIMITS, WebpDecoder } from './webp-decoder';

let decoder: Promise<WebpDecoder> | undefined;
/** The test opt-in extends only test instances. Production's wall deadline is tested separately. */
export async function testCardEngine(kind: EngineKind = 'wasm') {
  return nodeCardEngine(kind, await (decoder ??= WebpDecoder.start({ deadlineMs: shLimit(WEBP_LIMITS.deadlineMs) })));
}
