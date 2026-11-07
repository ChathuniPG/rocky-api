import {
  assertSeedAllowed,
  classifyDemoUser,
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
    expect(classifyDemoUser(null, null)).toEqual({ kind: 'create' });
  });

  it('deletes an orphaned Firebase account before creating the user', () => {
    expect(classifyDemoUser(null, 'uid-9')).toEqual({ kind: 'create', deleteFirebaseUid: 'uid-9' });
  });

  it('deletes a row whose Firebase account is gone before creating the user', () => {
    expect(classifyDemoUser(row, null)).toEqual({ kind: 'create', deleteUserId: 'user-1' });
  });

  it('deletes both when the row points at a different Firebase account', () => {
    expect(classifyDemoUser(row, 'uid-9')).toEqual({
      kind: 'create',
      deleteFirebaseUid: 'uid-9',
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

describe('planReset', () => {
  const demoEmails = new Set(['demo.maya@example.com', 'demo.leo@example.com']);
  const maya = { id: 'id-maya', firebaseUid: 'uid-maya', username: 'demo_maya' };

  it('deletes the storage folders, Firebase account and row of each demo user', () => {
    expect(
      planReset([maya], [{ email: 'demo.maya@example.com', uid: 'uid-maya' }], demoEmails),
    ).toEqual({
      storagePrefixes: ['posts/id-maya/', 'avatars/id-maya/'],
      firebaseUids: ['uid-maya'],
      userIds: ['id-maya'],
    });
  });

  it('also deletes a demo Firebase account that has no row', () => {
    const plan = planReset([], [{ email: 'demo.leo@example.com', uid: 'uid-leo' }], demoEmails);

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
