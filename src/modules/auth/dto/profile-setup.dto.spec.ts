import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_DISPLAY_NAME_LENGTH, RESERVED_USERNAME } from '../../users/users.constants';
import { ProfileSetupDto } from './profile-setup.dto';

/** Runs the same transform + validation as the global ValidationPipe. */
function parse(body: Record<string, unknown>): { dto: ProfileSetupDto; errors: string[] } {
  const dto = plainToInstance(ProfileSetupDto, body);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );
  return { dto, errors };
}

describe('ProfileSetupDto', () => {
  it('normalises the fields like sign-up does', () => {
    const { dto, errors } = parse({ username: '  Alice ', displayName: '  Alice Smith ' });

    expect(errors).toEqual([]);
    expect(dto).toEqual({ username: 'alice', displayName: 'Alice Smith' });
  });

  it.each(['welcome', 'privacy', 'Settings'])('rejects the reserved username %s', (username) => {
    expect(parse({ username, displayName: 'Alice' }).errors).toContain(RESERVED_USERNAME);
  });

  it.each([
    ['a short username', { username: 'ab' }],
    ['invalid characters', { username: 'alice-smith' }],
    ['an empty display name', { displayName: '   ' }],
    ['a display name over the limit', { displayName: 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) }],
  ])('rejects %s', (_label, override) => {
    expect(parse({ username: 'alice', displayName: 'Alice', ...override }).errors).not.toEqual([]);
  });

  it('accepts a display name of exactly the limit', () => {
    const displayName = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH);

    expect(parse({ username: 'alice', displayName }).errors).toEqual([]);
  });

  it.each(['email', 'password'])('rejects the sign-up field %s', (field) => {
    expect(parse({ username: 'alice', displayName: 'Alice', [field]: 'x' }).errors).toEqual([
      `property ${field} should not exist`,
    ]);
  });
});
