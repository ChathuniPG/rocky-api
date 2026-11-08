# Continuous integration — rocky-api

CI runs on GitHub Actions (issue #13, NFR-MNT-02). The workflow is
`.github/workflows/ci.yml`; if this page and the workflow disagree, the workflow wins.

## When it runs

- Every pull request (any target branch).
- Every push to `main`.

A newer push to the same branch or PR cancels the run it supersedes.

## What it checks

| Job (status check name)        | Steps                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `Lint, typecheck, build, test` | `npm ci`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, `npm test` (unit tests) |
| `Prisma migrations`            | `npm ci`, `prisma migrate deploy` on a fresh PostgreSQL 18 database, then a drift check |

Both jobs use Ubuntu and the Node.js version in `.nvmrc`, with the npm cache enabled.

**Drift check.** After every migration has been applied to an empty database, CI runs
`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`.
The command exits with 2 if the database the migrations produced differs from `schema.prisma`,
which fails the job. That happens when the schema changed without a migration (fix: run
`npm run prisma:migrate`) or when a migration was edited by hand. Comparing the migrated
database, rather than using `--from-migrations`, means Prisma 7 needs no shadow database.

**No secrets.** CI needs no repository secrets:

- There is no `.env` in CI. `prisma.config.ts` loads `.env` only when it exists, and
  `prisma generate` (run by `postinstall`) needs no database.
- Environment validation (`src/config/env.validation.ts`) runs only when `AppModule` starts.
  Unit tests mock Prisma and Firebase and never start `AppModule`.
- The PostgreSQL service container uses throwaway credentials (`rocky_ci`) written in the
  workflow. The container exists only for the duration of the job and holds no data.

**Supply-chain hardening.**

- The workflow token is read-only (`permissions: contents: read`).
- `actions/checkout` runs with `persist-credentials: false`, so the token is not left in `.git/config`.
- Every action is pinned to a full commit SHA, with the release in a comment. To upgrade one,
  look up the commit of the new release tag (e.g. `https://github.com/actions/checkout/releases`),
  then update the SHA and the comment together.

## Why e2e tests run locally only

The e2e suites (`test/*.e2e-spec.ts`) start the real `AppModule` against the **live Firebase
project**. They create and delete real Firebase Auth accounts and Storage files. Running them in
CI would mean storing a Firebase service account key and the Web API key as repository secrets,
and pull-request runs would write to the real project. We accept that trade-off: e2e runs on the
developer's machine before a PR is opened.

## Running e2e tests locally

1. Create `.env` from `.env.example` and fill in the Firebase values. The service account key
   stays outside the repository (ADR-011).
2. Start the local database: `npm run db:up`.
3. Apply the migrations: `npm run db:migrate:deploy`.
4. Run the suites: `npm run test:e2e`.

Every suite creates uniquely named users (`uniqueTestUserCredentials`) and deletes them in
`afterAll` (`deleteTestUser`): the PostgreSQL row, which cascades, and the Firebase Auth
account. If a run is aborted, leftover accounts are named `rocky-<suite>-<suffix>@example.com`
and can be removed in the Firebase console and the database.

## Branch protection

Under **Settings → Branches → Branch protection rule for `main`**, enable "Require status checks
to pass before merging" and add both checks:

- `Lint, typecheck, build, test`
- `Prisma migrations`

A check only shows up in the search box after it has run at least once in the repository.
