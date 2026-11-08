import { SeedEnv } from '../../src/config/env.validation';
import {
  assertSeedAllowed,
  assertSeedEnvMatches,
  classifyDemoUser,
  demoEmail,
  isDemoUsername,
  missingByKey,
  parseSeedArgs,
  planReset,
  SeedRefusedError,
} from './seed-plan';

describe('parseSeedArgs', () => {
  it('defaults every flag to false', () => {
    expect(parseSeedArgs([])).toEqual({ reset: false, allowProduction: false });
  });

  it('reads --reset and --allow-production in any order', () => {
    expect(parseSeedArgs(['--allow-production', '--reset'])).toEqual({
      reset: true,
      allowProduction: true,
    });
  });

  it.each(['--rest', 'reset', '--RESET', '--reset=true', 'constructor'])(
    'rejects the unknown argument %p',
    (argument) => {
      expect(() => parseSeedArgs([argument])).toThrow(SeedRefusedError);
    },
  );
});

describe('assertSeedAllowed', () => {
  const noFlags = { reset: false, allowProduction: false };

  it.each(['development', 'test'])('allows %s without flags', (nodeEnv) => {
    expect(() => assertSeedAllowed(nodeEnv, noFlags)).not.toThrow();
  });

  it('refuses production without --allow-production', () => {
    expect(() => assertSeedAllowed('production', { ...noFlags, reset: true })).toThrow(
      /--allow-production/,
    );
  });

  it('allows production with --allow-production', () => {
    expect(() =>
      assertSeedAllowed('production', { reset: false, allowProduction: true }),
    ).not.toThrow();
  });
});

describe('demoEmail', () => {
  it.each([
    ['maya', SeedEnv.Local, 'demo.maya+local@example.com'],
    ['maya', SeedEnv.Production, 'demo.maya+production@example.com'],
    ['ravi', SeedEnv.Production, 'demo.ravi+production@example.com'],
  ])('%p in %p -> %p', (key, seedEnv, expected) => {
    expect(demoEmail(key, seedEnv)).toBe(expected);
  });

  it('gives each environment its own email, never the legacy un-suffixed one', () => {
    const emails = Object.values(SeedEnv).map((seedEnv) => demoEmail('maya', seedEnv));

    expect(new Set(emails).size).toBe(Object.values(SeedEnv).length);
    expect(emails).not.toContain('demo.maya@example.com');
  });
});

describe('assertSeedEnvMatches', () => {
  it.each([
    ['development', SeedEnv.Local],
    ['test', SeedEnv.Local],
    ['production', SeedEnv.Production],
  ])('allows NODE_ENV=%s with SEED_ENV=%s', (nodeEnv, seedEnv) => {
    expect(() => assertSeedEnvMatches(nodeEnv, seedEnv)).not.toThrow();
  });

  it.each([
    ['development', SeedEnv.Production],
    ['test', SeedEnv.Production],
    ['production', SeedEnv.Local],
  ])('refuses NODE_ENV=%s with SEED_ENV=%s', (nodeEnv, seedEnv) => {
    expect(() => assertSeedEnvMatches(nodeEnv, seedEnv)).toThrow(SeedRefusedError);
  });
});

describe('isDemoUsername', () => {
  it.each([
    ['demo_maya', true],
    ['demo_', true],
    ['demox', false],
    ['demo.maya', false],
    ['maya_demo_', false],
  ])('%p -> %p', (username, expected) => {
    expect(isDemoUsername(username)).toBe(expected);
  });
});

