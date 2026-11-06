import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_BIO_LENGTH, MAX_DISPLAY_NAME_LENGTH } from '../users.constants';
import { UpdateProfileDto } from './update-profile.dto';

/** Runs the same transform + validation as the global ValidationPipe. */
function parse(body: Record<string, unknown>): { dto: UpdateProfileDto; errors: string[] } {
  const dto = plainToInstance(UpdateProfileDto, body);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );
  return { dto, errors };
}

describe('UpdateProfileDto', () => {
  it('accepts every field together', () => {
    const { errors } = parse({
      displayName: 'Alice',
      bio: 'Hi',
      avatarPath: 'avatars/x/y.png',
      notificationsEnabled: false,
      language: 'si',
    });

    expect(errors).toEqual([]);
  });

  it('accepts an empty body (the service rejects it, with a clearer message)', () => {
    expect(parse({}).errors).toEqual([]);
  });

  it('trims displayName and bio', () => {
    const { dto } = parse({ displayName: '  Alice ', bio: '  Hi  ' });

    expect(dto.displayName).toBe('Alice');
    expect(dto.bio).toBe('Hi');
  });

  it.each([
    ['an empty bio', { bio: '' }],
    ['a whitespace-only bio', { bio: '   ' }],
    ['a null bio', { bio: null }],
    ['a null avatarPath', { avatarPath: null }],
    ['a 50-character displayName', { displayName: 'a'.repeat(MAX_DISPLAY_NAME_LENGTH) }],
    ['a 160-character bio', { bio: 'a'.repeat(MAX_BIO_LENGTH) }],
    ['language en', { language: 'en' }],
  ])('accepts %s', (_name, body) => {
    expect(parse(body).errors).toEqual([]);
  });

  it.each([
    ['an empty displayName', { displayName: '' }],
    ['a whitespace-only displayName', { displayName: '   ' }],
    ['a null displayName', { displayName: null }],
    ['a 51-character displayName', { displayName: 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) }],
    ['a 161-character bio', { bio: 'a'.repeat(MAX_BIO_LENGTH + 1) }],
    ['a numeric bio', { bio: 5 }],
    ['a non-string avatarPath', { avatarPath: 5 }],
    ['a string notificationsEnabled', { notificationsEnabled: 'false' }],
    ['a null notificationsEnabled', { notificationsEnabled: null }],
    ['an unsupported language', { language: 'fr' }],
    ['a null language', { language: null }],
    ['a field that cannot be changed', { username: 'bob' }],
    ['a client-supplied avatar URL', { avatarUrl: 'https://evil.example/x.png' }],
  ])('rejects %s', (_name, body) => {
    expect(parse(body).errors).not.toEqual([]);
  });
});
