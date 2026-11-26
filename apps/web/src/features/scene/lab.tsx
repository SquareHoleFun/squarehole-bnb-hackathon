/**
 * Dev-only lab for the shape-sorter accent (not part of the app build).
 *   lab.html                       pin + wizard mocks on the navy canvas
 *   lab.html?variant=pin           one accent (e2e)
 *   lab.html?offset=1600           accent starts below the fold (offscreen gating)
 *   lab.html?allowSoftware=1       accept a software rasteriser (GPU-less CI)
 * Posters are rendered by poster.html (see tools/render-posters.ts).
 */
import { StrictMode, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultSceneDeps } from './deps';
import { ShapeSorterAccent, type AccentStatus, type SceneVariant } from './index';

interface LabWindow extends Window {
  __sceneLab?: { readonly statuses: Readonly<Record<string, readonly AccentStatus[]>> };
  /** e2e hook: unmount the React root to prove the scene releases its GL context. */
  __sceneLabUnmount?: () => void;
}

const labWindow = window as LabWindow;
const params = new URLSearchParams(window.location.search);
const isVariant = (v: string | null): v is SceneVariant => v === 'pin' || v === 'wizard';

const labDeps = params.get('allowSoftware') === '1' ? defaultSceneDeps(window, { allowSoftware: true }) : undefined;

function record(variant: SceneVariant, status: AccentStatus): void {
  const statuses = labWindow.__sceneLab?.statuses ?? {};
  labWindow.__sceneLab = { statuses: { ...statuses, [variant]: [...(statuses[variant] ?? []), status] } };
}

const card: CSSProperties = {
  display: 'grid',
  gap: 24,
  alignItems: 'center',
  padding: 16,
  borderRadius: 16,
  background: '#111b29',
  border: '1px solid #30415d',
};
function Lab({ only, offset }: { readonly only: SceneVariant | null; readonly offset: number }) {
  const show = (v: SceneVariant) => only === null || only === v;
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>
        Scene lab
      </h1>
      <p style={{ margin: '0 0 24px', color: '#b5c0d5' }}>Dev-only harness for the decorative shape-sorter accent (SH-008).</p>
      {offset > 0 ? <div style={{ height: offset }} data-testid="spacer" /> : null}
      {show('pin') ? (
        <section style={{ ...card, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 360px)', marginBottom: 32 }}>
          <div>
            <p style={{ margin: 0, fontSize: 13, color: '#b5c0d5' }}>Platform pin · placeholder</p>
            <p style={{ margin: '4px 0 0', fontSize: 28, fontWeight: 700 }}>Square Hole</p>
            <p style={{ margin: 0, color: '#b5c0d5' }}>Different shapes. Same hole.</p>
          </div>
          <ShapeSorterAccent variant="pin" deps={labDeps} onStatusChange={(s) => record('pin', s)} />
        </section>
      ) : null}
      {show('wizard') ? (
        <section style={{ ...card, gridTemplateColumns: 'minmax(0, 320px) minmax(0, 1fr)' }}>
          <ShapeSorterAccent variant="wizard" deps={labDeps} onStatusChange={(s) => record('wizard', s)} />
          <div>
            <p style={{ margin: 0, fontSize: 13, color: '#b5c0d5' }}>Creation preview · placeholder</p>
            <p style={{ margin: '4px 0 0', fontSize: 20, fontWeight: 700 }}>Preview only</p>
            <p style={{ margin: 0, color: '#b5c0d5' }}>Decoration. Nothing here is a transaction.</p>
          </div>
        </section>
      ) : null}
    </main>
  );
}

const mount = document.getElementById('lab');
if (!mount) throw new Error('Missing #lab element');
const variant = params.get('variant');
const offset = Number.parseInt(params.get('offset') ?? '0', 10);
const root = createRoot(mount);
labWindow.__sceneLabUnmount = () => root.unmount();
root.render(
  <StrictMode>
    <Lab only={isVariant(variant) ? variant : null} offset={Number.isFinite(offset) && offset > 0 ? Math.min(offset, 5000) : 0} />
  </StrictMode>,
);
