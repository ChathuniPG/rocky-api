import { BadRequestException } from '@nestjs/common';
import {
  type CursorPosition,
  decodeCursor,
  decodeKeyCursor,
  encodeCursor,
  encodeKeyCursor,
  INVALID_CURSOR_MESSAGE,
  keysetOrderBy,
  keysetWhere,
  toCursorPage,
  toCursorPageBy,
  toKeyCursorPage,
} from './cursor-pagination';

const ID_1 = '0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e';
const ID_2 = '1c7f7b63-2d2f-4d54-8b30-2e2c303d4e5f';
const ID_3 = '2d808c74-3e30-4e65-9c41-3f3d414e5f60';
const T1 = new Date('2026-11-06T10:00:00.123Z');
const T0 = new Date('2026-11-06T09:00:00.000Z');

function toItem(row: CursorPosition): string {
  return row.id;
}

function base64url(text: string): string {
  return Buffer.from(text).toString('base64url');
}

function isUsername(key: string): boolean {
  return /^[a-z0-9_.]{3,30}$/.test(key);
}

function keyOf(row: { key: string }): string {
  return row.key;
}

/** A row sorted by a timestamp other than createdAt, like a conversation. */
function positionOf(row: { lastMessageAt: Date; id: string }): CursorPosition {
  return { createdAt: row.lastMessageAt, id: row.id };
}

