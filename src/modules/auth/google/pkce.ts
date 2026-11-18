import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bytes of randomness in the OAuth `state` and the PKCE code verifier: 32 bytes = 256 bits,
 * 43 base64url characters, within RFC 7636's 43-128 character range for the verifier.
 */
const RANDOM_BYTES = 32;

/** PKCE values for one authorization request (RFC 7636). */
export interface PkcePair {
  /** Secret kept by the server (in rocky_oauth) and sent only to Google's token endpoint. */
  codeVerifier: string;
  /** BASE64URL(SHA-256(codeVerifier)), sent in the authorization URL. */
  codeChallenge: string;
}

/**
 * Generates a random OAuth `state` (CSRF protection for the callback, ADR-015).
 *
 * @returns 43 base64url characters from a cryptographically secure source.
 */
export function generateState(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url');
}

/**
 * Generates a PKCE code verifier and its S256 challenge. PKCE ties the authorization code
 * to this server's sign-in attempt, so a code stolen from the redirect URL is useless.
 *
 * @returns The verifier and its challenge.
 */
export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(RANDOM_BYTES).toString('base64url');
  return { codeVerifier, codeChallenge: toCodeChallenge(codeVerifier) };
}

/**
 * Computes the S256 code challenge of a verifier (RFC 7636 §4.2).
 *
 * @param codeVerifier - The PKCE code verifier.
 * @returns BASE64URL-ENCODE(SHA256(ASCII(codeVerifier))), without padding.
 */
export function toCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/**
 * Compares the state returned by Google with the one stored in rocky_oauth in constant
 * time, so response timing reveals nothing about the expected value.
 *
 * @param received - The `state` query parameter of the callback.
 * @param expected - The state saved when the sign-in started.
 * @returns `true` only if both are identical.
 */
export function statesMatch(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on different lengths; the length of a random state is no secret.
  if (receivedBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(receivedBytes, expectedBytes);
}
