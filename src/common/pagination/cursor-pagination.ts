import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';

/**
 * Keyset (cursor) pagination shared by every list endpoint (ADR-005, NFR-PERF-01).
 *
 * Lists are always ordered newest first by (created_at DESC, id DESC); the id breaks ties
 * between rows with the same timestamp. A page is fetched with "rows strictly after the
 * last row of the previous page", which, unlike OFFSET, neither skips nor repeats rows
 * when new rows are inserted while a user scrolls. It is the equivalent of Spring Data's
 * `ScrollPosition.forward(KeysetScrollPosition)`.
 *
 * Usage in a service:
 *
 *   const position = decodeCursor(query.cursor);
 *   const rows = await prisma.post.findMany({
 *     where: { ...otherFilters, ...keysetWhere(position) },
 *     orderBy: keysetOrderBy(),
 *     take: query.limit + 1,
 *   });
 *   return toCursorPage(rows, query.limit, PostResponseDto.fromRow);
 *
 * Paginated tables store created_at with millisecond precision (timestamptz(3)), the
 * precision of a JS Date; see the schema header in prisma/schema.prisma.
 */

/** Where a page ends: the sort key of its last row. */
export interface CursorPosition {
  createdAt: Date;
  id: string;
}

/** One page of a list endpoint (design §5.1). */
export interface CursorPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or `null` on the last page. */
  nextCursor: string | null;
}

/** One branch of the keyset condition. */
export type KeysetCondition = { createdAt: { lt: Date } } | { createdAt: Date; id: { lt: string } };

/**
 * Prisma `where` fragment selecting the rows after a cursor. Structurally compatible with
 * the WhereInput of every model that has `createdAt` and `id`.
 */
export interface KeysetWhere {
  OR?: KeysetCondition[];
}

/** Prisma `orderBy` matching the keyset condition. */
export type KeysetOrderBy = [{ createdAt: 'desc' }, { id: 'desc' }];

export const INVALID_CURSOR_MESSAGE = 'Invalid cursor';

/** base64url alphabet without padding, as produced by `Buffer#toString('base64url')`. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** JSON payload inside the cursor. Short keys keep the cursor short in query strings. */
interface CursorPayload {
  c: string;
  i: string;
}

/**
 * Encodes a position as an opaque cursor. Clients must treat it as a black box; the
 * format may change without notice.
 *
 * @param position - Sort key of the last row on the page.
 * @returns base64url of `{"c":"<ISO timestamp>","i":"<uuid>"}`.
 */
export function encodeCursor(position: CursorPosition): string {
  const payload: CursorPayload = { c: position.createdAt.toISOString(), i: position.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes a cursor received from a client. Cursors are untrusted input, so every part is
 * validated before it reaches a query.
 *
 * @param cursor - The `cursor` query parameter, or `undefined` for the first page.
 * @returns The position to continue after, or `undefined` for the first page.
 * @throws {BadRequestException} If the cursor is not one this API issued.
 */
export function decodeCursor(cursor: string | undefined): CursorPosition | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  // Buffer.from(..., 'base64url') silently skips invalid characters instead of failing.
  if (!BASE64URL_PATTERN.test(cursor)) {
    throw invalidCursor();
  }

  const payload = parseJson(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!isCursorPayload(payload)) {
    throw invalidCursor();
  }

  const createdAt = new Date(payload.c);
  // The round trip rejects non-canonical or impossible dates that Date would accept.
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== payload.c) {
    throw invalidCursor();
  }
  if (!isUUID(payload.i, 'all')) {
    throw invalidCursor();
  }
  return { createdAt, id: payload.i.toLowerCase() };
}

/**
 * Builds the keyset condition "(created_at, id) < (cursor.createdAt, cursor.id)" for
 * DESC order. Spread it into the query's `where`.
 *
 * @param position - From {@link decodeCursor}; `undefined` for the first page.
 * @returns An empty object for the first page, otherwise an `OR` condition.
 */
export function keysetWhere(position: CursorPosition | undefined): KeysetWhere {
  if (!position) {
    return {};
  }
  return {
    OR: [
      { createdAt: { lt: position.createdAt } },
      // Same timestamp: the id decides, so rows created in the same millisecond are
      // neither skipped nor repeated across pages.
      { createdAt: position.createdAt, id: { lt: position.id } },
    ],
  };
}

/**
 * The sort order every paginated query must use. A function rather than a constant, so
 * no caller can mutate a shared array.
 *
 * @returns `[{ createdAt: 'desc' }, { id: 'desc' }]`.
 */
export function keysetOrderBy(): KeysetOrderBy {
  return [{ createdAt: 'desc' }, { id: 'desc' }];
}

/** One branch of the "newer than" keyset condition. */
export type KeysetNewerCondition =
  { createdAt: { gt: Date } } | { createdAt: Date; id: { gt: string } };

/** Prisma `where` fragment selecting the rows strictly after a position in ascending order. */
export interface KeysetNewerWhere {
  OR: KeysetNewerCondition[];
}

/** Prisma `orderBy` matching {@link keysetNewerWhere}: oldest first. */
export type KeysetAscendingOrderBy = [{ createdAt: 'asc' }, { id: 'asc' }];

/**
 * The mirror image of {@link keysetWhere}, "(created_at, id) > (position)", for reading
 * forwards in time from a known row, e.g. polling for messages newer than the last one
 * the client has (ADR-008). Same tie-breaker, so a row is never both "older" and "newer".
 *
 * @param position - The row to continue after.
 * @returns An `OR` condition to spread into the query's `where`.
 */
