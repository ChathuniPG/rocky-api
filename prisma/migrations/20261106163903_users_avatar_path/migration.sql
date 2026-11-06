-- FR-PROF-04: users.avatar_path stores the Storage object path of the current avatar, so the
-- server can delete the object when the avatar is replaced or removed. Nullable: users
-- without an avatar have none.
--
-- ADR-005: the saved-posts list is ordered by (created_at DESC, post_id DESC); saves have no
-- id column, so post_id is the cursor tie-breaker and joins the index. Ascending columns
-- serve the DESC order with a backward index scan.

-- DropIndex
DROP INDEX "saves_user_id_created_at_idx";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_path" TEXT;

-- CreateIndex
CREATE INDEX "saves_user_id_created_at_post_id_idx" ON "saves"("user_id", "created_at", "post_id");
