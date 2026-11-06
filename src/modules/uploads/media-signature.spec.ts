import { MediaType } from '../../generated/prisma/enums';
import { detectMediaType } from './media-signature';

/** Real file headers, as written by common encoders. */
const HEADERS = {
  // JPEG/JFIF: SOI marker, APP0 segment, "JFIF\0".
  jpeg: Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
  ]),
  // PNG signature followed by the start of the IHDR chunk.
  png: Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]),
  // "RIFF", little-endian size, "WEBP", "VP8 ".
  webp: Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8 '),
  ]),
  // ftyp box of size 0x20 with major brand "isom", as written by ffmpeg.
  mp4: Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from('ftypisom'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2avc1mp41'),
  ]),
  // EBML header: EBMLVersion, EBMLReadVersion, MaxIDLength, MaxSizeLength, DocType "webm".
  webm: Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81,
    0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x04,
  ]),
} as const;

describe('detectMediaType', () => {
  it.each([
    ['jpeg', 'image/jpeg', MediaType.IMAGE, 'jpg'],
    ['png', 'image/png', MediaType.IMAGE, 'png'],
    ['webp', 'image/webp', MediaType.IMAGE, 'webp'],
    ['mp4', 'video/mp4', MediaType.VIDEO, 'mp4'],
    ['webm', 'video/webm', MediaType.VIDEO, 'webm'],
  ] as const)('recognises a real %s header', (format, contentType, mediaType, extension) => {
    expect(detectMediaType(HEADERS[format])).toEqual({ contentType, mediaType, extension });
  });

  it.each(['mp42', 'mp41', 'M4V ', 'dash'])('recognises MP4 with major brand %j', (brand) => {
    const header = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`)]);

    expect(detectMediaType(header)?.contentType).toBe('video/mp4');
  });

  it('recognises a header followed by arbitrary file data', () => {
    const file = Buffer.concat([HEADERS.png, Buffer.alloc(1024, 0xab)]);

    expect(detectMediaType(file)?.contentType).toBe('image/png');
  });

  describe('spoofed input', () => {
    it.each([
      ['plain text', Buffer.from('hello, this is definitely a PNG file')],
      ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
      [
        'a PNG signature with one byte changed',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]),
      ],
      ['a GIF', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')],
      [
        'a RIFF WAVE file',
        Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]),
      ],
      [
        'an HEIC image (ftyp heic)',
        Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]),
      ],
      [
        'a QuickTime movie (ftyp "qt  ")',
        Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ')]),
      ],
      [
        'a Matroska file (DocType matroska)',
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, ...Buffer.from('matroska')]),
      ],
      [
        '"webm" text without an EBML header',
        Buffer.from([0x42, 0x82, 0x84, ...Buffer.from('webm')]),
      ],
    ])('rejects %s', (_name, bytes) => {
      expect(detectMediaType(bytes)).toBeNull();
    });
  });

  describe('truncated input', () => {
    it('rejects an empty buffer', () => {
      expect(detectMediaType(Buffer.alloc(0))).toBeNull();
    });

    it.each([
      ['jpeg', 3],
      ['png', 8],
      ['webp', 12],
      ['mp4', 12],
    ] as const)(
      'rejects a %s header cut one byte short of its signature',
      (format, signatureLength) => {
        expect(detectMediaType(HEADERS[format].subarray(0, signatureLength - 1))).toBeNull();
      },
    );

    it('rejects a WebM header cut before the end of the DocType', () => {
      const docTypeEnd = HEADERS.webm.indexOf(Buffer.from('webm')) + 'webm'.length;

      expect(detectMediaType(HEADERS.webm.subarray(0, docTypeEnd - 1))).toBeNull();
    });
  });
});
