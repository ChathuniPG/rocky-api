/**
 * Escapes user input for a Prisma `contains` / `startsWith` / `endsWith` filter on
 * PostgreSQL. Prisma wraps the value in `%...%` and sends it to LIKE / ILIKE without
 * escaping, so `%` and `_` in the input would act as wildcards: a search for "_" would
 * match every name (test/users.e2e-spec.ts proves this against the real database).
 *
 * The backslash is PostgreSQL's default LIKE escape character, so it is escaped first,
 * then `%` and `_`.
 *
 * @param input - Raw text typed by the user.
 * @returns The text with `\`, `%` and `_` preceded by a backslash.
 * @example escapeLikePattern('50%_off') === '50\\%\\_off'
 */
export function escapeLikePattern(input: string): string {
  return input.replaceAll(/[\\%_]/g, (character) => `\\${character}`);
}
