-- The conversation list is cursor-paginated by (last_message_at DESC, id DESC) (ADR-005).
-- Like created_at on the other paginated tables, last_message_at must hold milliseconds,
-- the precision of the JS Date in the cursor; otherwise rows in the same millisecond as
-- the cursor row are skipped. It is also made NOT NULL: a NULL would match neither side
-- of the keyset comparison. A conversation without messages sorts by its creation time.

-- Backfill before the NOT NULL constraint.
UPDATE "conversations" SET "last_message_at" = "created_at" WHERE "last_message_at" IS NULL;

-- AlterTable
ALTER TABLE "conversations" ALTER COLUMN "last_message_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "last_message_at" SET NOT NULL;

-- DropIndex: replaced by the per-user keyset indexes below.
DROP INDEX "conversations_last_message_at_idx";

-- DropIndex: user_b_id stays the leading column of conversations_user_b_id_last_message_at_id_idx.
DROP INDEX "conversations_user_b_id_idx";

-- CreateIndex
CREATE INDEX "conversations_user_a_id_last_message_at_id_idx" ON "conversations"("user_a_id", "last_message_at", "id");

-- CreateIndex
CREATE INDEX "conversations_user_b_id_last_message_at_id_idx" ON "conversations"("user_b_id", "last_message_at", "id");
