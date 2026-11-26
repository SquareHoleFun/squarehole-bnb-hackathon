/**
 * A revealed item's 3D model (MF23-6; T06 for v2 items): the one viewer of the v1 item list (boxes/ChainItems.tsx) and the
 * v2 items panel (core/v2/VaultItemsV2.tsx). It exists only after an explicit press: its host renders, then the model is
 * asked for, once, at one url through loadItemModel (controller.ts: a 5 s deadline, no redirects, at most one raw block
 * declared and streamed, a self-contained binary glTF 2.0 whose bytes hash to the commitment) and drawn by the still
 * renderer (deps.ts `mountItemModel`, OrbitControls: drag or touch to turn it). Unmounting it (Close, Escape, leaving the
 * page) aborts the read and disposes the renderer, its geometry and materials and its WebGL context. three.js is a
 * separate chunk that loads only then; nothing here runs on navigation.
 */
import { useEffect, useRef, useState } from 'react';

export type ItemModelOutcome = 'shown' | 'failed';

/** Draws the model asked for at `url` into `host` once its bytes pass every check; resolves with its disposal. */
export type ItemModelLoader = (host: HTMLElement, url: string, sha256: `0x${string}`, signal: AbortSignal, options: ItemModelOptions) => Promise<() => void>;

export interface ItemModelOptions {
  /** The arrow keys turn the model while its view has focus. */
  readonly keyboard: boolean;
  /** Asked with no cookies and no referrer (a public IPFS gateway). */
  readonly anonymous: boolean;
}

/**
 * The default loader: one request, through loadItemModel. Any failure ends the load (no answer in time, an error
 * status, a redirect, too many bytes, not a self-contained GLB, another hash, nothing to draw), and the caller keeps the
 * picture: no second gateway is asked (XR-ITEM-3D-V2 F3), so one press asks for the model at most once.
 */
export const loadModel: ItemModelLoader = async (host, url, sha256, signal, { keyboard, anonymous }) => {
  const { loadItemModel } = await import('./controller');
  const fetcher = anonymous ? (target: string, init?: RequestInit) => fetch(target, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }) : undefined;
  // v1 keeps the plain renderer (OrbitControls' defaults); the arrow keys are v2's opt-in.
  const mount = keyboard ? async (element: HTMLElement, bytes: Uint8Array) => (await import('./deps')).mountItemModel(element, bytes, { keyboard: true }) : undefined;
  return loadItemModel(host, url, sha256, signal, fetcher, mount);
};

export interface ItemModelViewProps {
  /** Where the model's bytes are asked (one request: no other url is tried). */
  readonly url: string;
  /** The model's committed SHA-256. */
  readonly sha256: `0x${string}`;
  /** The view's accessible name (it is an image). */
  readonly label: string;
  readonly className?: string;
  /** v2: the arrow keys turn the model; once drawn, the view takes focus with Tab. */
  readonly keyboard?: boolean;
  readonly anonymous?: boolean;
  readonly describedBy?: string;
  /** How the load ended; never called after the view closed. */
  readonly onOutcome?: (outcome: ItemModelOutcome) => void;
  /** Test seam: the loader (default: `loadModel`). */
  readonly load?: ItemModelLoader;
}

export function ItemModelView({ url, sha256, label, className, keyboard = false, anonymous = false, describedBy, onOutcome, load = loadModel }: ItemModelViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  // The latest callback, so a new function from the parent never restarts the load.
  const report = useRef(onOutcome);
  useEffect(() => {
    report.current = onOutcome;
  });
  useEffect(() => {
    const element = host.current;
    if (!element || url === '') return undefined;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    load(element, url, sha256, controller.signal, { keyboard, anonymous }).then((cleanup) => {
      if (controller.signal.aborted) {
        cleanup();
        return;
      }
      dispose = cleanup;
      setShown(true);
      report.current?.('shown');
    }).catch(() => {
      if (!controller.signal.aborted) report.current?.('failed');
    });
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [url, sha256, keyboard, anonymous, load]);
  // With the arrow keys on, a drawn view is a widget (a screen reader in browse mode would keep the arrows for itself
  // on an image): an application named as a 3D model. Otherwise, and until drawn, an image.
  const turnable = keyboard && shown;
  return <div ref={host} className={className} role={turnable ? 'application' : 'img'} aria-roledescription={turnable ? '3D model' : undefined}
    aria-label={label} aria-describedby={describedBy} tabIndex={turnable ? 0 : undefined} />;
}
