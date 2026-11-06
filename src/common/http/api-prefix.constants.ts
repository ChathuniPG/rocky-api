/**
 * Global route prefix for every endpoint (design.md §5.1). In its own file so that both
 * app.setup.ts and shared code such as the cookie constants can import it without a
 * circular import.
 */
export const API_PREFIX = 'api/v1';
