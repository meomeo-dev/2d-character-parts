// Ambient declarations for gifenc (ships no bundled .d.ts). Only the surface
// used by server/image/animation.ts is declared.
declare module "gifenc" {
  export type RGB = [number, number, number];
  export type RGBA = [number, number, number, number];
  export type Palette = number[][];

  export type QuantizeFormat = "rgb565" | "rgb444" | "rgba4444";

  export interface QuantizeOptions {
    format?: QuantizeFormat;
    clearAlpha?: boolean;
    clearAlphaColor?: number;
    clearAlphaThreshold?: number;
    oneBitAlpha?: boolean | number;
    useSqrt?: boolean;
  }

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): Palette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: QuantizeFormat,
  ): Uint8Array;

  export interface WriteFrameOptions {
    palette?: Palette | null;
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
  }

  export interface GIFEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBufferLike;
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: WriteFrameOptions,
    ): void;
  }

  export interface GIFEncoderOptions {
    initialCapacity?: number;
    auto?: boolean;
  }

  export function GIFEncoder(options?: GIFEncoderOptions): GIFEncoderInstance;

  // gifenc ships as a UMD bundle; Node's CJS→ESM interop exposes the whole
  // module namespace as the default import, so consumers destructure from it.
  const gifenc: {
    GIFEncoder: typeof GIFEncoder;
    quantize: typeof quantize;
    applyPalette: typeof applyPalette;
  };
  export default gifenc;
}
