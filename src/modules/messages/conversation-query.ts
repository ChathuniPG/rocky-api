import type { CursorPosition } from '../../common/pagination/cursor-pagination';
import { Prisma } from '../../generated/prisma/client';

/**
 * One conversation as seen by one participant, flattened: the other participant, the
 * latest message (all `null` before the first message) and the caller's unread count.
 * Column aliases in {@link conversationsQuery} match these names exactly.
 */
export interface ConversationRow {
  id: string;
  lastMessageAt: Date;
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string;
  otherAvatarUrl: string | null;
  lastMessageId: string | null;
  lastMessageBody: string | null;
  lastMessageSenderId: string | null;
  lastMessageCreatedAt: Date | null;
  unreadCount: number;
}

/**
 * Builds the single statement behind the conversation list and the get-or-create
 * response: conversation, other user, latest message and unread count in one round trip
 * (FR-MSG-01, FR-MSG-05; no N+1).
 *
 * Raw SQL because Prisma cannot express "latest message per conversation" efficiently:
 * without the relationJoins preview feature, a nested `take: 1` loads every message of
 * every conversation on the page and slices them in memory. `LEFT JOIN LATERAL ... LIMIT 1`
 * reads one row per conversation from the (conversation_id, created_at, id) index.
 *
 * Every value is a bound parameter of the tagged template (never string concatenation),
 * so the query is not injectable.
 *
 * @param userId - The signed-in user; only their conversations are returned.
 * @param filter - Extra WHERE condition, from {@link afterPosition} or {@link byPair}.
 * @param limit - Maximum number of rows.
 * @returns The SQL to pass to `$queryRaw`.
 */
export function conversationsQuery(userId: string, filter: Prisma.Sql, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT
      c.id,
      c.last_message_at AS "lastMessageAt",
      u.id AS "otherUserId",
      u.username AS "otherUsername",
      u.display_name AS "otherDisplayName",
      u.avatar_url AS "otherAvatarUrl",
      lm.id AS "lastMessageId",
      lm.body AS "lastMessageBody",
      lm.sender_id AS "lastMessageSenderId",
      lm.created_at AS "lastMessageCreatedAt",
      (
        SELECT count(*)::int
        FROM messages m
        WHERE m.conversation_id = c.id AND m.sender_id <> ${userId}::uuid AND m.read_at IS NULL
      ) AS "unreadCount"
    FROM conversations c
    JOIN users u
      ON u.id = CASE WHEN c.user_a_id = ${userId}::uuid THEN c.user_b_id ELSE c.user_a_id END
    LEFT JOIN LATERAL (
      SELECT m.id, m.body, m.sender_id, m.created_at
      FROM messages m
      WHERE m.conversation_id = c.id
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) lm ON TRUE
    WHERE (c.user_a_id = ${userId}::uuid OR c.user_b_id = ${userId}::uuid) AND ${filter}
    ORDER BY c.last_message_at DESC, c.id DESC
    LIMIT ${limit}`;
}

/** The single row returned by {@link unreadConversationsCountQuery}. */
export interface UnreadConversationsCountRow {
  count: number;
}

/**
 * Builds the count behind the navigation badge (FR-MSG-06): the user's conversations with
 * at least one message from the other participant that has not been read.
 *
 * EXISTS rather than a join or count of messages: several unread messages in one
 * conversation count once, and the probe stops at the first unread message it finds.
 *
 * Served by existing indexes, no extra migration:
 * - `user_a_id = me` and `user_b_id = me` use the (user_a_id, last_message_at, id) and
 *   (user_b_id, last_message_at, id) indexes by their first column, combined with a
 *   BitmapOr (the inbox's access path; the unique pair index would also serve side A).
 * - The EXISTS probe uses the (conversation_id, created_at, id) index by its first column;
 *   sender_id and read_at are checked on the rows it fetches. A fully read conversation is
 *   therefore scanned to its end, so the cost grows with the messages in the user's own
 *   conversations only. A partial index on messages (conversation_id) WHERE read_at IS NULL
 *   would make it proportional to unread messages if that ever matters.
 *
 * @param userId - The signed-in user; only their conversations are counted.
 * @returns The SQL to pass to `$queryRaw`; it returns exactly one row.
 */
export function unreadConversationsCountQuery(userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS count
    FROM conversations c
    WHERE (c.user_a_id = ${userId}::uuid OR c.user_b_id = ${userId}::uuid)
      AND EXISTS (
        SELECT 1
        FROM messages m
        WHERE m.conversation_id = c.id AND m.sender_id <> ${userId}::uuid AND m.read_at IS NULL
      )`;
}

/**
 * Keyset condition for the conversation list, ordered by (last_message_at DESC, id DESC)
 * (ADR-005). The row comparison is the SQL form of the shared `keysetWhere`; it is total
 * because last_message_at is NOT NULL.
 *
 * @param position - From `decodeCursor`; `undefined` for the first page.
 * @returns The WHERE fragment.
 */
export function afterPosition(position: CursorPosition | undefined): Prisma.Sql {
  if (!position) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`(c.last_message_at, c.id) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`;
}

/**
 * Selects the one conversation between two users.
 *
 * @param userAId - The smaller of the two user IDs.
 * @param userBId - The larger of the two user IDs.
 * @returns The WHERE fragment.
 */
export function byPair(userAId: string, userBId: string): Prisma.Sql {
  return Prisma.sql`c.user_a_id = ${userAId}::uuid AND c.user_b_id = ${userBId}::uuid`;
}

/**
 * The cursor position of a conversation row: its sort key is last_message_at, not
 * created_at.
 *
 * @param row - A conversation row.
 * @returns The position to encode in the cursor.
 */
export function conversationPosition(row: ConversationRow): CursorPosition {
  return { createdAt: row.lastMessageAt, id: row.id };
}
