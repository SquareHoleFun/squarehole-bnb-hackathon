// SH-AUDIT-B0-U9 (Fable): `node --import ./AuditU9FableGenRegister.mjs AuditU9FableGen.mjs` loads the TypeScript twin
// (packages/box-spec/src) through Node 24's built-in type stripping; the hooks module resolves the twin's extensionless
// relative imports and its bare `viem` / `zod` imports from the box-spec package. No network, no build step.
import { register } from 'node:module';

register('./AuditU9FableGenHooks.mjs', import.meta.url);