describe('cursor pagination', () => {
  describe('encodeCursor / decodeCursor', () => {
    it('round-trips a position with millisecond precision', () => {
      const position: CursorPosition = { createdAt: T1, id: ID_1 };

      const cursor = encodeCursor(position);

      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(cursor)).toEqual(position);
    });

    it('returns undefined for the first page (no cursor)', () => {
      expect(decodeCursor(undefined)).toBeUndefined();
    });

    it('normalises an uppercase UUID', () => {
      const cursor = base64url(JSON.stringify({ c: T1.toISOString(), i: ID_1.toUpperCase() }));

      expect(decodeCursor(cursor)).toEqual({ createdAt: T1, id: ID_1 });
    });

    it.each([
      ['an empty string', ''],
      ['non-base64url characters', 'abc+/='],
      ['base64url that is not JSON', base64url('not json')],
      ['JSON that is not an object', base64url('42')],
      ['JSON null', base64url('null')],
      ['missing fields', base64url(JSON.stringify({ c: T1.toISOString() }))],
      ['fields of the wrong type', base64url(JSON.stringify({ c: 1, i: 2 }))],
      ['an invalid date', base64url(JSON.stringify({ c: 'yesterday', i: ID_1 }))],
      ['a non-canonical date', base64url(JSON.stringify({ c: '2026-11-06', i: ID_1 }))],
      ['an impossible date', base64url(JSON.stringify({ c: '2026-02-30T00:00:00.000Z', i: ID_1 }))],
      [
        'an id that is not a UUID',
        base64url(JSON.stringify({ c: T1.toISOString(), i: '1 OR 1=1' })),
      ],
    ])('rejects %s with 400', (_name, cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
      expect(() => decodeCursor(cursor)).toThrow(INVALID_CURSOR_MESSAGE);
    });
  });

  describe('keysetWhere', () => {
    it('adds no condition on the first page', () => {
      expect(keysetWhere(undefined)).toEqual({});
    });

    it('selects older rows, and rows with the same timestamp but a smaller id', () => {
      expect(keysetWhere({ createdAt: T1, id: ID_2 })).toEqual({
        OR: [{ createdAt: { lt: T1 } }, { createdAt: T1, id: { lt: ID_2 } }],
      });
    });

    it('orders by createdAt DESC, then id DESC, as a fresh array each call', () => {
      const first = keysetOrderBy();

      expect(first).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(keysetOrderBy()).not.toBe(first);
    });
  });

  describe('toCursorPage', () => {
    it('returns an empty last page for no rows', () => {
      expect(toCursorPage([], 2, toItem)).toEqual({ items: [], nextCursor: null });
    });

    it('returns a last page when fewer rows than the limit came back', () => {
      const rows = [{ createdAt: T1, id: ID_1 }];

      expect(toCursorPage(rows, 2, toItem)).toEqual({ items: [ID_1], nextCursor: null });
    });

    it('returns a last page when exactly `limit` rows came back (page boundary)', () => {
      const rows = [
        { createdAt: T1, id: ID_2 },
        { createdAt: T0, id: ID_1 },
      ];

      expect(toCursorPage(rows, 2, toItem)).toEqual({ items: [ID_2, ID_1], nextCursor: null });
    });

    it('drops the extra row and points the cursor at the last returned row', () => {
      const rows = [
        { createdAt: T1, id: ID_3 },
        { createdAt: T1, id: ID_2 },
        { createdAt: T0, id: ID_1 },
      ];

      const page = toCursorPage(rows, 2, toItem);

      expect(page.items).toEqual([ID_3, ID_2]);
      expect(page.nextCursor).not.toBeNull();
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ createdAt: T1, id: ID_2 });
    });

    it('continues correctly across rows with identical timestamps', () => {
      // Three rows in the same millisecond, sorted id DESC, paged one at a time.
      const sameTime = [ID_3, ID_2, ID_1].map((id) => ({ createdAt: T1, id }));
      const firstPage = toCursorPage(sameTime, 1, toItem);
      const position = decodeCursor(firstPage.nextCursor ?? undefined);

      // The id tie-breaker keeps ID_2 and ID_1 on later pages instead of skipping them.
      expect(keysetWhere(position)).toEqual({
        OR: [{ createdAt: { lt: T1 } }, { createdAt: T1, id: { lt: ID_3 } }],
      });
    });
  });

  describe('toCursorPageBy', () => {
    const rows = [
      { lastMessageAt: T1, id: ID_3 },
      { lastMessageAt: T1, id: ID_2 },
      { lastMessageAt: T0, id: ID_1 },
    ];
    it('encodes the position read by positionOf from the last returned row', () => {
      const page = toCursorPageBy(rows, 2, positionOf, (row) => row.id);

      expect(page.items).toEqual([ID_3, ID_2]);
      expect(decodeCursor(page.nextCursor ?? undefined)).toEqual({ createdAt: T1, id: ID_2 });
    });

    it('returns no cursor on the last page', () => {
      expect(toCursorPageBy(rows, 3, positionOf, (row) => row.id).nextCursor).toBeNull();
    });
  });

  describe('encodeKeyCursor / decodeKeyCursor', () => {
    it('round-trips a key', () => {
      expect(decodeKeyCursor(encodeKeyCursor('alice_01'), isUsername)).toBe('alice_01');
    });

    it('returns undefined for the first page', () => {
      expect(decodeKeyCursor(undefined, isUsername)).toBeUndefined();
    });

    it.each([
      ['non-base64url characters', 'abc$'],
      ['invalid JSON', base64url('{')],
      ['a missing key', base64url('{"x":"alice"}')],
      ['a non-string key', base64url('{"k":5}')],
      ['a key the caller rejects', base64url('{"k":"Robert\'); DROP TABLE users;--"}')],
      ['a timestamp cursor', encodeCursor({ createdAt: T1, id: ID_1 })],
    ])('rejects %s with 400', (_name, cursor) => {
      expect(() => decodeKeyCursor(cursor, isUsername)).toThrow(BadRequestException);
      expect(() => decodeKeyCursor(cursor, isUsername)).toThrow(INVALID_CURSOR_MESSAGE);
    });
  });

  describe('toKeyCursorPage', () => {
    const rows = [{ key: 'alice' }, { key: 'bob' }, { key: 'carol' }];

    it('returns the first limit items and a cursor of the last returned key', () => {
      const page = toKeyCursorPage(rows, 2, keyOf, keyOf);

      expect(page.items).toEqual(['alice', 'bob']);
      expect(decodeKeyCursor(page.nextCursor ?? undefined, () => true)).toBe('bob');
    });

    it('returns no cursor on the last page', () => {
      expect(toKeyCursorPage(rows, 3, keyOf, keyOf).nextCursor).toBeNull();
      expect(toKeyCursorPage([], 3, keyOf, keyOf)).toEqual({ items: [], nextCursor: null });
    });
  });
});
