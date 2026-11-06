import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation';
import {
  FIREBASE_REST_TIMEOUT_MS,
  FirebaseAuthRestClient,
  REFRESH_TOKEN_URL,
  SIGN_IN_WITH_PASSWORD_URL,
} from './firebase-auth-rest.client';
import {
  FirebaseDomainError,
  FirebaseUnavailableError,
  InvalidCredentialsError,
  InvalidTokenError,
  TokenExpiredError,
  TooManyAttemptsError,
  UserDisabledError,
} from './firebase.errors';

// All values are fake; fetch is mocked, so no request leaves the process.
const API_KEY = 'AIzaFakeKeyForUnitTests0000000000000000';
const EMAIL = 'rocky@example.com';
const PASSWORD = 'Sup3r-secret-pw!';
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-id-token.fake-signature';
const REFRESH_TOKEN = 'AMf-vBfake-refresh-token-value';
const UID = 'firebase-uid-123';

const signInBody = {
  kind: 'identitytoolkit#VerifyPasswordResponse',
  localId: UID,
  email: EMAIL,
  idToken: ID_TOKEN,
  refreshToken: REFRESH_TOKEN,
  expiresIn: '3600',
  registered: true,
};

const refreshBody = {
  expires_in: '3600',
  token_type: 'Bearer',
  refresh_token: `${REFRESH_TOKEN}-rotated`,
  id_token: `${ID_TOKEN}-refreshed`,
  user_id: UID,
  project_id: '123456789012',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A Firebase REST error body, as documented: the code is in `error.message`. */
function errorResponse(message: string, status = 400): Response {
  return jsonResponse(
    {
      error: { code: status, message, errors: [{ message, domain: 'global', reason: 'invalid' }] },
    },
    status,
  );
}

function createClient(): FirebaseAuthRestClient {
  return new FirebaseAuthRestClient(
    new ConfigService<EnvironmentVariables, true>({ FIREBASE_WEB_API_KEY: API_KEY }),
  );
}

/** Awaits `promise` and returns its rejection narrowed to `type`. */
async function rejectionOf<T extends Error>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof type) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the promise to reject');
}

