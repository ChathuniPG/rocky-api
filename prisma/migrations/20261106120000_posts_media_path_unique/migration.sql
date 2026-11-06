-- One upload backs at most one post (#7). POST /posts checks this first and answers 409;
-- the index also stops two concurrent requests from attaching the same upload, and makes
-- that check an index lookup.

-- CreateIndex
CREATE UNIQUE INDEX "posts_media_path_key" ON "posts"("media_path");