export function keysetNewerWhere(position: CursorPosition): KeysetNewerWhere {
  return {
    OR: [
      { createdAt: { gt: position.createdAt } },
      { createdAt: position.createdAt, id: { gt: position.id } },
    ],
  };
}

/**
 * The sort order to use with {@link keysetNewerWhere}.
 *
 * @returns `[{ createdAt: 'asc' }, { id: 'asc' }]`.
 */
export function keysetAscendingOrderBy(): KeysetAscendingOrderBy {
  return [{ createdAt: 'asc' }, { id: 'asc' }];
}

/**
 * Turns the rows of a query made with `take: limit + 1` into a page. The extra row only
 * signals that another page exists; it is not returned. This avoids a COUNT query and
 * an empty last page when the total is an exact multiple of `limit`.
 *
 * @param rows - Rows in keyset order, at most `limit + 1`.
 * @param limit - The requested page size.
 * @param toItem - Maps a row to its response item.
 * @returns The first `limit` items and the cursor of the last one if more rows exist.
 */
export function toCursorPage<Row extends CursorPosition, Item>(
  rows: readonly Row[],
  limit: number,
  toItem: (row: Row) => Item,
): CursorPage<Item> {
  return toCursorPageBy(rows, limit, (row) => row, toItem);
}

/**
 * Like {@link toCursorPage}, for rows whose sort timestamp is not `createdAt`, e.g. the
 * conversation list ordered by (last_message_at DESC, id DESC). The cursor format is the
 * same "timestamp + id"; only the column the timestamp comes from differs.
 *
 * @param rows - Rows in keyset order, at most `limit + 1`.
 * @param limit - The requested page size.
 * @param positionOf - Reads a row's sort key as a {@link CursorPosition}.
 * @param toItem - Maps a row to its response item.
 * @returns The first `limit` items and the cursor of the last one if more rows exist.
 */
export function toCursorPageBy<Row, Item>(
  rows: readonly Row[],
  limit: number,
  positionOf: (row: Row) => CursorPosition,
  toItem: (row: Row) => Item,
): CursorPage<Item> {
  return toPage(rows, limit, toItem, (row) => encodeCursor(positionOf(row)));
}

/*
 * Single-key cursors, for lists ordered by one unique, immutable string column instead of
 * (created_at, id), e.g. user search ordered by username. The key alone identifies the
 * position, so the condition is simply `key > cursor` (ascending) and no tie-breaker is
 * needed. Same opaque base64url JSON format, with a different payload: `{"k":"<key>"}`.
 */

/** JSON payload inside a single-key cursor. */
interface KeyCursorPayload {
  k: string;
}

/**
 * Encodes the sort key of a page's last row as an opaque cursor.
 *
 * @param key - The unique sort key, e.g. a username.
 * @returns base64url of `{"k":"<key>"}`.
 */
export function encodeKeyCursor(key: string): string {
  const payload: KeyCursorPayload = { k: key };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes a single-key cursor received from a client. The key is untrusted input, so the
 * caller supplies the rule a real key satisfies (e.g. the username pattern).
 *
 * @param cursor - The `cursor` query parameter, or `undefined` for the first page.
 * @param isValidKey - Returns `true` for a key this list can contain.
 * @returns The key to continue after, or `undefined` for the first page.
 * @throws {BadRequestException} If the cursor is not one this API issued.
 */
export function decodeKeyCursor(
  cursor: string | undefined,
  isValidKey: (key: string) => boolean,
): string | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  if (!BASE64URL_PATTERN.test(cursor)) {
    throw invalidCursor();
  }
  const payload = parseJson(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!isKeyCursorPayload(payload) || !isValidKey(payload.k)) {
    throw invalidCursor();
  }
  return payload.k;
}

/**
 * Like {@link toCursorPage}, for a list paginated with a single-key cursor.
 *
 * @param rows - Rows in key order, at most `limit + 1`.
 * @param limit - The requested page size.
 * @param keyOf - Reads the sort key of a row.
 * @param toItem - Maps a row to its response item.
 * @returns The first `limit` items and the cursor of the last one if more rows exist.
 */
export function toKeyCursorPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  keyOf: (row: Row) => string,
  toItem: (row: Row) => Item,
): CursorPage<Item> {
  return toPage(rows, limit, toItem, (row) => encodeKeyCursor(keyOf(row)));
}

/** Shared by both cursor kinds: drops the extra row and encodes the last returned one. */
function toPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  toItem: (row: Row) => Item,
  encodeLast: (row: Row) => string,
): CursorPage<Item> {
  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastRow = pageRows.at(-1);
  return {
    items: pageRows.map((row) => toItem(row)),
    nextCursor: hasMore && lastRow !== undefined ? encodeLast(lastRow) : null,
  };
}

function isKeyCursorPayload(value: unknown): value is KeyCursorPayload {
  return typeof value === 'object' && value !== null && 'k' in value && typeof value.k === 'string';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isCursorPayload(value: unknown): value is CursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'c' in value &&
    'i' in value &&
    typeof value.c === 'string' &&
    typeof value.i === 'string'
  );
}

function invalidCursor(): BadRequestException {
  return new BadRequestException(INVALID_CURSOR_MESSAGE);
}