describe('FirebaseAuthRestClient', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let errorLogSpy: jest.SpyInstance;
  let client: FirebaseAuthRestClient;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    errorLogSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    client = createClient();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The `RequestInit` of the only fetch call. */
  function sentRequest(): RequestInit {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    if (init === undefined) {
      throw new Error('fetch was called without options');
    }
    return init;
  }

  /** The body of the only fetch call; the client always sends a string. */
  function sentBody(): string {
    const { body } = sentRequest();
    if (typeof body !== 'string') {
      throw new Error('expected a string request body');
    }
    return body;
  }

  describe('signInWithPassword', () => {
    it('posts the credentials as JSON with the API key in a header, not the URL', async () => {
      fetchMock.mockResolvedValue(jsonResponse(signInBody));

      await client.signInWithPassword(EMAIL, PASSWORD);

      // Exact match: the URL carries no ?key= parameter.
      expect(fetchMock.mock.calls[0][0]).toBe(SIGN_IN_WITH_PASSWORD_URL);
      const init = sentRequest();
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        'content-type': 'application/json',
        'x-goog-api-key': API_KEY,
      });
      expect(JSON.parse(sentBody())).toEqual({
        email: EMAIL,
        password: PASSWORD,
        returnSecureToken: true,
      });
    });

    it('returns a normalised session', async () => {
      fetchMock.mockResolvedValue(jsonResponse(signInBody));

      await expect(client.signInWithPassword(EMAIL, PASSWORD)).resolves.toEqual({
        uid: UID,
        idToken: ID_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresInSeconds: 3600,
      });
    });

    it.each([
      ['INVALID_LOGIN_CREDENTIALS', InvalidCredentialsError],
      ['EMAIL_NOT_FOUND', InvalidCredentialsError],
      ['INVALID_PASSWORD', InvalidCredentialsError],
      ['INVALID_EMAIL', InvalidCredentialsError],
      ['USER_DISABLED', UserDisabledError],
      ['TOO_MANY_ATTEMPTS_TRY_LATER', TooManyAttemptsError],
      [
        'TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled due to many failed login attempts.',
        TooManyAttemptsError,
      ],
    ])('maps %p to %p without logging', async (message, expected) => {
      fetchMock.mockResolvedValue(errorResponse(message));

      await expect(client.signInWithPassword(EMAIL, PASSWORD)).rejects.toBeInstanceOf(expected);
      expect(errorLogSpy).not.toHaveBeenCalled();
    });

    it('gives the same error for a wrong password and an unknown email (no enumeration)', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse('INVALID_PASSWORD'));
      fetchMock.mockResolvedValueOnce(errorResponse('EMAIL_NOT_FOUND'));

      const wrongPassword = await rejectionOf(
        client.signInWithPassword(EMAIL, PASSWORD),
        InvalidCredentialsError,
      );
      const unknownEmail = await rejectionOf(
        client.signInWithPassword(EMAIL, PASSWORD),
        InvalidCredentialsError,
      );

      expect(wrongPassword.message).toBe(unknownEmail.message);
    });
  });

  describe('refreshIdToken', () => {
    it('posts a form-encoded refresh_token grant with the API key in a header', async () => {
      fetchMock.mockResolvedValue(jsonResponse(refreshBody));

      await client.refreshIdToken(REFRESH_TOKEN);

      expect(fetchMock.mock.calls[0][0]).toBe(REFRESH_TOKEN_URL);
      const init = sentRequest();
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        'content-type': 'application/x-www-form-urlencoded',
        'x-goog-api-key': API_KEY,
      });
      const form = new URLSearchParams(sentBody());
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'refresh_token',
        refresh_token: REFRESH_TOKEN,
      });
    });

    it('normalises the snake_case response', async () => {
      fetchMock.mockResolvedValue(jsonResponse(refreshBody));

      await expect(client.refreshIdToken(REFRESH_TOKEN)).resolves.toEqual({
        uid: UID,
        idToken: `${ID_TOKEN}-refreshed`,
        refreshToken: `${REFRESH_TOKEN}-rotated`,
        expiresInSeconds: 3600,
      });
    });

    it.each([
      ['TOKEN_EXPIRED', TokenExpiredError],
      ['USER_DISABLED', UserDisabledError],
      ['USER_NOT_FOUND', InvalidTokenError],
      ['INVALID_REFRESH_TOKEN', InvalidTokenError],
      ['MISSING_REFRESH_TOKEN', InvalidTokenError],
      ['INVALID_GRANT_TYPE', InvalidTokenError],
      ['TOO_MANY_ATTEMPTS_TRY_LATER', TooManyAttemptsError],
    ])('maps %p to %p', async (message, expected) => {
      fetchMock.mockResolvedValue(errorResponse(message));

      await expect(client.refreshIdToken(REFRESH_TOKEN)).rejects.toBeInstanceOf(expected);
    });
  });

  describe('failures', () => {
    it('applies a request timeout to every call', async () => {
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValue(jsonResponse(signInBody));

      await client.signInWithPassword(EMAIL, PASSWORD);

      expect(FIREBASE_REST_TIMEOUT_MS).toBe(10_000);
      expect(timeoutSpy).toHaveBeenCalledWith(FIREBASE_REST_TIMEOUT_MS);
      expect(sentRequest().signal).toBe(timeoutSpy.mock.results[0].value);
    });

    it('maps a timeout to FirebaseUnavailableError', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

      await expect(client.refreshIdToken(REFRESH_TOKEN)).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
      expect(errorLogSpy).toHaveBeenCalledWith(
        'Firebase refreshIdToken request failed: timed out after 10000 ms',
      );
    });

    it('maps a network error to FirebaseUnavailableError and keeps the cause', async () => {
      const networkError = new TypeError('fetch failed');
      fetchMock.mockRejectedValue(networkError);

      const error = await rejectionOf(
        client.signInWithPassword(EMAIL, PASSWORD),
        FirebaseUnavailableError,
      );

      expect(error.cause).toBe(networkError);
      expect(errorLogSpy).toHaveBeenCalledWith(
        'Firebase signInWithPassword request failed: network error',
      );
    });

    it('maps an unknown error code to FirebaseUnavailableError and logs the code', async () => {
      fetchMock.mockResolvedValue(errorResponse('OPERATION_NOT_ALLOWED'));

      await expect(client.signInWithPassword(EMAIL, PASSWORD)).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
      expect(errorLogSpy).toHaveBeenCalledWith(
        'Firebase signInWithPassword failed with unexpected error code: OPERATION_NOT_ALLOWED',
      );
    });

    it('does not log free-text error messages, which could contain user input', async () => {
      fetchMock.mockResolvedValue(errorResponse(`Invalid value at 'email' (${EMAIL})`));

      await expect(client.signInWithPassword(EMAIL, PASSWORD)).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
      expect(errorLogSpy).toHaveBeenCalledWith(
        'Firebase signInWithPassword failed with unexpected error code: none',
      );
    });

    it('maps a non-JSON error response to FirebaseUnavailableError', async () => {
      fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));

      await expect(client.refreshIdToken(REFRESH_TOKEN)).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
    });

    it.each([
      ['not JSON', new Response('not json', { status: 200 })],
      ['a JSON array', jsonResponse([])],
      ['missing idToken', jsonResponse({ ...signInBody, idToken: undefined })],
      ['an empty localId', jsonResponse({ ...signInBody, localId: '' })],
      ['a non-numeric expiresIn', jsonResponse({ ...signInBody, expiresIn: 'soon' })],
      ['a zero expiresIn', jsonResponse({ ...signInBody, expiresIn: '0' })],
    ])('rejects a success response that is %s', async (_label, response) => {
      fetchMock.mockResolvedValue(response);

      await expect(client.signInWithPassword(EMAIL, PASSWORD)).rejects.toBeInstanceOf(
        FirebaseUnavailableError,
      );
    });
  });

  it('never puts tokens, the password or the API key in errors or logs', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse('INVALID_LOGIN_CREDENTIALS'));
    fetchMock.mockResolvedValueOnce(errorResponse('SOMETHING_UNEXPECTED'));
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const errors = [
      await rejectionOf(client.signInWithPassword(EMAIL, PASSWORD), FirebaseDomainError),
      await rejectionOf(client.refreshIdToken(REFRESH_TOKEN), FirebaseDomainError),
      await rejectionOf(client.refreshIdToken(REFRESH_TOKEN), FirebaseDomainError),
    ];

    const secrets = [PASSWORD, REFRESH_TOKEN, API_KEY, EMAIL];
    const logged = JSON.stringify(errorLogSpy.mock.calls);
    for (const secret of secrets) {
      expect(logged).not.toContain(secret);
      for (const error of errors) {
        expect(error.message).not.toContain(secret);
        expect(String(error.cause)).not.toContain(secret);
      }
    }
  });
});
