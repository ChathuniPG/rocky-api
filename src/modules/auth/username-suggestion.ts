import { randomInt } from 'node:crypto';
import { RESERVED_USERNAMES } from '../users/users.constants';

/**
 * Returns a random integer in [0, maxExclusive). Injectable so tests are deterministic;
 * the default is `crypto.randomInt`.
 */
export type RandomInt = (maxExclusive: number) => number;

/** Longest base, leaving room for a 4-digit suffix within the 30-character limit. */
const MAX_BASE_LENGTH = 24;
const MIN_USERNAME_LENGTH = 3;
const FALLBACK_BASE = 'user';
const SUFFIXED_CANDIDATES = 5;

/**
 * Builds the usernames to offer a new Google user (issue #42, FR-AUTH-10), best first:
 * the base derived from the email's local part (or the display name), the base with five
 * random 4-digit suffixes, and finally `user` plus 8 random hex digits. Every candidate
 * matches the username pattern and none is reserved. Availability is checked by the caller
 * with one database query.
 *
 * @param email - The account email; its local part is the preferred source.
 * @param displayName - Used when the local part yields nothing usable.
 * @param random - Source of randomness for the suffixes.
 * @returns Distinct, valid candidates; never empty.
 */
export function buildUsernameCandidates(
  email: string,
  displayName: string | undefined,
  random: RandomInt = randomInt,
): string[] {
  const base = usernameBase(email, displayName);
  const suffixed = Array.from(
    { length: SUFFIXED_CANDIDATES },
    () => `${base}${String(random(10_000)).padStart(4, '0')}`,
  );
  const fallback = `${FALLBACK_BASE}${random(0x1_0000_0000).toString(16).padStart(8, '0')}`;

  const reserved = new Set(RESERVED_USERNAMES);
  return [...new Set([base, ...suffixed, fallback])].filter((name) => !reserved.has(name));
}

/**
 * The base username: the email's local part normalised to the allowed characters, or the
 * display name if that leaves nothing, or `user`. Short bases are extended with `user`
 * so they meet the 3-character minimum.
 */
function usernameBase(email: string, displayName: string | undefined): string {
  const localPart = email.slice(0, Math.max(email.lastIndexOf('@'), 0));
  const base = normalise(localPart) || normalise(displayName ?? '') || FALLBACK_BASE;
  return base.length < MIN_USERNAME_LENGTH ? `${base}${FALLBACK_BASE}` : base;
}

/**
 * Lowercases, turns accented letters into their plain form ("José" becomes "jose") and
 * drops every character the username pattern does not allow.
 */
function normalise(value: string): string {
  return value
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.]/g, '')
    .slice(0, MAX_BASE_LENGTH);
}