describe('classifyDemoUser', () => {
  const row = { id: 'user-1', firebaseUid: 'uid-1' };

  it('keeps a row whose Firebase account exists', () => {
    expect(classifyDemoUser(row, 'uid-1')).toEqual({ kind: 'keep', userId: 'user-1' });
  });

  it('creates a user that exists nowhere', () => {
    expect(classifyDemoUser(null, null)).toEqual({ kind: 'create', deleteFirebaseUids: [] });
  });

  it('deletes an orphaned Firebase account before creating the user', () => {
    expect(classifyDemoUser(null, 'uid-9')).toEqual({
      kind: 'create',
      deleteFirebaseUids: ['uid-9'],
    });
  });

  it('deletes a row without an account under the demo email, and its linked account', () => {
    // E.g. a row created under the legacy un-suffixed email: its account is this
    // environment's and would otherwise be left behind in Firebase.
    expect(classifyDemoUser(row, null)).toEqual({
      kind: 'create',
      deleteFirebaseUids: ['uid-1'],
      deleteUserId: 'user-1',
    });
  });

  it('deletes the row and both accounts when the row points at a different account', () => {
    expect(classifyDemoUser(row, 'uid-9')).toEqual({
      kind: 'create',
      deleteFirebaseUids: ['uid-9', 'uid-1'],
      deleteUserId: 'user-1',
    });
  });
});

describe('missingByKey', () => {
  const planned = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

  it('returns everything on a first run', () => {
    expect(missingByKey(planned, new Set(), (item) => item.key)).toEqual(planned);
  });

  it('returns nothing on a rerun', () => {
    expect(missingByKey(planned, new Set(['a', 'b', 'c']), (item) => item.key)).toEqual([]);
  });

  it('returns only the missing items, in plan order, after an interrupted run', () => {
    expect(missingByKey(planned, new Set(['b']), (item) => item.key)).toEqual([
      { key: 'a' },
      { key: 'c' },
    ]);
  });
});

/** This environment's demo email in the planReset tests: seeding local. */
function local(key: string): string {
  return demoEmail(key, SeedEnv.Local);
}

describe('planReset', () => {
  const demoEmails = new Set([local('maya'), local('leo')]);
  const maya = { id: 'id-maya', firebaseUid: 'uid-maya', username: 'demo_maya' };

  it('deletes the storage folders, Firebase account and row of each demo user', () => {
    expect(planReset([maya], [{ email: local('maya'), uid: 'uid-maya' }], demoEmails)).toEqual({
      storagePrefixes: ['posts/id-maya/', 'avatars/id-maya/'],
      firebaseUids: ['uid-maya'],
      userIds: ['id-maya'],
    });
  });

  it('also deletes a demo Firebase account that has no row', () => {
    const plan = planReset([], [{ email: local('leo'), uid: 'uid-leo' }], demoEmails);

    expect(plan).toEqual({ storagePrefixes: [], firebaseUids: ['uid-leo'], userIds: [] });
  });

  it('never touches rows without the demo prefix, even if the query returned them', () => {
    const plan = planReset(
      [{ id: 'id-real', firebaseUid: 'uid-real', username: 'demox' }],
      [],
      demoEmails,
    );

    expect(plan).toEqual({ storagePrefixes: [], firebaseUids: [], userIds: [] });
  });

  it("never deletes another environment's or a legacy demo account that no row links to", () => {
    const plan = planReset(
      [],
      [
        { email: demoEmail('maya', SeedEnv.Production), uid: 'uid-maya-production' },
        { email: 'demo.leo@example.com', uid: 'uid-leo-legacy' },
      ],
      demoEmails,
    );

    expect(plan.firebaseUids).toEqual([]);
  });

  it('deletes the account a demo row links to, whatever its email', () => {
    // Migration: a local row created under the legacy email scheme.
    const plan = planReset([maya], [], demoEmails);

    expect(plan.firebaseUids).toEqual(['uid-maya']);
  });

  it('never deletes a Firebase account whose email is not a demo email', () => {
    const plan = planReset(
      [],
      [
        { email: 'someone@gmail.com', uid: 'uid-real' },
        { email: 'other@example.com', uid: 'uid-other' },
      ],
      new Set(['someone@gmail.com']),
    );

    expect(plan.firebaseUids).toEqual([]);
  });

  it('is empty when there is nothing to reset', () => {
    expect(planReset([], [], demoEmails)).toEqual({
      storagePrefixes: [],
      firebaseUids: [],
      userIds: [],
    });
  });
});
