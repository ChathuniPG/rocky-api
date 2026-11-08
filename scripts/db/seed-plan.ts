/**
 * Pure decision logic of the demo seed: command-line flags, the production guard, what
 * to do with each demo user, which planned rows are still missing, and what a reset
 * deletes. Kept free of Nest, Prisma and Firebase so every decision is unit-tested.
 */
import { SeedEnv } from '../../src/config/env.validation';

/** Every demo username starts with this; a reset deletes exactly these users. */
export const DEMO_USERNAME_PREFIX = 'demo_';

/** Reserved for documentation (RFC 2606): demo emails can never reach a real inbox. */
export const DEMO_EMAIL_DOMAIN = 'example.com';

/**
 * The email of a demo user in one environment, e.g. `demo.maya+production@example.com`.
 * Local and production share one Firebase project, so the environment is part of the
 * email: each environment's demo accounts are distinct, and every Firebase lookup the seed
 * makes by email can only ever find the current environment's account.
 *
 * @param key - The demo user's key (the username without the prefix), e.g. `maya`.
 * @param seedEnv - The validated SEED_ENV.
 * @returns The email.
 */
export function demoEmail(key: string, seedEnv: SeedEnv): string {
  return `demo.${key}+${seedEnv}@${DEMO_EMAIL_DOMAIN}`;
}

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
 * Refuses a SEED_ENV that does not match NODE_ENV. Without this, a developer machine with
 * SEED_ENV=production would look up, and on a reset delete, the production demo accounts
 * in the shared Firebase project; and a server .env copied with SEED_ENV=local would do
 * the same to the local ones.
 *
 * @param nodeEnv - The validated NODE_ENV.
 * @param seedEnv - The validated SEED_ENV.
 * @throws {SeedRefusedError} If exactly one of NODE_ENV and SEED_ENV is production.
 */
export function assertSeedEnvMatches(nodeEnv: string, seedEnv: SeedEnv): void {
  const productionNode = nodeEnv === 'production';
  const productionSeed = seedEnv === SeedEnv.Production;
  if (productionNode === productionSeed) {
    return;
  }
  throw new SeedRefusedError(
    productionNode
      ? 'NODE_ENV is production but SEED_ENV is not. Set SEED_ENV=production on the server.'
      : `SEED_ENV=production requires NODE_ENV=production. Use SEED_ENV=${SeedEnv.Local} here.`,
  );
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
      /**
       * Firebase accounts to delete before sign-up: the one with this environment's demo
       * email (sign-up would fail on it), and the one the stale row is linked to.
       */
      deleteFirebaseUids: string[];
      /** A users row that is not linked to the account with the demo email, to delete (cascades). */
      deleteUserId?: string;
    };

/**
 * Decides whether a demo user can be kept or must be (re)created. Only a users row and
 * a Firebase account that belong together are kept. Anything half-finished, e.g. left by
 * an interrupted run, is removed and created again, because sign-up would otherwise fail
 * on the existing email or username.
 *
 * The row's own linked account is deleted too: sign-up creates a row and its account
 * together and each environment has its own database, so that account belongs to this
 * environment (for example one created under an older email scheme) and would otherwise
 * be left behind in Firebase.
 *
 * @param row - The users row with the demo username, if any.
 * @param firebaseUid - UID of the Firebase account with this environment's demo email, if any.
 * @returns The action.
 */
export function classifyDemoUser(
  row: DemoUserRow | null,
  firebaseUid: string | null,
): DemoUserAction {
  if (row && row.firebaseUid === firebaseUid) {
    return { kind: 'keep', userId: row.id };
  }
  const uids = new Set<string>();
  if (firebaseUid !== null) {
    uids.add(firebaseUid);
  }
  if (row !== null) {
    uids.add(row.firebaseUid);
  }
  return {
    kind: 'create',
    deleteFirebaseUids: [...uids],
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

/** A Firebase account found by one of this environment's demo emails. */
export interface DemoFirebaseAccount {
  email: string;
  uid: string;
}

/** What a reset deletes, in the order it must be deleted. */
export interface ResetPlan {
  /** Storage folders of the demo users: their posts and avatars. */
  storagePrefixes: string[];
  /** Firebase accounts: those of the demo rows, plus this environment's demo emails without a row. */
  firebaseUids: string[];
  /** users rows; deleting them cascades to every row they own. */
  userIds: string[];
}

/**
 * Plans a reset. Storage goes first (the folder names need the user IDs), then Firebase,
 * then the rows: if a step fails, the rows still exist and a rerun finds everything again.
 *
 * Only this environment's accounts are deleted: those linked to a row of this environment's
 * database (sign-up creates both together), and those whose email is in `demoEmails`, the
 * exact set of this environment's demo emails. Another environment's demo accounts, and
 * accounts under the legacy un-suffixed emails that no row here links to, are never touched.
 *
 * @param rows - users rows whose username starts with the demo prefix.
 * @param accounts - Firebase accounts found by looking up the demo emails.
 * @param demoEmails - This environment's demo emails (see demoEmail); accounts with any
 *   other email are never deleted.
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
