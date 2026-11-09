<p align="center">
  <img src="docs/assets/rocky-logo.png" alt="R.O.C.K.Y. logo" width="120">
</p>

<h1 align="center">R.O.C.K.Y. (Regular Online Content Kernel Yarn)</h1>

<p align="center"><em>Named after Rocky from Project Hail Mary.</em></p>

<p align="center">
  <a href="https://github.com/ChathuniPG/rocky-api/actions/workflows/ci.yml"><img src="https://github.com/ChathuniPG/rocky-api/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
</p>

<p align="center">
  <a href="https://rocky-social.duckdns.org">Live site</a> ·
  <a href="https://rocky-social.duckdns.org/api/docs">Live API docs (Swagger)</a> ·
  <a href="https://rocky-social.duckdns.org/api/v1/health">Health check</a> ·
  <a href="https://github.com/ChathuniPG/rocky-web">Frontend repository (rocky-web)</a>
</p>

---

## Contents

- [Project Overview](#project-overview)
- [Architecture](#architecture)
- [Features Implemented](#features-implemented)
- [Technology Stack](#technology-stack)
- [Installation](#installation)
- [Run Instructions](#run-instructions)
- [How to try the API in Swagger](#how-to-try-the-api-in-swagger)
- [Environment Variables](#environment-variables)
- [Data Model](#data-model)
- [Module and Controller Structure](#module-and-controller-structure)
- [Design Decisions](#design-decisions)
- [Testing](#testing)
- [AWS EC2 Deployment Steps](#aws-ec2-deployment-steps)
- [Known Limitations](#known-limitations)
- [Future Improvements](#future-improvements)
- [AI-assisted development](#ai-assisted-development)
- [Documentation](#documentation)

## Project Overview

R.O.C.K.Y. is a TikTok-style social media platform built as a full-stack technical assessment.
Users sign up, post photos and short videos, scroll a full-screen feed, like, save and comment on
posts, follow each other, get notifications and send direct messages.

This repository, **rocky-api**, is the backend: a NestJS REST API under `/api/v1`. It is the only
component that talks to PostgreSQL and Firebase (Authentication and Storage). The frontend,
[rocky-web](https://github.com/ChathuniPG/rocky-web), is a Next.js application in a separate
repository. Both run on one AWS EC2 instance behind Nginx at
**https://rocky-social.duckdns.org**.

### Demo login

| Email                              | Password    |
| ---------------------------------- | ----------- |
| `demo.maya+production@example.com` | `Rocky1234` |

The production database is seeded with six demo users who share this password: `demo_maya`,
`demo_leo`, `demo_aiko`, `demo_sam`, `demo_noor` and `demo_ravi`. Their emails follow the same
pattern, `demo.<name>+production@example.com` (for example `demo.leo+production@example.com`).

## Architecture

R.O.C.K.Y. is a three-tier system on a single EC2 instance:

1. **Presentation:** Next.js (rocky-web), on `127.0.0.1:3000`.
2. **Application:** NestJS (rocky-api), on `127.0.0.1:4000`.
3. **Data:** PostgreSQL 18 on localhost (application data), Firebase Authentication (identity)
   and Firebase Storage (media).

Nginx is the only public entry point. It serves HTTPS on port 443 and redirects port 80 to it. It
routes by path, so the browser sees a single domain: `/api/` goes to the API and everything else
goes to Next.js (ADR-004). Because the frontend and the API share one origin, the API can keep the
Firebase tokens in **httpOnly, Secure, SameSite=Lax cookies** (`rocky_id` for the ID token,
`rocky_refresh` for the refresh token, scoped to `/api/v1/auth`). JavaScript never sees the tokens
and no CORS configuration is needed (ADR-003).

![System architecture](docs/diagrams/rocky_system_architecture.drawio.svg)

_Figure 1: System architecture: deployment of R.O.C.K.Y. on a single AWS EC2 instance_

More detail: [design.md §2 System Architecture](docs/design.md#2-system-architecture) and
[§3 Authentication Design](docs/design.md#3-authentication-design), which includes the
[authentication flow diagram](docs/diagrams/rocky_authentication_flow.drawio.svg).

## Features Implemented

**Authentication**

- Sign-up, login, token refresh and logout through Firebase Authentication. The API uses the
  Firebase Auth REST API to sign in and refresh, and the Admin SDK to create users, verify tokens
  and revoke them (ADR-002).
- Tokens live in httpOnly cookies set by the API (ADR-003). Every protected request is checked
  with `verifyIdToken(..., checkRevoked: true)`.
- If creating the PostgreSQL user fails, sign-up deletes the Firebase account it just created, so
  the two systems stay consistent. Firebase errors are mapped to safe messages: "Invalid email or
  password" never reveals which emails are registered.

**Posts and feed**

- Create, read, edit (caption) and delete posts. Only the owner can edit or delete, and the check
  runs on the server.
- A home feed with cursor pagination. Each post includes `likedByMe` and `savedByMe`.
- Likes, saves and comments. The like and comment counters are updated in the same transaction as
  the like or comment (ADR-006).

**Uploads**

- `POST /uploads` (multipart) for post media and avatars, stored in Firebase Storage under
  `posts/{userId}/…` or `avatars/{userId}/…` (ADR-007).
- **Magic-byte validation:** the file type is detected from the file's contents, not from its name
  or the client's `Content-Type`. Allowed: JPEG, PNG and WebP images (5 MB max) and MP4 and WebM
  videos (25 MB max). Avatars must be images.

**Users, search and follows**

- Public profiles with counts and an `isFollowing` flag. Profile editing: display name, bio,
  avatar, notification setting and language.
- Each user's posts and their own saved posts, both paginated.
- User search by username or display name (case-insensitive), with an optional filter for people
  you follow.
- Follow and unfollow. You cannot follow yourself.

**Notifications**

- Like, comment and follow notifications, created on the server as side effects of those actions.
- A paginated list, an unread count for the navigation badge, and mark one or all as read.

**Conversations and messages**

- One-to-one conversations. At most one exists between any two users.
- Send messages, list them newest first, and mark them as read. Clients poll for new messages
  with `after=<messageId>` (ADR-008).
- An unread-conversations count for the navigation badge. Another user's conversations return
  404, so their existence is not revealed.

**Platform**

- `GET /health` reports the API and database status.
- Swagger UI at `/api/docs` and the OpenAPI JSON at `/api/docs-json`.
- Rate limiting by client IP (ADR-012): 100 requests per minute overall, 10 per minute on
  sign-up, login and refresh, 20 per minute on uploads and 30 per minute on sending messages.
- Central error handling: a global exception filter returns one error shape
  (`statusCode`, `error`, `message`, `path`, `timestamp`) and never exposes stack traces or raw
  Prisma or Firebase errors.
- Every body, query and route parameter is validated with a DTO (unknown fields are rejected).
  Helmet sets security headers, and a request-logging middleware logs every request.
- A demo data seed (`npm run db:seed`) creates six demo users with avatars, about 25 posts,
  likes, saves, follows, comments and two conversations.

## Technology Stack

| Area         | Technology                                                                   |
| ------------ | ---------------------------------------------------------------------------- |
| Runtime      | Node.js 26 (`.nvmrc`), TypeScript (strict)                                   |
| Framework    | NestJS 12 (`@nestjs/core`, `@nestjs/config`, `@nestjs/throttler`)            |
| Database     | PostgreSQL 18, Prisma ORM 7 with the `@prisma/adapter-pg` driver (ADR-001)   |
| Identity     | Firebase Authentication: `firebase-admin` 14 and the Firebase Auth REST API  |
| Media        | Firebase Storage (through `firebase-admin`)                                  |
| Validation   | `class-validator`, `class-transformer`                                       |
| API docs     | `@nestjs/swagger` (OpenAPI, Swagger UI)                                      |
| Security     | `helmet`, `cookie-parser`, `@nestjs/throttler`                               |
| Tests        | Jest 30, `ts-jest`, Supertest                                                |
| Code quality | oxlint with type-aware rules (ADR-010), Prettier                             |
| Local DB     | Docker Compose (`postgres:18-alpine`)                                        |
| Deployment   | AWS EC2 (Ubuntu), Nginx, PM2, Let's Encrypt (certbot), GitHub Actions for CI |

## Installation

**Prerequisites**

- Node.js 26 and npm 11 or later (`package.json` `engines`, `.nvmrc`)
- Docker, for the local PostgreSQL database
- A Firebase project with Authentication (email/password) and Storage enabled, and a service
  account key (see [Environment Variables](#environment-variables))

**Steps**

```bash
git clone https://github.com/ChathuniPG/rocky-api.git
cd rocky-api

# Create your local configuration, then fill in the values (see Environment Variables).
cp .env.example .env

# Install dependencies. postinstall runs `prisma generate`.
npm ci

# Start PostgreSQL 18 in Docker (bound to 127.0.0.1) and wait until it is healthy.
npm run db:up

# Apply the migrations to the local database.
npm run db:migrate:deploy

# Optional: check the Firebase configuration.
npm run firebase:smoke

# Optional: demo data (needs SEED_DEMO_PASSWORD and SEED_ENV=local in .env).
npm run db:seed
```

## Run Instructions

Start the development server with watch mode:

```bash
npm run start:dev
```

| URL                                   | What                                            |
| ------------------------------------- | ----------------------------------------------- |
| `http://127.0.0.1:4000/api/v1`        | API base path                                   |
| `http://127.0.0.1:4000/api/v1/health` | Health check: `{"status":"ok","database":"up"}` |
| `http://127.0.0.1:4000/api/docs`      | Swagger UI                                      |
| `http://127.0.0.1:4000/api/docs-json` | OpenAPI document                                |

To use the API from the frontend locally, run rocky-web as well. Its dev server forwards `/api`
to this API, the same way Nginx does in production (ADR-004).

Other scripts:

| Script                                    | Purpose                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `npm run build` / `npm run start:prod`    | Compile to `dist/` and run `dist/main.js`                         |
| `npm run start:debug`                     | Watch mode with the Node inspector                                |
| `npm run lint` / `npm run lint:fix`       | oxlint (type-aware) on `src/`, `test/` and `scripts/`             |
| `npm run format` / `npm run format:check` | Prettier                                                          |
| `npm run typecheck`                       | `tsc --noEmit`                                                    |
| `npm test` / `npm run test:e2e`           | Unit tests / end-to-end tests (see [Testing](#testing))           |
| `npm run test:cov`                        | Unit tests with coverage                                          |
| `npm run prisma:migrate`                  | Create and apply a new migration while developing (`migrate dev`) |
| `npm run db:migrate:deploy`               | Apply the existing migrations (`migrate deploy`)                  |
| `npm run prisma:generate`                 | Regenerate the Prisma client                                      |
| `npm run prisma:studio`                   | Browse the database in Prisma Studio                              |
| `npm run db:seed`                         | Demo data. Use `-- --reset` to delete and re-create it            |
| `npm run db:up` / `db:down` / `db:logs`   | Start, stop or tail the local PostgreSQL container                |

## How to try the API in Swagger

Open [the live Swagger UI](https://rocky-social.duckdns.org/api/docs) (or
`http://127.0.0.1:4000/api/docs` locally).

Authentication **does not use an `Authorization: Bearer` header**. The Firebase ID token (a JWT)
travels in the httpOnly `rocky_id` cookie, which the API sets itself (ADR-003). Swagger's
**Authorize** dialog is not needed:

1. Expand **POST /api/v1/auth/login**, choose **Try it out** and send the demo credentials:

   ```json
   { "email": "demo.maya+production@example.com", "password": "Rocky1234" }
   ```

2. The response sets the `rocky_id` and `rocky_refresh` cookies. The browser sends them
   automatically with every later request from the Swagger page, so protected endpoints such as
   `GET /api/v1/auth/me` or `GET /api/v1/posts/feed` now work.
3. The ID token expires after one hour. Call **POST /api/v1/auth/refresh** to get a new one, and
   **POST /api/v1/auth/logout** to end the session.

## Environment Variables

All variables are listed with explanations in [`.env.example`](.env.example). Copy it to `.env`
and fill in your values. At startup `src/config/env.validation.ts` validates every variable, and
the API refuses to start if one is missing or invalid. **Secrets are never committed:** `.env` is
in `.gitignore`, and the Firebase service account key lives outside the repository.

| Variable                        | Required | Purpose                                                                         |
| ------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `NODE_ENV`                      | No       | `development` (default), `production` or `test`                                 |
| `PORT`                          | No       | HTTP port, default `4000`                                                       |
| `HOST`                          | No       | Interface to listen on, default `127.0.0.1` (only Nginx can reach the API)      |
| `POSTGRES_USER`                 | Local    | Database user for Docker Compose (not read by the API)                          |
| `POSTGRES_PASSWORD`             | Local    | Database password for Docker Compose (not read by the API)                      |
| `POSTGRES_DB`                   | Local    | Database name for Docker Compose (not read by the API)                          |
| `POSTGRES_PORT`                 | No       | Host port of the local database, default `5432`                                 |
| `DATABASE_URL`                  | Yes      | PostgreSQL connection string used by the API and the Prisma CLI                 |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Yes      | Absolute path to the Firebase Admin SDK service account JSON (ADR-011)          |
| `FIREBASE_PROJECT_ID`           | Yes      | Firebase project ID                                                             |
| `FIREBASE_STORAGE_BUCKET`       | Yes      | Storage bucket name, without `gs://`                                            |
| `FIREBASE_WEB_API_KEY`          | Yes      | Web API key for the Auth REST sign-in and refresh calls. Treat it as secret     |
| `COOKIE_SECURE`                 | No       | `Secure` flag on the auth cookies, default `true`. Must be `true` in production |
| `SEED_DEMO_PASSWORD`            | Seed     | Shared password of the demo users (seed script only)                            |
| `SEED_ENV`                      | Seed     | `local` or `production`. Part of every demo email (seed script only)            |

### Firebase Admin SDK setup

1. In the [Firebase console](https://console.firebase.google.com/), create a project and enable
   **Authentication → Email/Password** and **Storage**.
2. **Project settings → Service accounts → Generate new private key.** Save the JSON file
   **outside the repository** and put its absolute path in `FIREBASE_SERVICE_ACCOUNT_PATH`
   (ADR-011). At startup the API checks that the file has `project_id`, `client_email` and
   `private_key`, and that `project_id` equals `FIREBASE_PROJECT_ID`.
3. **Project settings → General:** copy the project ID into `FIREBASE_PROJECT_ID` and the Web API
   key into `FIREBASE_WEB_API_KEY`.
4. From the **Storage** page, copy the bucket name (usually `<project-id>.firebasestorage.app`)
   into `FIREBASE_STORAGE_BUCKET`.

### PostgreSQL setup

- **Local:** `docker-compose.yml` runs `postgres:18-alpine`, bound to `127.0.0.1`. It reads
  `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` and `POSTGRES_PORT` from `.env`.
  `DATABASE_URL` must repeat those values literally
  (`postgresql://USER:PASSWORD@127.0.0.1:5432/DATABASE`), because `.env` does not expand
  variables.
- **Production:** PostgreSQL 18 runs on the EC2 instance and listens on localhost only (ADR-009).
  It has a dedicated `rocky` user that owns the `rocky` database. Only `DATABASE_URL` is set. See
  [deployment.md §7](docs/deployment.md#7-postgresql-18).

## Data Model

PostgreSQL holds the application data, which Prisma manages through `prisma/schema.prisma` and
the migrations in `prisma/migrations/`. Primary keys are database-generated UUIDs, every relation
uses `ON DELETE CASCADE`, and names are `snake_case` in the database and `camelCase` in code.

| Table           | Purpose                                                     | Key constraints                                                                                          |
| --------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `users`         | Profile and settings, linked to the Firebase account        | Unique `firebase_uid`, `email` and `username`. CHECK: username matches `^[a-z0-9_.]{3,30}$`              |
| `posts`         | One image or video with a caption and denormalised counters | Unique `media_path`. `media_type` enum (`IMAGE`, `VIDEO`). CHECK: `like_count ≥ 0`, `comment_count ≥ 0`  |
| `comments`      | Comments on a post                                          | `body` up to 500 characters. CHECK: body not blank                                                       |
| `likes`         | Who liked which post                                        | Composite PK (`user_id`, `post_id`), so no duplicate likes                                               |
| `saves`         | Posts a user saved                                          | Composite PK (`user_id`, `post_id`), so no duplicate saves                                               |
| `follows`       | Follower → following (self-referencing many-to-many)        | Composite PK (`follower_id`, `following_id`). CHECK: `follower_id <> following_id`                       |
| `notifications` | Like, comment and follow notifications                      | `type` enum (`LIKE`, `COMMENT`, `FOLLOW`). Optional FKs to `posts` and `comments`                        |
| `conversations` | One-to-one conversation between two users                   | Unique (`user_a_id`, `user_b_id`). CHECK: `user_a_id < user_b_id`, so there is one conversation per pair |
| `messages`      | Messages in a conversation, with read status                | `body` up to 1,000 characters. CHECK: body not blank                                                     |

Cursor-paginated tables store `created_at` (and `conversations.last_message_at`) with millisecond
precision, and every list query has a matching index (ADR-005).

![Database ERD](docs/diagrams/rocky_database_schema_erd.drawio.svg)

_Figure 3: Database ERD: the R.O.C.K.Y. PostgreSQL schema (crow’s foot notation)_

Column-level detail: [design.md §4 Data Model](docs/design.md#4-data-model).

## Module and Controller Structure

The global prefix is `/api/v1` (Swagger is the exception: `/api/docs`). Controllers are thin and
delegate to services, and only services use Prisma. All routes require the `rocky_id` cookie
except those marked _public_.

| Module                | Controller(s)                                   | Routes                                                                                                                                                                                                                  | Responsibility                                                                                          |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `AuthModule`          | `AuthController`                                | `POST /auth/signup` _(public)_, `POST /auth/login` _(public)_, `POST /auth/refresh` _(public, refresh cookie)_, `POST /auth/logout` _(public, either cookie)_, `GET /auth/me`                                           | Sign-up with compensation, login, refresh, logout and auth cookies (`AuthService`, `AuthCookieService`) |
| `UsersModule`         | `UsersController`                               | `GET /users/search`, `GET /users/me/saved`, `PATCH /users/me`, `GET /users/:username`, `GET /users/:username/posts`, `POST /users/:id/follow`, `DELETE /users/:id/follow`                                               | Profiles, settings, search and follows (`UsersService`, `FollowsService`)                               |
| `PostsModule`         | `PostsController`, `CommentsController`         | `POST /posts`, `GET /posts/feed`, `GET /posts/:id`, `PATCH /posts/:id`, `DELETE /posts/:id`, `POST`/`DELETE /posts/:id/like`, `POST`/`DELETE /posts/:id/save`, `GET`/`POST /posts/:id/comments`, `DELETE /comments/:id` | Posts, feed, likes, saves and comments (`PostsService`, `PostEngagementService`, `CommentsService`)     |
| `UploadsModule`       | `UploadsController`                             | `POST /uploads`                                                                                                                                                                                                         | Multipart parsing, magic-byte validation and Firebase Storage uploads                                   |
| `NotificationsModule` | `NotificationsController`                       | `GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/read-all`, `PATCH /notifications/:id/read`                                                                                               | Notification queries. Exports the service other modules use to create notifications                     |
| `MessagesModule`      | `ConversationsController`, `MessagesController` | `GET /conversations`, `GET /conversations/unread-count`, `POST /conversations`, `GET /conversations/:id/messages`, `POST /conversations/:id/messages`, `PATCH /conversations/:id/read`                                  | Conversations, messages, read status and polling (`ConversationsService`, `MessagesService`)            |
| `HealthModule`        | `HealthController`                              | `GET /health` _(public)_                                                                                                                                                                                                | API and database status                                                                                 |

The infrastructure modules have no controllers:

| Module           | Location        | Responsibility                                                                     |
| ---------------- | --------------- | ---------------------------------------------------------------------------------- |
| `ConfigModule`   | `src/config/`   | Loads `.env` and validates every variable at startup                               |
| `PrismaModule`   | `src/prisma/`   | Global `PrismaService` (database client) and Prisma error mapping                  |
| `FirebaseModule` | `src/firebase/` | Admin SDK initialisation, Auth REST client, token verification and Storage service |

```text
src/
├── main.ts, app.module.ts, app.setup.ts   bootstrap, global pipes/filters, Helmet, Swagger
├── common/        auth cookies, @CurrentUser() and @Public() decorators, FirebaseAuthGuard,
│                  global exception filter, request-logging middleware, cursor pagination,
│                  Swagger error responses, rate-limit constants, utilities
├── config/        environment validation
├── firebase/      Firebase Admin SDK and Auth REST API
├── prisma/        PrismaService
└── modules/       auth, users, posts, uploads, notifications, messages, health
```

The full endpoint contract is in [design.md §5 API Contract](docs/design.md#5-api-contract) and in
Swagger.

## Design Decisions

The Architecture Decision Records are in [design.md §8](docs/design.md#8-architecture-decision-records):

| ADR                                                                                        | Decision                                                                                              |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [ADR-001](docs/design.md#adr-001-prisma-as-the-orm)                                        | Prisma as the ORM, for type safety and reliable migrations                                            |
| [ADR-002](docs/design.md#adr-002-firebase-rest-api-for-sign-in-admin-sdk-for-verification) | Firebase Auth REST API to sign in and refresh, Admin SDK to create users and verify and revoke tokens |
| [ADR-003](docs/design.md#adr-003-httponly-cookies-for-token-storage)                       | Tokens in httpOnly, Secure, SameSite=Lax cookies, never in localStorage                               |
| [ADR-004](docs/design.md#adr-004-single-domain-with-nginx-path-based-routing)              | One domain: Nginx routes `/api` to NestJS and `/` to Next.js, so no CORS is needed                    |
| [ADR-005](docs/design.md#adr-005-cursor-based-pagination)                                  | Cursor (keyset) pagination on `(created_at, id)`                                                      |
| [ADR-006](docs/design.md#adr-006-denormalized-like-and-comment-counters)                   | Denormalised `like_count` and `comment_count`, updated in the same transaction                        |
| [ADR-007](docs/design.md#adr-007-two-step-media-upload)                                    | Two-step upload: `POST /uploads` returns a path, and `POST /posts` uses it (ownership checked)        |
| [ADR-008](docs/design.md#adr-008-polling-for-new-messages)                                 | Poll for new messages instead of WebSockets                                                           |
| [ADR-009](docs/design.md#adr-009-postgresql-on-the-same-ec2-instance)                      | PostgreSQL on the same EC2 instance, bound to localhost                                               |
| [ADR-010](docs/design.md#adr-010-oxlint-as-the-backend-linter)                             | oxlint (type-aware) as the linter, Prettier as the formatter                                          |
| [ADR-011](docs/design.md#adr-011-service-account-loaded-from-a-file-path)                  | Service account key loaded from a file path, validated at startup                                     |
| [ADR-012](docs/design.md#adr-012-in-memory-rate-limit-storage)                             | In-memory rate-limit storage, keyed by client IP, with a single PM2 instance                          |
| [ADR-013](docs/design.md#adr-013-client-side-route-protection)                             | Client-side route protection in rocky-web, so sessions survive ID-token expiry                        |
| [ADR-014](docs/design.md#adr-014-full-page-load-when-the-signed-in-user-changes)           | Full page load when the signed-in user changes (rocky-web)                                            |

Further decisions in the implementation:

- **Notifications are server-side side effects.** Likes, comments and follows create notifications
  in the same operation. There is no public endpoint for creating a notification, so clients
  cannot forge one. (The brief's "create" operation is covered by sending messages.) Repeated
  likes or follows do not notify twice.
- **Denormalised counters in transactions.** `like_count` and `comment_count` change in the same
  Prisma transaction as the row they count (ADR-006), and CHECK constraints stop them from going
  negative.
- **Keyset pagination with millisecond timestamps.** Every list returns `{ items, nextCursor }`.
  Cursor columns are `timestamptz(3)`, because a JavaScript `Date` holds only milliseconds. With
  microsecond precision, rows in the same millisecond as the cursor row would be skipped.
- **CHECK constraints in migrations.** Prisma Schema Language cannot express them, so they are
  written by hand in the initial migration
  (`prisma/migrations/20261105193848_init/migration.sql`). CI's migration drift check confirms
  that the migrations match `schema.prisma`.

## Testing

| Suite      | Command            | Count                  | Needs                                            |
| ---------- | ------------------ | ---------------------- | ------------------------------------------------ |
| Unit       | `npm test`         | 703 tests in 41 suites | Nothing: Prisma and Firebase are mocked          |
| End-to-end | `npm run test:e2e` | 112 tests in 11 suites | The local database and the live Firebase project |

- **Unit tests** sit next to the code they test (`*.spec.ts` in `src/` and `scripts/`).
- **End-to-end tests** (`test/*.e2e-spec.ts`) start the real `AppModule` against the local
  PostgreSQL database and the **live Firebase project**. Each suite creates uniquely named users
  and deletes them afterwards (the database row, which cascades, and the Firebase account), along
  with any files it uploaded. Before running them: create `.env`, then run `npm run db:up` and
  `npm run db:migrate:deploy`.
- **CI** (GitHub Actions) runs on every pull request and every push to `main`. It covers
  everything except e2e: lint, format check, typecheck, build, unit tests, and a migration job
  that applies all migrations to a fresh PostgreSQL 18 database and checks for schema drift. It
  needs no secrets. See [docs/ci.md](docs/ci.md).

## AWS EC2 Deployment Steps

Production runs on one EC2 instance. The full, tested guide is
[docs/deployment.md](docs/deployment.md), and these are its steps in brief:

1. **Instance and security group:** Ubuntu Server 26.04 LTS on a `t3.small`, with an ED25519 key
   pair and 20 GiB gp3 storage. The security group opens only 22 (from your admin IP), 80 and 443.
   Ports 4000 and 5432 are never opened. ([§2](docs/deployment.md#2-launch-the-ec2-instance))
2. **Elastic IP:** allocate one and associate it with the instance, so the address (and the DNS
   record) stays fixed. ([§3](docs/deployment.md#3-allocate-an-elastic-ip))
3. **Base system and swap:** `apt upgrade`, plus a 2 GiB swap file so `npm ci` and the build do
   not run out of memory. ([§5](docs/deployment.md#5-base-system-and-swap))
4. **Node.js 26** from NodeSource. ([§6](docs/deployment.md#6-nodejs-26))
5. **PostgreSQL 18** from the PGDG repository, on localhost only, with a `rocky` user and
   database. ([§7](docs/deployment.md#7-postgresql-18))
6. **Nginx and PM2:** install Nginx, then PM2 globally with `pm2-logrotate`.
   ([§8](docs/deployment.md#8-nginx-and-pm2))
7. **Firebase key file:** copy the service account JSON with `scp` to
   `~/rocky/secrets/firebase-admin.json` (directory mode 700, file mode 600).
   ([§9](docs/deployment.md#9-firebase-service-account))
8. **Clone the repo and create `.env`:** set `NODE_ENV=production` and `COOKIE_SECURE=true`, plus
   `DATABASE_URL` and the Firebase variables. Then `chmod 600 .env`.
   ([§10](docs/deployment.md#10-clone-the-repository), [§11](docs/deployment.md#11-production-env))
9. **Build, migrate and start:** `npm ci --include=dev`, `npm run build`,
   `npm run db:migrate:deploy` and `pm2 start ecosystem.config.cjs` (one fork-mode instance).
   ([§12](docs/deployment.md#12-build-migrate-and-start))
10. **Start on boot:** `pm2 startup systemd` and `pm2 save`.
    ([§13](docs/deployment.md#13-start-on-boot))
11. **Nginx site:** install `deploy/nginx/rocky.conf`, which proxies `/api/` to `127.0.0.1:4000`
    and `/` to `127.0.0.1:3000`, overwrites `X-Forwarded-For` and allows 30 MB bodies. Then
    `nginx -t` and reload. ([§14](docs/deployment.md#14-enable-the-nginx-site))
12. **Frontend and HTTPS:** deploy rocky-web under PM2, point `rocky-social.duckdns.org` at the
    Elastic IP and run `certbot --nginx --redirect` for Let's Encrypt with automatic renewal.
    The config adds HSTS. ([§16](docs/deployment.md#16-frontend-and-https))
13. **Redeploy:** `bash ~/rocky/rocky-api/deploy/redeploy.sh` pulls, installs, builds, migrates,
    reloads PM2 and polls the health check. ([§17](docs/deployment.md#17-redeploy))
14. **Demo data:** set `SEED_DEMO_PASSWORD` and `SEED_ENV=production`, then run
    `npm run db:seed -- --allow-production`.
    ([§12, Demo data](docs/deployment.md#demo-data-for-reviewers-optional))

## Known Limitations

- **In-memory rate limiting.** The counters live in the API process, so the limits are only
  correct with a single instance. They reset on restart (ADR-012).
- **Firebase revocation is second-granular.** Firebase records revocation times in whole seconds,
  so an ID token issued in the same second as a logout can still pass the revocation check.
- **Polling, not real-time.** New messages and badge counts arrive on the next poll (ADR-008).
- **Video: MP4 and WebM only, no transcoding.** Files are stored as uploaded. For an MP4 whose index
  (`moov` box) is at the end of the file, the browser needs extra range requests to fetch the
  index each time playback starts, which adds latency.
- **One Firebase project for development and production.** The `+local` / `+production` suffix
  in demo emails keeps their accounts apart, but the environments are not isolated.
- **firebase-admin deprecation warnings.** Warnings from its `google-auth-library` dependency
  appear in the logs. They have no functional impact.
- **npm audit advisories.** The remaining advisories are in development tooling only, not in the
  runtime dependencies.
- **Possible orphaned uploads.** An upload that is never used for a post, or a Storage file whose
  deletion fails, stays in the bucket. Such failures are logged (ADR-007).
- **No account deletion.** The API has no endpoint for deleting a user.
- **Plain HTTP by bare IP returns 404.** Only `rocky-social.duckdns.org` is served, and plain HTTP
  for that name is redirected to HTTPS.

## Future Improvements

- Real-time messages and notifications with WebSockets or Server-Sent Events.
- Followers and following lists, and follow status on feed posts.
- Server-side video transcoding and MP4 _faststart_ (index moved to the front).
- A partial index for the unread-messages count (`read_at IS NULL`).
- `pg_trgm` trigram indexes for user search.
- Redis-backed rate limiting, so the API can run as several instances.
- Separate Firebase projects per environment.
- A scheduled cleanup job for orphaned uploads.
- Account deletion that keeps the denormalised counters correct.
- Upgrading `firebase-admin` once a release removes the deprecation warnings.

## AI-assisted development

This project was built with [Claude Code](https://claude.com/claude-code) as an AI pair
programmer, guided by the rules in [`CLAUDE.md`](CLAUDE.md): architecture, code standards,
testing and security. The developer planned, reviewed, tested and committed every change, through
GitHub issues and pull requests that pass CI.

## Documentation

| Document                                     | Contents                                                     |
| -------------------------------------------- | ------------------------------------------------------------ |
| [docs/requirements.md](docs/requirements.md) | Functional and non-functional requirements (`FR-*`, `NFR-*`) |
| [docs/design.md](docs/design.md)             | Architecture, authentication, data model, API contract, ADRs |
| [docs/deployment.md](docs/deployment.md)     | AWS EC2 setup, Nginx, PM2, HTTPS and redeploy                |
| [docs/ci.md](docs/ci.md)                     | GitHub Actions workflow and running e2e tests locally        |
| [docs/diagrams/](docs/diagrams/)             | Editable draw.io SVG diagrams (Figures 1–5)                  |
