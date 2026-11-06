import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_SEARCH_QUERY_LENGTH } from '../users.constants';
import { SearchUsersQueryDto } from './search-users-query.dto';

/** Runs the same transform + validation as the global ValidationPipe. */
function parse(query: Record<string, unknown>): { dto: SearchUsersQueryDto; errors: string[] } {
  const dto = plainToInstance(SearchUsersQueryDto, query);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );
  return { dto, errors };
}

describe('SearchUsersQueryDto', () => {
  it('trims q and defaults filter and limit', () => {
    const { dto, errors } = parse({ q: '  ali ' });

    expect(errors).toEqual([]);
    expect(dto).toMatchObject({ q: 'ali', filter: 'all', limit: 15 });
  });

  it.each([
    ['filter=following', { q: 'a', filter: 'following' }],
    ['a 50-character q', { q: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH) }],
    ['wildcard characters', { q: '%_' }],
  ])('accepts %s', (_name, query) => {
    expect(parse(query).errors).toEqual([]);
  });

  it.each([
    ['a missing q', {}],
    ['an empty q', { q: '' }],
    ['a whitespace-only q', { q: '   ' }],
    ['a 51-character q', { q: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) }],
    ['an unknown filter', { q: 'a', filter: 'followers' }],
    ['an unknown parameter', { q: 'a', sort: 'name' }],
  ])('rejects %s', (_name, query) => {
    expect(parse(query).errors).not.toEqual([]);
  });
});
