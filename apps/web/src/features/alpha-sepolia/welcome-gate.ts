/**
 * F166 (SH-ALPHA-ONBOARDING): whether the alpha's welcome step has something for this visitor, decided before any trade
 * code loads. The shell's mount (shell/AlphaWelcomeMount.tsx) loads this small module lazily in Sepolia trade builds,
 * asks our server once (`GET /alpha/me`) and reads this device's hint. The shell loads the step for a setup offer,
 * a run already in progress, or a signed-in visitor's remembered wallet. The Claim card uses the same setup offers.
 * A run keeps the step mounted (setup-signal.ts), so its chip stays in the top bar (af2).
 */
import { alphaApi, type AlphaApi, type AlphaMe } from './alpha-api';
import { JOIN_WORDS, claimReleased } from './alpha-words';
import { readSetupHint, type SetupHintRecord } from './setup-hint';
import { setupRunLive, subscribeSetupRun } from './setup-signal';

export { rememberedMadeWallet } from './made-wallet-memory';
export { readSetupHint, setupRunLive, subscribeSetupRun };

/**
 * What is offered, decided with our server's claim (af1 F6): never while a wallet of the tester's own is connected or
 * connecting (its window's answer comes first, XR-ALPHA-SITE af3); "Finish setup" (`finish`) after a setup this device
 * left midway, while our server holds no claim, one the sender's dry run freed, or the very claim that setup made
 * (`claimId`); "Set me up" (`start`) with no hint while no claim stands (or one the dry run freed); else nothing (`null`):
 * a setup done, one that ended where no press can help, today's steps chosen or used, or a claim made another way.
 */
export function welcomeOffer(me: AlphaMe | null, hint: SetupHintRecord | null, ownWallet: boolean): 'start' | 'finish' | null {
  if (me === null || me.status !== 'approved' || ownWallet) return null;
  const open = me.claim === null || claimReleased(me.claim);
  if (hint?.state === 'started') return open || (hint.claimId !== null && hint.claimId === me.claim?.id) ? 'finish' : null;
  if (hint !== null) return null;
  return open ? 'start' : null;
}

/** Who is signed in, as our server says (null without an answer it can read: the step then offers nothing). */
export async function welcomeMe(api: AlphaApi = alphaApi()): Promise<AlphaMe | null> {
  const me = await api.me();
  return me.ok ? me.value : null;
}

/**
 * SH-275: the same one request, telling a visitor our server knows no sign-in for (`stranger`, its 401) from one it
 * gave no answer it can read (null, as `welcomeMe`). Only a stranger on an open site (alpha-on.ts `ALPHA_OPEN`) gets the
 * way to the join page; with the sign-in service down or absent, nothing is offered.
 */
export async function welcomeVisitor(api: AlphaApi = alphaApi()): Promise<AlphaMe | 'stranger' | null> {
  const me = await api.me();
  return me.ok ? me.value : me.status === 401 ? 'stranger' : null;
}

/** SH-275: the open site's way to the join page, in the join page's own button text. */
export const JOIN_ENTRY = JOIN_WORDS.signIn;
/** Where it leads: the join page (its own build, build/alpha-pages.ts). */
export const JOIN_PATH = '/join';
