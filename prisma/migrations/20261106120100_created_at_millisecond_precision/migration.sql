-- ADR-005: cursor pagination compares created_at with a JS Date, which holds milliseconds.
-- With microsecond values, rows created in the same millisecond as the cursor row would
-- match neither `created_at < cursor` nor `created_at = cursor` and be skipped. Storing
-- milliseconds makes the database value exactly what the cursor carries. Existing values
-- are rounded once to the nearest millisecond; the indexes on these columns are rebuilt.

-- AlterTable
ALTER TABLE "comments" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "likes" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "notifications" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "posts" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "saves" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);
