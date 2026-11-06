import { escapeLikePattern } from './like-pattern';

describe('escapeLikePattern', () => {
  it.each([
    ['plain text', 'alice', 'alice'],
    ['an underscore', 'e2e_user', 'e2e\\_user'],
    ['a percent sign', '100%', '100\\%'],
    ['a backslash', 'a\\b', 'a\\\\b'],
    ['every special character', '\\%_', '\\\\\\%\\_'],
    ['repeated wildcards', '__%%', '\\_\\_\\%\\%'],
    ['an empty string', '', ''],
  ])('escapes %s', (_name, input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });
});
