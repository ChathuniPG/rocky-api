import { crc32, deflateSync } from 'node:zlib';

/**
 * A minimal PNG encoder and a renderer for abstract demo images (gradients with simple
 * shapes), built on Node's zlib only. The demo seed uploads these instead of downloaded
 * pictures, so no copyrighted image ends up in the bucket and no image library is needed.
 */

/** An sRGB colour, each channel 0-255. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * A shape drawn over the gradient. Positions and sizes are fractions of the image, so one
 * description renders the same at any resolution: x and width of the width, y and height
 * of the height, radius and thickness of the shorter side.
 */
export type DemoShape =
  | { kind: 'circle'; cx: number; cy: number; radius: number; color: Rgb; opacity: number }
  | {
      kind: 'ring';
      cx: number;
      cy: number;
      radius: number;
      thickness: number;
      color: Rgb;
      opacity: number;
    }
  | {
      kind: 'bar';
      x: number;
      y: number;
      width: number;
      height: number;
      color: Rgb;
      opacity: number;
    };

/** Input of {@link renderDemoImage}. */
export interface DemoImageSpec {
  width: number;
  height: number;
  /** Gradient colour at the top-left corner. */
  from: Rgb;
  /** Gradient colour at the bottom-right corner. */
  to: Rgb;
  /** Drawn in order, later shapes on top. */
  shapes: readonly DemoShape[];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 3;
const BIT_DEPTH = 8;
const COLOR_TYPE_RGB = 2;
/** PNG filter type 1: each byte stores the difference to the pixel on its left. */
const FILTER_SUB = 1;
/** The PNG specification limits width and height to 2^31 - 1; demo images stay far below. */
const MAX_DIMENSION = 8192;

/**
 * Encodes 8-bit RGB pixels as a PNG file.
 *
 * @param width - Image width in pixels (1-8192).
 * @param height - Image height in pixels (1-8192).
 * @param rgb - Pixels row by row, three bytes (R, G, B) each: `width * height * 3` bytes.
 * @returns The complete PNG file.
 * @throws {RangeError} If a dimension is out of range or `rgb` has the wrong length.
 */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  assertDimension('width', width);
  assertDimension('height', height);
  if (rgb.length !== width * height * BYTES_PER_PIXEL) {
    throw new RangeError(`expected ${width * height * BYTES_PER_PIXEL} bytes of RGB pixels`);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // Bit depth, colour type, then compression, filter and interlace methods (all 0).
  header.writeUInt8(BIT_DEPTH, 8);
  header.writeUInt8(COLOR_TYPE_RGB, 9);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filterRows(width, height, rgb), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Renders a diagonal gradient with shapes on top and encodes it as PNG.
 *
 * @param spec - Size, gradient colours and shapes.
 * @returns The PNG file.
 * @throws {RangeError} If a dimension is out of range.
 */
export function renderDemoImage(spec: DemoImageSpec): Buffer {
  const { width, height } = spec;
  assertDimension('width', width);
  assertDimension('height', height);
  const pixels = Buffer.alloc(width * height * BYTES_PER_PIXEL);
  const shortSide = Math.min(width, height);
  const diagonalSteps = Math.max(width + height - 2, 1);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let color = mix(spec.from, spec.to, (x + y) / diagonalSteps);
      for (const shape of spec.shapes) {
        const coverage = shapeCoverage(shape, x + 0.5, y + 0.5, width, height, shortSide);
        if (coverage > 0) {
          color = mix(color, shape.color, coverage * shape.opacity);
        }
      }
      const offset = (y * width + x) * BYTES_PER_PIXEL;
      pixels[offset] = color.r;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.b;
    }
  }
  return encodePng(width, height, pixels);
}

function assertDimension(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new RangeError(`${name} must be an integer between 1 and ${MAX_DIMENSION}`);
  }
}

/** Length, type, data, then a CRC-32 over type and data (PNG specification §5.3). */
function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * Prefixes every row with its filter type and applies the Sub filter. Gradients change
 * slowly from pixel to pixel, so the differences are mostly tiny and repetitive, which
 * deflate compresses far better than the raw values.
 */
function filterRows(width: number, height: number, rgb: Buffer): Buffer {
  const rowBytes = width * BYTES_PER_PIXEL;
  const filtered = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const source = y * rowBytes;
    const target = y * (rowBytes + 1);
    filtered[target] = FILTER_SUB;
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= BYTES_PER_PIXEL ? rgb[source + i - BYTES_PER_PIXEL] : 0;
      // Arithmetic modulo 256, as the specification requires.
      filtered[target + 1 + i] = (rgb[source + i] - left) & 0xff;
    }
  }
  return filtered;
}

/**
 * How much of the pixel centred at (px, py) the shape covers, 0 to 1. Edges get a
 * one-pixel linear ramp, a cheap anti-aliasing that avoids jagged circles.
 */
function shapeCoverage(
  shape: DemoShape,
  px: number,
  py: number,
  width: number,
  height: number,
  shortSide: number,
): number {
  if (shape.kind === 'bar') {
    const insideX = Math.min(px - shape.x * width, (shape.x + shape.width) * width - px);
    const insideY = Math.min(py - shape.y * height, (shape.y + shape.height) * height - py);
    return edgeRamp(Math.min(insideX, insideY));
  }
  const distance = Math.hypot(px - shape.cx * width, py - shape.cy * height);
  const radius = shape.radius * shortSide;
  if (shape.kind === 'circle') {
    return edgeRamp(radius - distance);
  }
  return edgeRamp((shape.thickness * shortSide) / 2 - Math.abs(distance - radius));
}

/** Maps a signed distance to the edge (positive = inside) to a coverage between 0 and 1. */
function edgeRamp(insideDistance: number): number {
  return Math.min(Math.max(insideDistance + 0.5, 0), 1);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}
