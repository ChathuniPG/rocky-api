import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_COMMENT_LENGTH } from '../posts.constants';
import { CreateCommentDto } from './create-comment.dto';

/** Runs the same transform + validation as the global ValidationPipe. */
function parse(body: Record<string, unknown>): { dto: CreateCommentDto; errors: string[] } {
  const dto = plainToInstance(CreateCommentDto, body);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );
  return { dto, errors };
}

describe('CreateCommentDto', () => {
  it('trims the body', () => {
    const { dto, errors } = parse({ body: '  Nice  ' });

    expect(errors).toEqual([]);
    expect(dto.body).toBe('Nice');
  });

  it('accepts exactly 500 characters, measured after trimming', () => {
    expect(parse({ body: ` ${'a'.repeat(MAX_COMMENT_LENGTH)} ` }).errors).toEqual([]);
  });

  it('accepts a single character', () => {
    expect(parse({ body: 'a' }).errors).toEqual([]);
  });

  it.each([
    ['an empty body', { body: '' }],
    ['a whitespace-only body', { body: ' \n\t ' }],
    ['a body over 500 characters', { body: 'a'.repeat(MAX_COMMENT_LENGTH + 1) }],
    ['a missing body', {}],
    ['a non-string body', { body: 42 }],
    ['unknown fields', { body: 'hi', authorId: 'x' }],
  ])('rejects %s', (_name, body) => {
    expect(parse(body).errors).not.toEqual([]);
  });
});
