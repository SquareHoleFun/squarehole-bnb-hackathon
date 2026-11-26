/**
 * Safe image pipeline (SH-010; ART-01; 01-PRODUCT Step 2 "re-encode uploads to a safe image format"):
 *   size (before reading) → byte sniffing → decode → decoded size = header size → re-encode to PNG → re-inspect the
 *   output → keccak-256 of the output.
 * Re-encoding drops every metadata chunk (EXIF, XMP, comments, colour profiles), so only pixels survive. The original
 * bytes are only ever handed to the decoder; the result carries the new bytes, which are the only ones the app shows.
 * The codec is injected: the browser uses createImageBitmap + canvas (apps/web), tests use a fake.
 */
import { keccak256Hex } from './hash';
import { IMAGE_LIMITS } from './limits';
import { inspectImage, rejectionMessage, type ImageFormat, type ImageLimits, type ImageMediaType, type ImageRejectionCode } from './sniff';

/** A decoded bitmap the codec can re-encode; `close()` frees it. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface ImageCodec {
  decode(bytes: Uint8Array, mediaType: ImageMediaType): Promise<DecodedImage>;
  /** Pixels only: the output must not carry any metadata from the input. */
  encodePng(image: DecodedImage): Promise<Uint8Array>;
}

/** What the pipeline needs from a `File` (so tests need no DOM). */
export interface ImageSource {
  readonly name: string;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
}

export interface ProcessedImage {
  /** Untrusted file name, kept as text for messages only. */
  readonly fileName: string;
  readonly sourceFormat: ImageFormat;
  readonly sourceBytes: number;
  readonly mediaType: 'image/png';
  readonly width: number;
  readonly height: number;
  /** The re-encoded PNG: the only bytes that are ever displayed, hashed or stored. */
  readonly bytes: Uint8Array;
  readonly keccak256: `0x${string}`;
}

export type PipelineRejectionCode = ImageRejectionCode | 'unreadable' | 'decode_failed' | 'decode_mismatch' | 'reencode_failed';

export type ProcessResult =
  | { readonly ok: true; readonly image: ProcessedImage }
  | { readonly ok: false; readonly fileName: string; readonly code: PipelineRejectionCode; readonly message: string };

const PIPELINE_MESSAGES: Readonly<Record<'unreadable' | 'decode_failed' | 'decode_mismatch' | 'reencode_failed', string>> = {
  unreadable: 'The file could not be read.',
  decode_failed: 'The browser could not decode this image, so it cannot be re-encoded safely.',
  decode_mismatch: 'The decoded image does not match the size its header claims, so it is refused.',
  reencode_failed: 'The image could not be re-encoded to a clean PNG.',
};

export interface ProcessOptions {
  readonly limits?: ImageLimits & { readonly maxOutputBytes?: number };
}

export async function processImage(source: ImageSource, codec: ImageCodec, options: ProcessOptions = {}): Promise<ProcessResult> {
  const limits = options.limits ?? IMAGE_LIMITS;
  const fileName = source.name;
  const refuse = (code: PipelineRejectionCode, message?: string): ProcessResult => ({
    ok: false,
    fileName,
    code,
    message: message ?? (code in PIPELINE_MESSAGES ? PIPELINE_MESSAGES[code as keyof typeof PIPELINE_MESSAGES] : rejectionMessage(code as ImageRejectionCode, { limits })),
  });

  if (!Number.isFinite(source.size) || source.size > limits.maxBytes) return refuse('too_large');
  let bytes: Uint8Array;
  try {
    bytes = await source.bytes();
  } catch {
    return refuse('unreadable');
  }
  const inspected = inspectImage(bytes, limits);
  if (!inspected.ok) return refuse(inspected.code, inspected.message);

  let decoded: DecodedImage;
  try {
    decoded = await codec.decode(bytes, inspected.mediaType);
  } catch {
    return refuse('decode_failed');
  }
  try {
    const same = decoded.width === inspected.width && decoded.height === inspected.height;
    // createImageBitmap applies EXIF orientation by default, which turns a JPEG's header size by 90°.
    const turned = inspected.format === 'jpeg' && decoded.width === inspected.height && decoded.height === inspected.width;
    if (!same && !turned) return refuse('decode_mismatch');

    let output: Uint8Array;
    try {
      output = await codec.encodePng(decoded);
    } catch {
      return refuse('reencode_failed');
    }
    const maxOutput = limits.maxOutputBytes ?? IMAGE_LIMITS.maxOutputBytes;
    const check = inspectImage(output, { ...limits, maxBytes: maxOutput });
    if (!check.ok || check.format !== 'png' || check.width !== decoded.width || check.height !== decoded.height) {
      return refuse('reencode_failed');
    }
    return {
      ok: true,
      image: {
        fileName,
        sourceFormat: inspected.format,
        sourceBytes: bytes.length,
        mediaType: 'image/png',
        width: decoded.width,
        height: decoded.height,
        bytes: output,
        keccak256: keccak256Hex(output),
      },
    };
  } finally {
    decoded.close();
  }
}
