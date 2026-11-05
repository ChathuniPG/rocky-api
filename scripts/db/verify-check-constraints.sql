-- verify-check-constraints.sql
--
-- Verifies that the hand-written CHECK constraints from the initial migration
-- (prisma/migrations/*_init/migration.sql) reject invalid data:
--   posts_like_count_non_negative     like_count >= 0 (ADR-006)
--   posts_comment_count_non_negative  comment_count >= 0 (ADR-006)
--   follows_no_self_follow            follower_id <> following_id
--   conversations_user_order          user_a_id < user_b_id (also rules out user_a = user_b)
--   comments_body_not_blank           body has a non-whitespace character
--   messages_body_not_blank           body has a non-whitespace character
--   users_username_format             username ~ '^[a-z0-9_.]{3,30}$'
--
-- How it works:
--   - Everything runs inside ONE transaction that ends with ROLLBACK, so the script leaves
--     no data behind and is safe to run repeatedly against the local database.
--   - It first inserts valid fixtures (these must succeed), then attempts one invalid
--     INSERT/UPDATE per case. Each one runs inside a SAVEPOINT and is rolled back to it, so
--     one failure does not abort the rest of the transaction.
--   - Expected output: every numbered case prints
--       ERROR: new row for relation "<table>" violates check constraint "<name>"
--     naming the constraint in its "expect ..." heading. Any case without that error is a
--     failing constraint. The script ends by showing that every table is empty and by
--     listing the CHECK constraints present in the database.
--   - Do not run it against a database that contains real data: the fixtures use fixed
--     ids, emails and usernames, and the fixture inserts fail if those already exist.
--
-- Run it against the local Docker database (start it first with `npm run db:up`), from the
-- repository root. psql runs inside the container with the container's own credentials,
-- so no connection string is needed.
--
--   Bash / Git Bash:
--     docker compose exec -T db sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/verify-check-constraints.sql
--
--   PowerShell:
--     Get-Content -Raw scripts/db/verify-check-constraints.sql | docker compose exec -T db sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

\set VERBOSITY terse
\set ON_ERROR_STOP 0

BEGIN;

\echo '=== Valid fixtures (must succeed) ==='
INSERT INTO users (id, firebase_uid, email, username, display_name) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'fb-a', 'a@example.com', 'alice_1.x', 'Alice'),
  ('00000000-0000-0000-0000-00000000000b', 'fb-b', 'b@example.com', 'bob', 'Bob');
INSERT INTO posts (id, author_id, media_url, media_path, media_type) VALUES
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000a', 'https://x/y.jpg', 'posts/a/1', 'IMAGE');
INSERT INTO conversations (id, user_a_id, user_b_id) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b');
INSERT INTO follows (follower_id, following_id) VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b');
INSERT INTO comments (post_id, author_id, body) VALUES
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000b', '  nice  ');
INSERT INTO messages (conversation_id, sender_id, body) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'hi');

\echo ''
\echo '=== 1. posts.like_count >= 0 (expect posts_like_count_non_negative) ==='
SAVEPOINT s;
UPDATE posts SET like_count = like_count - 1 WHERE id = '00000000-0000-0000-0000-0000000000f1';
ROLLBACK TO SAVEPOINT s;

\echo '=== 2. posts.comment_count >= 0 (expect posts_comment_count_non_negative) ==='
SAVEPOINT s;
UPDATE posts SET comment_count = -1 WHERE id = '00000000-0000-0000-0000-0000000000f1';
ROLLBACK TO SAVEPOINT s;

\echo '=== 3. follower_id <> following_id (expect follows_no_self_follow) ==='
SAVEPOINT s;
INSERT INTO follows (follower_id, following_id) VALUES
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b');
ROLLBACK TO SAVEPOINT s;

\echo '=== 4a. user_a_id < user_b_id, reversed pair (expect conversations_user_order) ==='
SAVEPOINT s;
INSERT INTO conversations (user_a_id, user_b_id) VALUES
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a');
ROLLBACK TO SAVEPOINT s;

\echo '=== 4b. user_a_id < user_b_id, same user (expect conversations_user_order) ==='
SAVEPOINT s;
INSERT INTO conversations (user_a_id, user_b_id) VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a');
ROLLBACK TO SAVEPOINT s;

\echo '=== 5a. comment body empty (expect comments_body_not_blank) ==='
SAVEPOINT s;
INSERT INTO comments (post_id, author_id, body) VALUES
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000b', '');
ROLLBACK TO SAVEPOINT s;

\echo '=== 5b. comment body whitespace only, incl. tab/newline (expect comments_body_not_blank) ==='
SAVEPOINT s;
INSERT INTO comments (post_id, author_id, body) VALUES
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000b', E'  \t\n ');
ROLLBACK TO SAVEPOINT s;

\echo '=== 6a. message body empty (expect messages_body_not_blank) ==='
SAVEPOINT s;
INSERT INTO messages (conversation_id, sender_id, body) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', '');
ROLLBACK TO SAVEPOINT s;

\echo '=== 6b. message body whitespace only (expect messages_body_not_blank) ==='
SAVEPOINT s;
UPDATE messages SET body = E'\n\n' WHERE conversation_id = '00000000-0000-0000-0000-0000000000c1';
ROLLBACK TO SAVEPOINT s;

\echo '=== 7a. username uppercase (expect users_username_format) ==='
SAVEPOINT s;
INSERT INTO users (firebase_uid, email, username, display_name) VALUES ('fb-c', 'c@example.com', 'Carol', 'Carol');
ROLLBACK TO SAVEPOINT s;

\echo '=== 7b. username too short (expect users_username_format) ==='
SAVEPOINT s;
INSERT INTO users (firebase_uid, email, username, display_name) VALUES ('fb-c', 'c@example.com', 'ab', 'Carol');
ROLLBACK TO SAVEPOINT s;

\echo '=== 7c. username invalid character (expect users_username_format) ==='
SAVEPOINT s;
INSERT INTO users (firebase_uid, email, username, display_name) VALUES ('fb-c', 'c@example.com', 'carol-x', 'Carol');
ROLLBACK TO SAVEPOINT s;

\echo '=== 7d. username with a space (expect users_username_format) ==='
SAVEPOINT s;
UPDATE users SET username = 'bob smith' WHERE id = '00000000-0000-0000-0000-00000000000b';
ROLLBACK TO SAVEPOINT s;

\echo ''
\echo '=== Fixtures still intact inside the transaction (valid data unaffected) ==='
SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM posts) AS posts,
       (SELECT like_count FROM posts) AS like_count, (SELECT count(*) FROM conversations) AS conversations;

ROLLBACK;

\echo ''
\echo '=== After ROLLBACK: every table is empty ==='
SELECT 'users' AS table_name, count(*) FROM users UNION ALL
SELECT 'posts', count(*) FROM posts UNION ALL
SELECT 'comments', count(*) FROM comments UNION ALL
SELECT 'likes', count(*) FROM likes UNION ALL
SELECT 'saves', count(*) FROM saves UNION ALL
SELECT 'follows', count(*) FROM follows UNION ALL
SELECT 'notifications', count(*) FROM notifications UNION ALL
SELECT 'conversations', count(*) FROM conversations UNION ALL
SELECT 'messages', count(*) FROM messages;

\echo '=== CHECK constraints present in the database ==='
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace
ORDER BY 1, 2;
