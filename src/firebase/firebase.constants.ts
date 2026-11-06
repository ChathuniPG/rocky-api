/**
 * Injection token for the initialised Firebase Admin `App`. A token is needed because
 * `App` is an interface, which does not exist at runtime and cannot be used as a
 * Nest provider key.
 */
export const FIREBASE_APP = Symbol('FIREBASE_APP');

/**
 * Name of the Admin SDK app this API creates. A named app (instead of the SDK's global
 * default app) cannot collide with other code or tests that initialise Firebase.
 */
export const FIREBASE_APP_NAME = 'rocky-api';
