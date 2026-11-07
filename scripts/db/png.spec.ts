import { crc32, inflateSync } from 'node:zlib';
import { detectMediaType } from '../../src/modules/uploads/media-signature';
import { MAX_IMAGE_BYTES } from '../../src/modules/uploads/uploads.constants';
import { type DemoImageSpec, encodePng, renderDemoImage, type Rgb } from './png';

interface PngChunk {
  type: string;
  data: Buffer;
}

interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  pixels: Buffer;
}

/** Splits a PNG into chunks, failing on a bad CRC: an independent check of the encoder. */
function readChunks(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const storedCrc = png.readUInt32BE(offset + 8 + length);
    expect(storedCrc).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

/** Decodes the RGB, non-interlaced PNGs the encoder writes (filter types 0 and 1 only). */
function decodePng(png: Buffer): DecodedPng {
  const chunks = readChunks(png);
  const header = chunks[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const raw = inflateSync(
    Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)),
  );
  const rowBytes = width * 3;
  const pixels = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    for (let i = 0; i < rowBytes; i++) {
      const value = raw[y * (rowBytes + 1) + 1 + i];
      const left = filter === 1 && i >= 3 ? pixels[y * rowBytes + i - 3] : 0;
      pixels[y * rowBytes + i] = (value + left) & 0xff;
    }
  }
  return { width, height, bitDepth: header[8], colorType: header[9], pixels };
}

function pixelAt(decoded: DecodedPng, x: number, y: number): Rgb {
  const offset = (y * decoded.width + x) * 3;
  return {
    r: decoded.pixels[offset],
    g: decoded.pixels[offset + 1],
    b: decoded.pixels[offset + 2],
  };
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const RED: Rgb = { r: 255, g: 0, b: 0 };

describe('encodePng', () => {
  it('writes signature, IHDR, IDAT and IEND in that order', () => {
    const png = encodePng(2, 1, Buffer.from([1, 2, 3, 4, 5, 6]));

    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(readChunks(png).map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('round-trips the exact pixels as 8-bit RGB', () => {
    const width = 7;
    const height = 5;
    const rgb = Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => (i * 37) % 256));

    const decoded = decodePng(encodePng(width, height, rgb));

    expect(decoded).toMatchObject({ width, height, bitDepth: 8, colorType: 2 });
    expect(decoded.pixels).toEqual(rgb);
  });

  it('is recognised as PNG by the upload magic-byte check', () => {
    expect(detectMediaType(encodePng(1, 1, Buffer.from([0, 0, 0])))?.contentType).toBe('image/png');
  });

  it.each([
    [0, 1],
    [1, 0],
    [1.5, 1],
    [8193, 1],
  ])('rejects a %p x %p image', (width, height) => {
    expect(() => encodePng(width, height, Buffer.alloc(0))).toThrow(RangeError);
  });

  it('rejects pixel data of the wrong length', () => {
    expect(() => encodePng(2, 2, Buffer.alloc(11))).toThrow(/expected 12 bytes/);
  });
});

describe('renderDemoImage', () => {
  const base: DemoImageSpec = { width: 40, height: 20, from: BLACK, to: WHITE, shapes: [] };

  it('draws a diagonal gradient from the top-left to the bottom-right colour', () => {
    const decoded = decodePng(renderDemoImage(base));

    expect(pixelAt(decoded, 0, 0)).toEqual(BLACK);
    expect(pixelAt(decoded, 39, 19)).toEqual(WHITE);
    expect(pixelAt(decoded, 20, 10).r).toBeGreaterThan(100);
    expect(pixelAt(decoded, 20, 10).r).toBeLessThan(155);
  });

  it('paints shapes over the gradient, opaque inside and untouched outside', () => {
    const decoded = decodePng(
      renderDemoImage({
        ...base,
        shapes: [
          { kind: 'circle', cx: 0.25, cy: 0.5, radius: 0.3, color: RED, opacity: 1 },
          { kind: 'bar', x: 0.75, y: 0, width: 0.25, height: 1, color: RED, opacity: 1 },
        ],
      }),
    );

    expect(pixelAt(decoded, 10, 10)).toEqual(RED);
    expect(pixelAt(decoded, 35, 3)).toEqual(RED);
    expect(pixelAt(decoded, 0, 0)).toEqual(BLACK);
  });

  it('leaves the centre of a ring unpainted', () => {
    const decoded = decodePng(
      renderDemoImage({
        ...base,
        from: WHITE,
        shapes: [
          {
            kind: 'ring',
            cx: 0.5,
            cy: 0.5,
            radius: 0.4,
            thickness: 0.15,
            color: RED,
            opacity: 1,
          },
        ],
      }),
    );

    expect(pixelAt(decoded, 20, 10)).toEqual(WHITE);
    expect(pixelAt(decoded, 20, 2)).toEqual(RED);
  });

  it('keeps a full-size post image well under the upload limit', () => {
    const png = renderDemoImage({
      width: 540,
      height: 960,
      from: { r: 255, g: 94, b: 98 },
      to: { r: 64, g: 40, b: 160 },
      shapes: [
        { kind: 'circle', cx: 0.3, cy: 0.3, radius: 0.25, color: WHITE, opacity: 0.4 },
        {
          kind: 'ring',
          cx: 0.7,
          cy: 0.7,
          radius: 0.3,
          thickness: 0.05,
          color: WHITE,
          opacity: 0.7,
        },
      ],
    });

    expect(png.length).toBeLessThan(MAX_IMAGE_BYTES);
    expect(detectMediaType(png)?.contentType).toBe('image/png');
  });
});
