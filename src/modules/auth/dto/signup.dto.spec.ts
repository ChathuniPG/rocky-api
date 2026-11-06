import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RESERVED_USERNAME, RESERVED_USERNAMES } from '../../users/users.constants';
import { SignupDto } from './signup.dto';

const VALID = {
  email: 'alice@example.com',
  password: 'secret123',
  username: 'alice',
  displayName: 'Alice',
};

/** Runs the same transform + validation as the global ValidationPipe. */
function parse(body: Record<string, unknown>): { dto: SignupDto; errors: string[] } {
  const dto = plainToInstance(SignupDto, body);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );
  return { dto, errors };
}

describe('SignupDto', () => {
  it('accepts a normal username', () => {
    expect(parse(VALID).errors).toEqual([]);
  });

  it('accepts a username that only contains a reserved word', () => {
    expect(parse({ ...VALID, username: 'search_me' }).errors).toEqual([]);
  });

  // "me" is also shorter than the 3-character minimum; it is reserved anyway, so the rule
  // still holds if the minimum ever changes.
  it.each(['me', 'search', 'admin', 'api', 'settings'])(
    'rejects the reserved username %s',
    (username) => {
      expect(parse({ ...VALID, username }).errors).toContain(RESERVED_USERNAME);
    },
  );

  it('rejects a reserved username in any case or with surrounding spaces', () => {
    const { dto, errors } = parse({ ...VALID, username: '  Admin ' });

    expect(dto.username).toBe('admin');
    expect(errors).toEqual([RESERVED_USERNAME]);
  });

  it('only reserves lowercase names that the username pattern allows', () => {
    for (const username of RESERVED_USERNAMES) {
      expect(username).toMatch(/^[a-z0-9_.]+$/);
    }
  });
});
