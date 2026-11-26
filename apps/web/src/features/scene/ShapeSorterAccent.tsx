import { useEffect, useRef, useState } from 'react';
import { POSTER_STATUS, createAccentController, type AccentController, type AccentStatus, type SceneDeps } from './controller';
import { defaultSceneDeps } from './deps';
import pinPoster from './poster/shape-sorter-pin.webp';
import wizardPoster from './poster/shape-sorter-wizard.webp';
import type { SceneVariant } from './sceneTypes';
import styles from './ShapeSorterAccent.module.css';
import { VARIANTS } from './variants';

const POSTER_SRC: Readonly<Record<SceneVariant, string>> = { pin: pinPoster, wizard: wizardPoster };

export interface ShapeSorterAccentProps {
  readonly variant: SceneVariant;
  readonly className?: string;
  /** Lifecycle notifications (poster → loading → live | fallback, settled). Optional. */
  readonly onStatusChange?: (status: AccentStatus) => void;
  /**
   * Test/lab seam: replaces browser dependencies (scene loader, environment, observers).
   * Must be referentially stable; production callers omit it and feature code must not depend on it.
   * @internal
   */
  readonly deps?: Partial<SceneDeps>;
}

/**
 * Decorative shape-sorter accent (02-DESIGN "Motion and Three.js", UI-07, UI-08).
 * Paints a static poster immediately inside a fixed aspect-ratio box, then — after load, idle, in view,
 * and only when motion, data, visibility and WebGL allow — lazily imports three.js and plays one short
 * sequence before rendering stops. Everything visual is aria-hidden; nothing essential lives here.
 */
export function ShapeSorterAccent({ variant, className, onStatusChange, deps }: ShapeSorterAccentProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AccentController | null>(null);
  const listenerRef = useRef(onStatusChange);
  const [status, setStatus] = useState<AccentStatus>(POSTER_STATUS);

  useEffect(() => {
    listenerRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const controller = createAccentController({
      host,
      variant,
      deps: { ...defaultSceneDeps(window), ...deps },
      canvasClassName: styles.canvas,
      onStatus: (next) => {
        setStatus(next);
        listenerRef.current?.(next);
      },
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [variant, deps]);

  const spec = VARIANTS[variant];
  const live = status.phase === 'live';
  const rootClass = className ? `${styles.root} ${className}` : styles.root;

  return (
    <div
      className={rootClass}
      style={{ aspectRatio: spec.aspectRatio }}
      data-scene-variant={variant}
      data-scene-phase={status.phase}
      data-scene-reason={status.reason ?? undefined}
      data-scene-settled={status.settled ? 'true' : 'false'}
      data-scene-frames={status.frames ?? undefined}
    >
      <div className={styles.stage} aria-hidden="true">
        <img
          className={styles.poster}
          src={POSTER_SRC[variant]}
          width={spec.poster.width}
          height={spec.poster.height}
          alt=""
          decoding="async"
          draggable={false}
          data-hidden={live ? 'true' : undefined}
        />
        <div ref={hostRef} className={styles.host} data-visible={live ? 'true' : undefined} />
      </div>
      {live ? (
        <button
          type="button"
          className={styles.replay}
          aria-label="Replay shape-sorter animation"
          onClick={() => controllerRef.current?.replay()}
        >
          <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Replay
        </button>
      ) : null}
    </div>
  );
}
