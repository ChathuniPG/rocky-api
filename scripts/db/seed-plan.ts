/**
 * Pure decision logic of the demo seed: command-line flags, the production guard, what
 * to do with each demo user, which planned rows are still missing, and what a reset
 * deletes. Kept free of Nest, Prisma and Firebase so every decision is unit-tested.
 */

/** Every demo username starts with this; a reset deletes exactly these users. */
export const DEMO_USERNAME_PREFIX = 'demo_';

/** Reserved for documentation (RFC 2606): demo emails can never reach a real inbox. */
export const DEMO_EMAIL_DOMAIN = 'example.com';

/** Parsed command-line flags. */
export interface SeedArgs {
  /** `--reset`: delete every demo user completely, then seed fresh. */
  reset: boolean;
  /** `--allow-production`: permit a deliberate run with NODE_ENV=production. */
  allowProduction: boolean;
}

/** Thrown when the seed must not run; its message is safe to print. */
export class SeedRefusedError extends Error {
  override readonly name = 'SeedRefusedError';
}

const FLAGS: Readonly<Record<string, keyof SeedArgs>> = {
  '--reset': 'reset',
  '--allow-production': 'allowProduction',
};

/**
 * Parses the seed's command-line flags.
 *
 * @param argv - The arguments after the script name (`process.argv.slice(2)`).
 * @returns The flags; absent flags are `false`.
 * @throws {SeedRefusedError} On an unknown argument, so a typo such as `--rest` never
 *   silently runs a normal seed instead of a reset.
 */
export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const args: SeedArgs = { reset: false, allowProduction: false };
  for (const argument of argv) {
    if (!Object.hasOwn(FLAGS, argument)) {
      throw new SeedRefusedError(
        `Unknown argument "${argument}". Allowed: ${Object.keys(FLAGS).join(', ')}`,
      );
    }
    args[FLAGS[argument]] = true;
  }
  return args;
}

/**
 * Refuses a production run unless it was explicitly requested, so the seed can be run
 * once on the live server for reviewers but never by accident.
 *
 * @param nodeEnv - The validated NODE_ENV.
 * @param args - The parsed flags.
 * @throws {SeedRefusedError} If NODE_ENV is production and `--allow-production` is absent.
 */
export function assertSeedAllowed(nodeEnv: string, args: SeedArgs): void {
  if (nodeEnv === 'production' && !args.allowProduction) {
    throw new SeedRefusedError(
      'NODE_ENV is production. Pass --allow-production to seed this database deliberately.',
    );
  }
}

/**
 * Whether a username belongs to a demo user. Checked in code as well as in the query,
 * because `_` is a LIKE wildcard: a mistake in escaping must not widen a reset.
 */
export function isDemoUsername(username: string): boolean {
  return username.startsWith(DEMO_USERNAME_PREFIX);
}

/** The users row of a demo user, as far as the decisions need it. */
export interface DemoUserRow {
  id: string;
  firebaseUid: string;
}

/** What to do with one planned demo user. */
export type DemoUserAction =
  | { kind: 'keep'; userId: string }
  | {
      kind: 'create';
      /** A stale Firebase account with the demo email, to delete before sign-up. */
      deleteFirebaseUid?: string;
      /** A users row whose Firebase account is gone, to delete (cascades) before sign-up. */
      deleteUserId?: string;
    };

/**
 * Decides whether a demo user can be kept or must be (re)created. Only a users row and
 * a Firebase account that belong together are kept. Anything half-finished, e.g. left by
 * an interrupted run, is removed and created again, because sign-up would otherwise fail
 * on the existing email or username.
 *
 * @param row - The users row with the demo username, if any.
 * @param firebaseUid - UID of the Firebase account with the demo email, if any.
 * @returns The action.
 */
export function classifyDemoUser(
  row: DemoUserRow | null,
  firebaseUid: string | null,
): DemoUserAction {
  if (row && row.firebaseUid === firebaseUid) {
    return { kind: 'keep', userId: row.id };
  }
  return {
    kind: 'create',
    ...(firebaseUid === null ? {} : { deleteFirebaseUid: firebaseUid }),
    ...(row === null ? {} : { deleteUserId: row.id }),
  };
}

/**
 * Returns the planned items that do not exist yet, in plan order. Used for operations
 * the services do not make idempotent themselves (posts, comments, messages).
 *
 * @param planned - Everything the seed wants to exist.
 * @param existingKeys - Keys of the rows that already exist.
 * @param keyOf - Builds the same key for a planned item.
 * @returns The items to create.
 */
export function missingByKey<T>(
  planned: readonly T[],
  existingKeys: ReadonlySet<string>,
  keyOf: (item: T) => string,
): T[] {
  return planned.filter((item) => !existingKeys.has(keyOf(item)));
}

/** A users row considered by a reset. */
export interface ResetCandidateRow extends DemoUserRow {
  username: string;
}

/** A Firebase account found by one of the demo emails. */
export interface DemoFirebaseAccount {
  email: string;
  uid: string;
}

/** What a reset deletes, in the order it must be deleted. */
export interface ResetPlan {
  /** Storage folders of the demo users: their posts and avatars. */
  storagePrefixes: string[];
  /** Firebase accounts: those of the demo rows, plus demo emails without a row. */
  firebaseUids: string[];
  /** users rows; deleting them cascades to every row they own. */
  userIds: string[];
}

/**
 * Plans a reset. Storage goes first (the folder names need the user IDs), then Firebase,
 * then the rows: if a step fails, the rows still exist and a rerun finds everything again.
 *
 * @param rows - users rows whose username starts with the demo prefix.
 * @param accounts - Firebase accounts found by looking up the demo emails.
 * @param demoEmails - The demo emails of the seed data; accounts with any other email
 *   are never deleted.
 * @returns The plan. Rows without the demo prefix are ignored.
 */
export function planReset(
  rows: readonly ResetCandidateRow[],
  accounts: readonly DemoFirebaseAccount[],
  demoEmails: ReadonlySet<string>,
): ResetPlan {
  const demoRows = rows.filter((row) => isDemoUsername(row.username));
  const firebaseUids = new Set(demoRows.map((row) => row.firebaseUid));
  for (const account of accounts) {
    if (demoEmails.has(account.email) && account.email.endsWith(`@${DEMO_EMAIL_DOMAIN}`)) {
      firebaseUids.add(account.uid);
    }
  }
  return {
    storagePrefixes: demoRows.flatMap((row) => [`posts/${row.id}/`, `avatars/${row.id}/`]),
    firebaseUids: [...firebaseUids],
    userIds: demoRows.map((row) => row.id),
  };
}
