import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type App, cert, initializeApp } from 'firebase-admin/app';
import type { EnvironmentVariables } from '../config/env.validation';
import { FIREBASE_APP, FIREBASE_APP_NAME } from './firebase.constants';
import { loadServiceAccount } from './service-account';

/**
 * Validates the service account file and initialises the Admin SDK app.
 *
 * @param config - Validated configuration.
 * @returns The initialised Firebase Admin app.
 * @throws {ServiceAccountConfigError} If the key file is missing or invalid, which stops
 *   the application at startup (fail fast).
 */
export function createFirebaseApp(config: ConfigService<EnvironmentVariables, true>): App {
  const projectId = config.get('FIREBASE_PROJECT_ID', { infer: true });
  const serviceAccount = loadServiceAccount(
    config.get('FIREBASE_SERVICE_ACCOUNT_PATH', { infer: true }),
    projectId,
  );

  // cert() only parses the key; no network call is made until the first Firebase request.
  const app = initializeApp(
    {
      credential: cert(serviceAccount),
      projectId,
      storageBucket: config.get('FIREBASE_STORAGE_BUCKET', { infer: true }),
    },
    FIREBASE_APP_NAME,
  );

  // Logs the project only: never the key file contents or the private key (NFR-SEC-04).
  new Logger('FirebaseModule').log(`Firebase Admin SDK initialised for project ${projectId}`);
  return app;
}

/**
 * Provides the single Admin SDK app under the `FIREBASE_APP` token. Nest creates
 * providers once, so the SDK is initialised exactly once per application (comparable to
 * a Spring `@Bean` factory method).
 */
export const firebaseAppProvider: Provider<App> = {
  provide: FIREBASE_APP,
  inject: [ConfigService],
  useFactory: createFirebaseApp,
};
