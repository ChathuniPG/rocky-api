import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { FirebaseAuthService } from './firebase-auth.service';
import { FirebaseStorageService } from './firebase-storage.service';
import { FIREBASE_APP, FIREBASE_APP_NAME } from './firebase.constants';
import { FirebaseModule } from './firebase.module';
import { ServiceAccountConfigError } from './service-account';

// The SDK is stubbed: these tests check how the module initialises it, not Firebase.
const mockApp = { name: 'rocky-api' };

jest.mock('firebase-admin/app', () => ({
  cert: jest.fn(() => ({ stub: 'credential' })),
  initializeApp: jest.fn(() => mockApp),
  deleteApp: jest.fn(() => Promise.resolve()),
}));
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn(() => ({})) }));
jest.mock('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({ bucket: jest.fn(() => ({})) })),
}));

const PROJECT_ID = 'rocky-test-1234';
const BUCKET = 'rocky-test-1234.firebasestorage.app';
const FAKE_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nFAKE-KEY-MATERIAL\n-----END PRIVATE KEY-----\n';
const CLIENT_EMAIL = `firebase-adminsdk-test@${PROJECT_ID}.iam.gserviceaccount.com`;

describe('FirebaseModule', () => {
  let dir: string;
  let keyPath: string;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'rocky-firebase-'));
    keyPath = join(dir, 'service-account.json');
    writeFileSync(
      keyPath,
      JSON.stringify({
        type: 'service_account',
        project_id: PROJECT_ID,
        private_key: FAKE_PRIVATE_KEY,
        client_email: CLIENT_EMAIL,
      }),
    );
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Compiles FirebaseModule with a fixed configuration (no .env file is read). */
  function compile(overrides: Record<string, string> = {}) {
    const config = {
      FIREBASE_SERVICE_ACCOUNT_PATH: keyPath,
      FIREBASE_PROJECT_ID: PROJECT_ID,
      FIREBASE_STORAGE_BUCKET: BUCKET,
      ...overrides,
    };
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => config] }),
        FirebaseModule,
      ],
    }).compile();
  }

  it('initialises one named Admin SDK app from the validated service account', async () => {
    const moduleRef = await compile();

    expect(cert).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      clientEmail: CLIENT_EMAIL,
      privateKey: FAKE_PRIVATE_KEY,
    });
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(initializeApp).toHaveBeenCalledWith(
      { credential: { stub: 'credential' }, projectId: PROJECT_ID, storageBucket: BUCKET },
      FIREBASE_APP_NAME,
    );
    expect(moduleRef.get(FIREBASE_APP)).toBe(mockApp);
  });

  it('provides the auth and storage services', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(FirebaseAuthService)).toBeInstanceOf(FirebaseAuthService);
    expect(moduleRef.get(FirebaseStorageService)).toBeInstanceOf(FirebaseStorageService);
  });

  it('fails fast when the service account does not match FIREBASE_PROJECT_ID', async () => {
    await expect(compile({ FIREBASE_PROJECT_ID: 'another-project-99' })).rejects.toThrow(
      ServiceAccountConfigError,
    );
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('fails fast when the service account file is missing', async () => {
    await expect(
      compile({ FIREBASE_SERVICE_ACCOUNT_PATH: join(dir, 'missing.json') }),
    ).rejects.toThrow(/cannot be read \(ENOENT\)/);
  });

  it('deletes the app on application shutdown', async () => {
    const moduleRef = await compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    await app.close();

    expect(deleteApp).toHaveBeenCalledWith(mockApp);
  });

  it('logs the project ID but never the private key', async () => {
    await compile();

    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).toContain(PROJECT_ID);
    expect(logged).not.toContain('FAKE-KEY-MATERIAL');
  });
});
