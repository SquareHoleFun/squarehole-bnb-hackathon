import { describe, expect, it } from 'vitest';
import {
  CONTEXT_ATTRIBUTES,
  MAX_PIXEL_RATIO,
  capPixelRatio,
  isSoftwareRenderer,
  probeWebGLContext,
  readSceneEnvironment,
  staticBlockReason,
  type SceneEnvironment,
} from './gate';

const OK_ENV: SceneEnvironment = { reducedMotion: false, saveData: false, hidden: false, webgl2: true };

function fakeWindow(overrides: {
  reduce?: boolean;
  connection?: { saveData?: boolean; effectiveType?: string };
  hidden?: boolean;
  webgl2?: boolean;
}): Window {
  const matchMedia = (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? overrides.reduce === true : false,
    media: query,
  });
  return {
    matchMedia,
    navigator: { connection: overrides.connection },
    document: { visibilityState: overrides.hidden ? 'hidden' : 'visible' },
    WebGL2RenderingContext: overrides.webgl2 === false ? undefined : function WebGL2RenderingContext() {},
  } as unknown as Window;
}

describe('staticBlockReason', () => {
  it('allows the scene when nothing blocks it', () => {
    expect(staticBlockReason(OK_ENV)).toBeNull();
  });

  it('blocks on prefers-reduced-motion first', () => {
    expect(staticBlockReason({ ...OK_ENV, reducedMotion: true, saveData: true, webgl2: false })).toBe('reduced-motion');
  });

  it('blocks on data saver', () => {
    expect(staticBlockReason({ ...OK_ENV, saveData: true })).toBe('save-data');
  });

  it('blocks when WebGL2 is not available', () => {
    expect(staticBlockReason({ ...OK_ENV, webgl2: false })).toBe('no-webgl');
  });

  it('treats a hidden document as a deferral, not a permanent block', () => {
    expect(staticBlockReason({ ...OK_ENV, hidden: true })).toBeNull();
  });
});

describe('readSceneEnvironment', () => {
  it('reads reduced motion, data saver, visibility and WebGL2 support', () => {
    expect(readSceneEnvironment(fakeWindow({ reduce: true, connection: { saveData: true }, hidden: true }))).toEqual({
      reducedMotion: true,
      saveData: true,
      hidden: true,
      webgl2: true,
    });
  });

  it('treats 2G-class connections like data saver', () => {
    expect(readSceneEnvironment(fakeWindow({ connection: { effectiveType: 'slow-2g' } })).saveData).toBe(true);
    expect(readSceneEnvironment(fakeWindow({ connection: { effectiveType: '2g' } })).saveData).toBe(true);
    expect(readSceneEnvironment(fakeWindow({ connection: { effectiveType: '4g' } })).saveData).toBe(false);
  });

  it('survives missing matchMedia, connection and WebGL2 (e.g. old browsers, jsdom)', () => {
    const bare = { navigator: {}, document: { visibilityState: 'visible' } } as unknown as Window;
    expect(readSceneEnvironment(bare)).toEqual({ reducedMotion: false, saveData: false, hidden: false, webgl2: false });
  });

  it('reports WebGL2 absence', () => {
    expect(readSceneEnvironment(fakeWindow({ webgl2: false })).webgl2).toBe(false);
  });
});

describe('capPixelRatio', () => {
  it('caps high-density screens at 1.5', () => {
    expect(MAX_PIXEL_RATIO).toBe(1.5);
    expect(capPixelRatio(3)).toBe(1.5);
    expect(capPixelRatio(2)).toBe(1.5);
  });

  it('keeps lower ratios', () => {
    expect(capPixelRatio(1)).toBe(1);
    expect(capPixelRatio(1.25)).toBe(1.25);
  });

  it('falls back to 1 for invalid input', () => {
    expect(capPixelRatio(Number.NaN)).toBe(1);
    expect(capPixelRatio(0)).toBe(1);
    expect(capPixelRatio(-2)).toBe(1);
    expect(capPixelRatio(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('accepts an explicit cap for offline poster rendering', () => {
    expect(capPixelRatio(2, 2)).toBe(2);
  });
});

describe('isSoftwareRenderer', () => {
  it.each([
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'Microsoft Basic Render Driver',
    'Software Rasterizer',
  ])('flags %s', (name) => {
    expect(isSoftwareRenderer(name)).toBe(true);
  });

  it.each(['ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)', 'Apple GPU', 'Mali-G78', null])(
    'accepts %s',
    (name) => {
      expect(isSoftwareRenderer(name)).toBe(false);
    },
  );
});

describe('probeWebGLContext', () => {
  interface FakeGl {
    readonly RENDERER: number;
    getParameter: (p: number) => string;
    getExtension: (name: string) => unknown;
  }

  function canvasReturning(gl: FakeGl | null, calls: unknown[] = []): HTMLCanvasElement {
    return {
      getContext: (kind: string, attrs: unknown) => {
        calls.push([kind, attrs]);
        return gl;
      },
    } as unknown as HTMLCanvasElement;
  }

  function fakeGl(renderer: string, unmasked?: string): FakeGl {
    return {
      RENDERER: 0x1f01,
      getParameter: (p: number) => (p === 0x9246 && unmasked ? unmasked : renderer),
      getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' && unmasked ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
    };
  }

  it('requests a low-power WebGL2 context that refuses major performance caveats', () => {
    const calls: unknown[] = [];
    probeWebGLContext(canvasReturning(fakeGl('Apple GPU'), calls));
    expect(calls).toEqual([['webgl2', CONTEXT_ATTRIBUTES]]);
    expect(CONTEXT_ATTRIBUTES).toMatchObject({ powerPreference: 'low-power', failIfMajorPerformanceCaveat: true, alpha: true });
  });

  it('returns the context for a hardware renderer', () => {
    const gl = fakeGl('WebKit WebGL', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max)');
    const probe = probeWebGLContext(canvasReturning(gl));
    expect(probe).toEqual({ ok: true, context: gl });
  });

  it('fails when context creation returns null', () => {
    expect(probeWebGLContext(canvasReturning(null))).toEqual({ ok: false, reason: 'context-failed' });
  });

  it('fails when context creation throws', () => {
    const canvas = {
      getContext: () => {
        throw new Error('boom');
      },
    } as unknown as HTMLCanvasElement;
    expect(probeWebGLContext(canvas)).toEqual({ ok: false, reason: 'context-failed' });
  });

  it('rejects software rasterisers unless explicitly allowed', () => {
    const gl = fakeGl('WebKit WebGL', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)');
    const lost: string[] = [];
    const glWithLose = {
      ...gl,
      getExtension: (name: string) =>
        name === 'WEBGL_lose_context' ? { loseContext: () => lost.push('lost') } : gl.getExtension(name),
    };
    expect(probeWebGLContext(canvasReturning(glWithLose))).toEqual({ ok: false, reason: 'software-renderer' });
    expect(lost).toEqual(['lost']);
    expect(probeWebGLContext(canvasReturning(glWithLose), { allowSoftware: true })).toEqual({ ok: true, context: glWithLose });
  });

  it('reads the unmasked renderer only when the plain one is masked', () => {
    const requested: string[] = [];
    const gl: FakeGl = {
      RENDERER: 0x1f01,
      getParameter: () => 'llvmpipe (LLVM 15)',
      getExtension: (name: string) => {
        requested.push(name);
        return null;
      },
    };
    expect(probeWebGLContext(canvasReturning(gl))).toEqual({ ok: false, reason: 'software-renderer' });
    expect(requested).not.toContain('WEBGL_debug_renderer_info');
  });
});
