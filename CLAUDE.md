# CLAUDE.md — rocky-api

## Project

R.O.C.K.Y. (Regular Online Content Kernel Yarn) is a TikTok-style social media platform built as a technical assessment.
This repository is the backend: a NestJS REST API. The frontend (rocky-web, Next.js) is a separate repository.

Always follow these documents. If a task conflicts with them, stop and ask:

- docs/requirements.md — requirements with IDs (FR-_, NFR-_)
- docs/design.md — architecture, auth flow, data model, API contract, ADRs

## The developer

The developer is learning NestJS, TypeScript and Prisma during this project and has a Java / Spring Boot background.

- Explain new concepts briefly, using Spring Boot comparisons where helpful.
- Before writing code for a non-trivial task, present a short plan and wait for approval.
- Work in small, reviewable steps. Stop after each step and summarise what changed and why.
- Suggest a Conventional Commit message after each step.

## Tech stack

- Node.js 26 LTS, TypeScript (strict mode), NestJS
- PostgreSQL via Prisma ORM
- Firebase Admin SDK (token verification, user management, Storage) and the Firebase Auth REST API (sign-in, token refresh) — see ADR-002
- Validation: class-validator and class-transformer on DTOs
- API docs: @nestjs/swagger
- Tests: Jest

## Architecture rules

- NestJS is the only component that talks to PostgreSQL and Firebase.
- One feature module per domain under src/modules/: auth, users, posts, uploads, notifications, messages, health.
- Shared code lives in src/common/ (decorators, filters, guards, interceptors, utilities).
- Infrastructure modules: src/prisma/, src/firebase/, src/config/.
- Controllers are thin: parse input, call a service, return the result. No business logic or database access in controllers.
- Services contain business logic. Only services use PrismaService.
- Every request body, query and route parameter is validated with a DTO.
- Operations that change more than one row (e.g. creating a like and incrementing like_count) run in a single Prisma transaction (ADR-006).
- Ownership is always checked on the server for update and delete operations (NFR-SEC-02).
- Base path /api/v1. List endpoints use cursor pagination returning { items, nextCursor } (ADR-005).
- Errors use NestJS HTTP exceptions and are formatted by the global exception filter.

## Code standards

- No `any`. Use precise types, `unknown` plus narrowing where needed.
- No floating promises; always await or explicitly handle them.
- Use the NestJS Logger. Never use console.log.
- Never hard-code configuration; read it through ConfigService. Every variable is validated at startup and listed in .env.example.
- Small, single-purpose functions with descriptive names. Prefer early returns over deep nesting.
- Files and folders: kebab-case (posts.service.ts). Classes: PascalCase. Variables and functions: camelCase. Database: snake_case mapped with @map / @@map.
- Do not add a new dependency without explaining why it is needed and asking first. Prefer official NestJS packages and well-maintained libraries.

## Comments

- Every exported class and every public service method has a TSDoc comment: what it does, important parameters, what it returns, and which exceptions it throws.
- Inline comments explain WHY, not WHAT: non-obvious decisions, edge cases, security reasoning.
- Reference requirement IDs or ADRs where a decision comes from them, e.g. `// ADR-006: counter updated in the same transaction as the like.`
- No commented-out code. No TODO without an issue number, e.g. `// TODO(#14): ...`.

## Testing

- Unit tests for services, with Prisma and Firebase mocked.
- Test files sit next to the code they test: posts.service.spec.ts.
- Before declaring a step complete, run: npm run lint, npm run typecheck, npm run build, npm test.

## Security

- Never read, print or modify .env files or any service account JSON. Use .env.example for documentation.
- Never log tokens, passwords, cookies or private keys.
- Never return stack traces or raw Firebase / Prisma errors to clients.

## Git

- Do not run git commands (no commit, push, branch or reset). The developer handles all Git operations.
- Commit messages follow Conventional Commits: type(scope): description.
