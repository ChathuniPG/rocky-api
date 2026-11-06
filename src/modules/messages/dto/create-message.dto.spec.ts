import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_MESSAGE_LENGTH } from '../messages.constants';
import { CreateMessageDto } from './create-message.dto';

/** Runs the same transform + validation as the global ValidationPipe. */
function parse(body: Record<string, unknown>): { dto: CreateMessageDto; errors: string[] } {
  const dto = plainToInstance(CreateMessageDto, body);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );
  return { dto, errors };
}

describe('CreateMessageDto', () => {
  it('trims the body', () => {
    const { dto, errors } = parse({ body: '  Hello  ' });

    expect(errors).toEqual([]);
    expect(dto.body).toBe('Hello');
  });

  it('accepts exactly 1000 characters, measured after trimming', () => {
    expect(parse({ body: ` ${'a'.repeat(MAX_MESSAGE_LENGTH)} ` }).errors).toEqual([]);
  });

  it('accepts a single character', () => {
    expect(parse({ body: 'a' }).errors).toEqual([]);
  });

  it.each([
    ['an empty body', { body: '' }],
    ['a whitespace-only body', { body: ' \n\t ' }],
    ['a body over 1000 characters', { body: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) }],
    ['a missing body', {}],
    ['a non-string body', { body: 42 }],
    ['unknown fields', { body: 'hi', senderId: 'x' }],
  ])('rejects %s', (_name, body) => {
    expect(parse(body).errors).not.toEqual([]);
  });
});
