import { RESERVED_USERNAMES, USERNAME_PATTERN } from '../users/users.constants';
import { buildUsernameCandidates, type RandomInt } from './username-suggestion';

/** Returns the given values in turn, so suffixes are predictable. */
function sequence(...values: number[]): RandomInt {
  let index = 0;
  return () => values[index++ % values.length];
}

const fixedRandom = sequence(1, 22, 333, 4444, 5, 0xabc);

describe('buildUsernameCandidates', () => {
  it('starts with the email local part, then suffixed variants, then a user fallback', () => {
    expect(buildUsernameCandidates('alice@example.com', 'Alice', fixedRandom)).toEqual([
      'alice',
      'alice0001',
      'alice0022',
      'alice0333',
      'alice4444',
      'alice0005',
      'user00000abc',
    ]);
  });

  it.each([
    ['uppercase', 'John.Doe@gmail.com', 'john.doe'],
    ['diacritics', 'José.Müller@example.com', 'jose.muller'],
    ['disallowed characters', 'mary-jane+news@example.com', 'maryjanenews'],
    ['an @ in a quoted local part', '"a@b"cde@example.com', 'abcde'],
  ])('normalises %s', (_label, email, expected) => {
    expect(buildUsernameCandidates(email, undefined, fixedRandom)[0]).toBe(expected);
  });

  it('truncates a long base to 24 characters so suffixed names stay within 30', () => {
    const candidates = buildUsernameCandidates(`${'a'.repeat(40)}@example.com`, undefined);

    expect(candidates[0]).toBe('a'.repeat(24));
    for (const candidate of candidates) {
      expect(candidate.length).toBeLessThanOrEqual(30);
    }
  });

  it('extends a base shorter than 3 characters', () => {
    expect(buildUsernameCandidates('jo@example.com', undefined, fixedRandom)[0]).toBe('jouser');
  });

  it('falls back to the display name when the local part has no usable characters', () => {
    expect(buildUsernameCandidates('---@example.com', 'Ana Silva', fixedRandom)[0]).toBe(
      'anasilva',
    );
  });

  it('falls back to "user" when neither source has usable characters', () => {
    expect(buildUsernameCandidates('---@example.com', '李明', fixedRandom)[0]).toBe('user');
  });

  it('never suggests a reserved name, but keeps its suffixed variants', () => {
    for (const reserved of ['welcome', 'privacy', 'admin']) {
      const candidates = buildUsernameCandidates(`${reserved}@example.com`, undefined, fixedRandom);

      expect(candidates).not.toContain(reserved);
      expect(candidates[0]).toBe(`${reserved}0001`);
    }
  });

  it('only returns distinct names that match the username pattern and are not reserved', () => {
    const candidates = buildUsernameCandidates('x@example.com', undefined, sequence(7));

    expect(new Set(candidates).size).toBe(candidates.length);
    for (const candidate of candidates) {
      expect(candidate).toMatch(USERNAME_PATTERN);
      expect(RESERVED_USERNAMES).not.toContain(candidate);
    }
  });
});
