/**
 * SH-BOX-CANDLES test support: candle-canvas.ts without the library (jsdom has no canvas). A test mocks the module with
 * this one (`vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'))`) and reads what the chart
 * was asked to draw; `hover` plays the library's crosshair.
 */
import type { CandleCanvasV2, CandlePaletteV2, CandleSceneV2 } from '../candle-canvas';

export const fakeCanvas = {
  created: 0,
  destroyed: 0,
  scenes: [] as CandleSceneV2[],
  palette: null as CandlePaletteV2 | null,
  element: null as HTMLElement | null,
  hover: (start: bigint | null): void => void start,
  reset(): void {
    this.created = 0;
    this.destroyed = 0;
    this.scenes = [];
    this.palette = null;
    this.element = null;
    this.hover = () => undefined;
  },
};

export function createCandleCanvasV2(element: HTMLElement, palette: CandlePaletteV2, onHover: (start: bigint | null) => void): CandleCanvasV2 {
  fakeCanvas.created += 1;
  fakeCanvas.element = element;
  fakeCanvas.palette = palette;
  fakeCanvas.hover = onHover;
  return {
    show: (scene) => void fakeCanvas.scenes.push(scene),
    destroy: () => void (fakeCanvas.destroyed += 1),
  };
}
