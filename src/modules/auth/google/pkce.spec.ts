import { generatePkcePair, generateState, statesMatch, toCodeChallenge } from './pkce';

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

describe('PKCE and state', () => {
  it('computes the S256 challenge of the RFC 7636 Appendix B example', () => {
    expect(toCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates a 43-character verifier whose challenge matches it', () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();

    expect(codeVerifier).toMatch(BASE64URL_43);
    expect(codeChallenge).toBe(toCodeChallenge(codeVerifier));
  });

  it('generates a different 43-character state every time', () => {
    const first = generateState();

    expect(first).toMatch(BASE64URL_43);
    expect(generateState()).not.toBe(first);
  });

  describe('statesMatch', () => {
    const state = generateState();

    it('accepts the identical state', () => {
      expect(statesMatch(state, state)).toBe(true);
    });

    it('rejects a state that differs in one character', () => {
      const tampered = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;

      expect(statesMatch(tampered, state)).toBe(false);
    });

    it.each(['', 'short', `${state}x`])('rejects a state of another length: %p', (received) => {
      expect(statesMatch(received, state)).toBe(false);
    });
  });
});
