import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PaginationQueryDto } from './pagination-query.dto';

/** Runs the same transform + validation as the global ValidationPipe. */
function parse(query: Record<string, unknown>): {
  dto: PaginationQueryDto;
  errors: string[];
} {
  const dto = plainToInstance(PaginationQueryDto, query);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );
  return { dto, errors };
}

describe('PaginationQueryDto', () => {
  it('defaults the limit to 15 and the cursor to undefined', () => {
    const { dto, errors } = parse({});

    expect(errors).toEqual([]);
    expect(dto.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(dto.cursor).toBeUndefined();
  });

  it.each(['1', '15', String(MAX_PAGE_SIZE)])('accepts limit=%s as a number', (limit) => {
    const { dto, errors } = parse({ limit });

    expect(errors).toEqual([]);
    expect(dto.limit).toBe(Number(limit));
  });

  it.each(['0', '-1', String(MAX_PAGE_SIZE + 1), 'abc', '1.5', ''])('rejects limit=%s', (limit) => {
    expect(parse({ limit }).errors).not.toEqual([]);
  });

  it('rejects a repeated limit parameter', () => {
    expect(parse({ limit: ['1', '2'] }).errors).not.toEqual([]);
  });

  it('rejects a cursor that is not a string or is too long', () => {
    expect(parse({ cursor: ['a', 'b'] }).errors).not.toEqual([]);
    expect(parse({ cursor: 'a'.repeat(201) }).errors).not.toEqual([]);
  });

  it('rejects unknown parameters', () => {
    expect(parse({ page: '2' }).errors).not.toEqual([]);
  });
});
